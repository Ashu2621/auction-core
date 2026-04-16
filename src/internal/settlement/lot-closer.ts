import { PoolClient } from 'pg';
import { pool } from '../../db/pool';
import { redis } from '../../redis/client';
import { config } from '../../config';
import { LotRow, InvoiceRow } from '../../types';
import { lotCloserIterationsTotal, settlementInvoicesTotal } from '../../metrics';

let closerInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let currentIterationPromise: Promise<void> | null = null;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function startLotCloser(): void {
  if (closerInterval) return;
  console.log('[lot-closer] Starting (interval: 5s)');
  closerInterval = setInterval(() => {
    if (!isRunning) {
      currentIterationPromise = runLotCloserCycle().catch((err) => {
        console.error('[lot-closer] Cycle error:', err);
      });
    }
  }, config.lotCloserIntervalMs);
}

export function stopLotCloser(): void {
  if (closerInterval) {
    clearInterval(closerInterval);
    closerInterval = null;
    console.log('[lot-closer] Stopped');
  }
}

/** Wait for the in-progress iteration to complete (used in graceful shutdown). */
export async function waitForCurrentIteration(): Promise<void> {
  if (currentIterationPromise) {
    await currentIterationPromise;
  }
}

// ── Core Logic ────────────────────────────────────────────────────────────────

/**
 * One iteration of the lot-closer job.
 *
 * Finds lots in 'closing' status whose closing_at has passed, then
 * determines whether they sold (reserve met) or passed (reserve not met).
 *
 * Uses SELECT FOR UPDATE SKIP LOCKED so that multiple instances of the
 * service never double-close the same lot.
 */
export async function runLotCloserCycle(): Promise<void> {
  isRunning = true;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Find up to 20 closing lots that have passed their deadline.
      // SKIP LOCKED means other job instances skip lots we're processing.
      const { rows: lots } = await client.query<LotRow & { auction_house_buyer_premium_pct: string; auction_id_ref: string }>(
        `SELECT l.*,
                ah.buyer_premium_pct AS auction_house_buyer_premium_pct,
                a.id AS auction_id_ref
         FROM lots l
         JOIN auctions a ON a.id = l.auction_id
         JOIN auction_houses ah ON ah.id = a.auction_house_id
         WHERE l.status = 'closing'
           AND l.closing_at <= NOW()
         LIMIT 20
         FOR UPDATE OF l SKIP LOCKED`
      );

      if (lots.length === 0) {
        await client.query('ROLLBACK');
        lotCloserIterationsTotal.inc({ outcome: 'skipped' });
        return;
      }

      console.log(`[lot-closer] Processing ${lots.length} closing lot(s)`);

      const closedLots: Array<{
        lotId: string;
        auctionId: string;
        status: 'sold' | 'passed';
        soldPrice?: number;
      }> = [];

      for (const lot of lots) {
        await closeLot(client, lot, closedLots);
      }

      await client.query('COMMIT');

      lotCloserIterationsTotal.inc({ outcome: 'processed' });

      // Publish WebSocket events after commit (best-effort)
      for (const closed of closedLots) {
        const msg = JSON.stringify({
          type: 'LOT_CLOSED',
          lot_id: closed.lotId,
          status: closed.status,
          sold_price: closed.soldPrice,
        });
        redis.publish(`auction:${closed.auctionId}`, msg).catch(() => {});
      }
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  } finally {
    isRunning = false;
  }
}

async function closeLot(
  client: PoolClient,
  lot: LotRow & { auction_house_buyer_premium_pct: string; auction_id_ref: string },
  closedLots: Array<{ lotId: string; auctionId: string; status: 'sold' | 'passed'; soldPrice?: number }>
): Promise<void> {
  const currentBid = parseInt(lot.current_bid as unknown as string, 10);
  const reservePrice = lot.reserve_price
    ? parseInt(lot.reserve_price as unknown as string, 10)
    : null;

  const reserveMet = reservePrice === null || currentBid >= reservePrice;
  const hasBidder = !!lot.current_winner_id;

  if (hasBidder && reserveMet) {
    // ── Sold ──────────────────────────────────────────────────────────────
    await client.query(
      `UPDATE lots
       SET status = 'sold', sold_at = NOW(), sold_price = $1, version = version + 1
       WHERE id = $2`,
      [currentBid, lot.id]
    );

    await client.query(
      `INSERT INTO auction_events (lot_id, event_type, payload)
       VALUES ($1, 'LOT_SOLD', $2)`,
      [
        lot.id,
        JSON.stringify({
          winner_id: lot.current_winner_id,
          sold_price: currentBid,
          bid_count: lot.bid_count,
        }),
      ]
    );

    // Create invoice in the same transaction
    await createInvoice(client, lot, currentBid);

    closedLots.push({
      lotId: lot.id,
      auctionId: lot.auction_id,
      status: 'sold',
      soldPrice: currentBid,
    });
  } else {
    // ── Passed (no bidder or reserve not met) ─────────────────────────────
    await client.query(
      `UPDATE lots
       SET status = 'passed', version = version + 1
       WHERE id = $1`,
      [lot.id]
    );

    await client.query(
      `INSERT INTO auction_events (lot_id, event_type, payload)
       VALUES ($1, 'LOT_PASSED', $2)`,
      [
        lot.id,
        JSON.stringify({
          current_bid: currentBid,
          reserve_met: reserveMet,
          had_bidder: hasBidder,
        }),
      ]
    );

    closedLots.push({
      lotId: lot.id,
      auctionId: lot.auction_id,
      status: 'passed',
    });
  }
}

/**
 * Create a settlement invoice in the same transaction as lot closure.
 * hammer_price = sold_price
 * buyer_premium = round(hammer_price * buyer_premium_pct)
 * total_due = hammer_price + buyer_premium
 * due_date = TODAY + 7 days
 */
async function createInvoice(
  client: PoolClient,
  lot: LotRow & { auction_house_buyer_premium_pct: string; auction_id_ref: string },
  hammerPrice: number
): Promise<void> {
  const buyerPremiumPct = parseFloat(lot.auction_house_buyer_premium_pct);
  const buyerPremium = Math.round(hammerPrice * buyerPremiumPct);
  const totalDue = hammerPrice + buyerPremium;

  await client.query(
    `INSERT INTO settlement_invoices
       (auction_id, bidder_id, lot_id, hammer_price, buyer_premium, total_due, currency, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '7 days')
     ON CONFLICT (lot_id) DO NOTHING`,
    [
      lot.auction_id,
      lot.current_winner_id,
      lot.id,
      hammerPrice,
      buyerPremium,
      totalDue,
      lot.currency,
    ]
  );

  settlementInvoicesTotal.inc({ status: 'created' });

  console.log(
    `[lot-closer] Invoice created for lot=${lot.id} winner=${lot.current_winner_id} total=${totalDue}`
  );
}
