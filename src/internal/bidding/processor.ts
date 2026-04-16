import { PoolClient } from 'pg';
import { pool } from '../../db/pool';
import { redis } from '../../redis/client';
import {
  BidRequest,
  BidResult,
  BidResponseItem,
  LotSnapshot,
  LotRow,
  BidRow,
  AuctionRow,
  AuctionHouseRow,
  BidError,
} from '../../types';
import { getBidIncrement, getMinimumNextBid } from './increment';
import { acquireLock, releaseLock } from '../idempotency/service';
import {
  bidsTotal,
  bidProcessingDuration,
  antiSnipeTriggersTotal,
  proxyResolutionsTotal,
} from '../../metrics';

// Safety cap on proxy resolution iterations to prevent infinite loops.
// In practice, this terminates long before the cap because each iteration
// increases current_bid by at least one increment.
const MAX_PROXY_ITERATIONS = 50;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Process a single bid submission atomically.
 *
 * Flow (all within one PostgreSQL transaction):
 *   1. Acquire idempotency lock
 *   2. SELECT lot FOR UPDATE (prevents concurrent bid race)
 *   3. Load auction settings (anti-snipe window, proxy allowed flag)
 *   4. Validate: lot status, bidder eligibility, bid amount
 *   5. Insert bid record
 *   6. Mark previous winner's bid as outbid
 *   7. Update lot (current_bid, current_winner_id, bid_count, version)
 *   8. Anti-snipe check: extend closing_at if within window
 *   9. Synchronous proxy resolution loop
 *  10. Append all events to auction_events
 *  11. Release idempotency lock with cached response
 *  12. COMMIT
 *  13. Publish to Redis pub/sub (best-effort, after commit)
 */
export async function processBid(req: BidRequest): Promise<BidResult> {
  const timer = bidProcessingDuration.startTimer();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── 1. Idempotency lock ──────────────────────────────────────────────────
    const idempotencyOutcome = await acquireLock(client, req.idempotencyKey, req.bidderId);

    if (idempotencyOutcome.status === 'cached') {
      await client.query('ROLLBACK');
      timer({ status: 'idempotency_replay' });
      return idempotencyOutcome.responseBody;
    }

    if (idempotencyOutcome.status === 'in_flight') {
      await client.query('ROLLBACK');
      throw new BidError('concurrent_request', 'Another request with this idempotency key is in progress', 409);
    }

    // ── 2. Lock lot row ─────────────────────────────────────────────────────
    const { rows: lotRows } = await client.query<LotRow>(
      `SELECT l.*, a.anti_snipe_window_secs, a.anti_snipe_extension_secs,
              a.allow_proxy_bids, a.require_verification, a.auction_house_id,
              a.id AS auction_row_id
       FROM lots l
       JOIN auctions a ON a.id = l.auction_id
       WHERE l.id = $1
       FOR UPDATE OF l`,
      [req.lotId]
    );

    if (lotRows.length === 0) {
      throw new BidError('lot_not_found', 'Lot not found', 404);
    }

    const lot = lotRows[0] as LotRow & {
      anti_snipe_window_secs: number;
      anti_snipe_extension_secs: number;
      allow_proxy_bids: boolean;
      require_verification: boolean;
      auction_house_id: string;
      auction_row_id: string;
    };

    // ── 3. Validate lot status ───────────────────────────────────────────────
    if (lot.status !== 'open' && lot.status !== 'closing') {
      const code = lot.status === 'sold' || lot.status === 'passed' ? 'lot_closed' : 'lot_not_active';
      throw new BidError(code, `Lot is not accepting bids (status: ${lot.status})`, 409, {
        lot_status: lot.status,
      });
    }

    // ── 4a. Validate bidder registration + eligibility ──────────────────────
    const { rows: regRows } = await client.query(
      `SELECT ar.is_eligible, b.verification_tier
       FROM auction_registrations ar
       JOIN bidders b ON b.id = ar.bidder_id
       WHERE ar.auction_id = $1 AND ar.bidder_id = $2`,
      [lot.auction_id, req.bidderId]
    );

    if (regRows.length === 0) {
      throw new BidError('not_registered', 'Bidder is not registered for this auction', 403);
    }

    const reg = regRows[0] as { is_eligible: boolean; verification_tier: string };

    if (!reg.is_eligible) {
      throw new BidError('rejected_ineligible', 'Bidder is not eligible to bid', 403);
    }

    if (lot.require_verification && reg.verification_tier === 'basic') {
      throw new BidError('rejected_ineligible', 'This auction requires verified bidder status', 403);
    }

    // ── 4b. Validate bid type ────────────────────────────────────────────────
    if (req.bidType === 'proxy' && !lot.allow_proxy_bids) {
      throw new BidError('proxy_not_allowed', 'This auction does not allow proxy bids', 422);
    }

    if (req.bidType === 'proxy' && (!req.maxAmountCents || req.maxAmountCents < req.amountCents)) {
      throw new BidError(
        'invalid_proxy_bid',
        'Proxy bid must include max_amount_cents >= amount_cents',
        422
      );
    }

    // ── 4c. Validate bid amount ──────────────────────────────────────────────
    const currentBid = parseInt(lot.current_bid as unknown as string, 10);
    const minimumNextBid = getMinimumNextBid(currentBid);

    if (req.amountCents < minimumNextBid) {
      throw new BidError('rejected_increment', 'Bid is below minimum increment', 422, {
        minimum: minimumNextBid,
        current_bid: currentBid,
      });
    }

    // ── 5. Insert accepted bid ───────────────────────────────────────────────
    const { rows: bidRows } = await client.query<BidRow>(
      `INSERT INTO bids (lot_id, bidder_id, bid_type, amount, max_amount, status, idempotency_key, processed_at)
       VALUES ($1, $2, $3, $4, $5, 'accepted', $6, NOW())
       RETURNING *`,
      [
        req.lotId,
        req.bidderId,
        req.bidType,
        req.amountCents,
        req.maxAmountCents ?? null,
        req.idempotencyKey,
      ]
    );
    const acceptedBid = bidRows[0];

    // ── 6. Mark previous winner's bid as outbid ──────────────────────────────
    if (lot.current_winner_id && lot.current_winner_id !== req.bidderId) {
      await client.query(
        `UPDATE bids
         SET status = 'outbid', outbid_at = NOW()
         WHERE lot_id = $1 AND bidder_id = $2
           AND status = 'accepted'
           AND bid_type IN ('live', 'auto_increment')`,
        [req.lotId, lot.current_winner_id]
      );
    }

    // Reserve price check (internal flag — never exposed to bidders)
    const reservePrice = lot.reserve_price ? parseInt(lot.reserve_price as unknown as string, 10) : null;
    const reserveMet = reservePrice !== null && req.amountCents >= reservePrice;

    // ── 7. Update lot ────────────────────────────────────────────────────────
    let newCurrentBid = req.amountCents;
    let newCurrentWinnerId = req.bidderId;
    let newBidCount = (lot.bid_count || 0) + 1;

    await client.query(
      `UPDATE lots
       SET current_bid = $1, current_winner_id = $2, bid_count = $3,
           version = version + 1
       WHERE id = $4`,
      [newCurrentBid, newCurrentWinnerId, newBidCount, req.lotId]
    );

    // ── 8. Anti-snipe check ──────────────────────────────────────────────────
    let newClosingAt = lot.closing_at;
    let antiSnipeTriggered = false;

    if (lot.closing_at) {
      const closingAtMs = new Date(lot.closing_at).getTime();
      const nowMs = Date.now();
      const windowMs = lot.anti_snipe_window_secs * 1000;

      if (closingAtMs - nowMs < windowMs && closingAtMs > nowMs) {
        const extensionMs = lot.anti_snipe_extension_secs * 1000;
        newClosingAt = new Date(closingAtMs + extensionMs);
        antiSnipeTriggered = true;
        antiSnipeTriggersTotal.inc();

        // Extend closing_at and reset status to 'open' (trigger: closing→open)
        await client.query(
          `UPDATE lots SET closing_at = $1, status = 'open' WHERE id = $2`,
          [newClosingAt, req.lotId]
        );

        await appendEvent(client, req.lotId, 'ANTI_SNIPE_TRIGGERED', {
          previous_closing_at: lot.closing_at,
          new_closing_at: newClosingAt,
          triggered_by_bidder: req.bidderId,
          triggered_by_bid: acceptedBid.id,
        });
      }
    }

    // ── 9. Synchronous proxy bid resolution ──────────────────────────────────
    const autoIncrementBids: BidRow[] = [];

    if (req.bidType === 'live' || req.bidType === 'auto_increment') {
      await resolveProxyBids(
        client,
        req.lotId,
        req.bidderId,
        newCurrentBid,
        newCurrentWinnerId,
        newBidCount,
        lot.anti_snipe_window_secs,
        lot.anti_snipe_extension_secs,
        newClosingAt,
        autoIncrementBids,
        (bid, winner, count, closingAt, snipeTriggered) => {
          newCurrentBid = bid;
          newCurrentWinnerId = winner;
          newBidCount = count;
          newClosingAt = closingAt;
          if (snipeTriggered) antiSnipeTriggered = true;
        }
      );
    }

    // ── 10. Append BID_ACCEPTED event ────────────────────────────────────────
    await appendEvent(client, req.lotId, 'BID_ACCEPTED', {
      bid_id: acceptedBid.id,
      bidder_id: req.bidderId,
      bid_type: req.bidType,
      amount: req.amountCents,
      reserve_met: reserveMet,
    });

    bidsTotal.inc({ status: 'accepted' });

    // ── 11. Release idempotency lock with response ───────────────────────────
    const finalLotSnapshot = await buildLotSnapshot(client, req.lotId);
    const result: BidResult = {
      bid: formatBid(acceptedBid),
      lot: finalLotSnapshot,
      proxy_resolved: autoIncrementBids.length > 0
        ? autoIncrementBids.map(formatBid)
        : undefined,
    };

    await releaseLock(client, req.idempotencyKey, req.bidderId, 200, result);

    // ── 12. Commit ───────────────────────────────────────────────────────────
    await client.query('COMMIT');

    timer({ status: 'accepted' });

    // ── 13. Publish to Redis pub/sub (best-effort, after commit) ─────────────
    const pubPayload = JSON.stringify({
      type: 'BID_ACCEPTED',
      lot_id: req.lotId,
      new_current_bid: newCurrentBid,
      bid_count: newBidCount,
      closing_at: newClosingAt ? newClosingAt.toISOString() : null,
      reserve_met: reserveMet,
    });
    redis.publish(`auction:${lot.auction_id}`, pubPayload).catch((err) => {
      console.error('[processor] Redis publish error:', err);
    });

    if (antiSnipeTriggered && newClosingAt) {
      redis
        .publish(
          `auction:${lot.auction_id}`,
          JSON.stringify({
            type: 'ANTI_SNIPE',
            lot_id: req.lotId,
            new_closing_at: newClosingAt.toISOString(),
          })
        )
        .catch(() => {});
    }

    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    if (err instanceof BidError) {
      bidsTotal.inc({ status: err.code });
      timer({ status: err.code });
      throw err;
    }

    // Attempt force-unlock on unexpected errors so the idempotency key
    // does not stay permanently locked
    try {
      await client.query(
        `UPDATE bid_idempotency_keys SET locked = FALSE WHERE key = $1 AND bidder_id = $2`,
        [req.idempotencyKey, req.bidderId]
      );
    } catch {}

    bidsTotal.inc({ status: 'error' });
    timer({ status: 'error' });
    throw err;
  } finally {
    client.release();
  }
}

// ── Private Helpers ───────────────────────────────────────────────────────────

/**
 * Synchronously resolve all eligible proxy bids within the same transaction.
 *
 * After a live bid is accepted, any registered bidder with an active proxy bid
 * (max_amount > new current_bid, bidder_id != current winner) immediately
 * auto-increments. This repeats until no competing proxy bids remain.
 *
 * Loop terminates because:
 *   - Each iteration increases current_bid by at least one increment
 *   - Each iteration may outbid proxy bidders (removing them from contention)
 *   - Hard cap MAX_PROXY_ITERATIONS prevents infinite loops from data issues
 */
async function resolveProxyBids(
  client: PoolClient,
  lotId: string,
  initialWinnerId: string,
  initialCurrentBid: number,
  initialCurrentWinnerId: string,
  initialBidCount: number,
  antiSnipeWindowSecs: number,
  antiSnipeExtensionSecs: number,
  initialClosingAt: Date | null,
  outBids: BidRow[],
  onStateChange: (
    newCurrentBid: number,
    newCurrentWinnerId: string,
    newBidCount: number,
    newClosingAt: Date | null,
    antiSnipeTriggered: boolean
  ) => void
): Promise<void> {
  let currentBid = initialCurrentBid;
  let currentWinnerId = initialCurrentWinnerId;
  let bidCount = initialBidCount;
  let closingAt = initialClosingAt;

  for (let i = 0; i < MAX_PROXY_ITERATIONS; i++) {
    // Find the highest competing proxy bid
    const { rows } = await client.query<BidRow>(
      `SELECT b.*
       FROM bids b
       WHERE b.lot_id = $1
         AND b.bid_type = 'proxy'
         AND b.status = 'accepted'
         AND b.max_amount > $2
         AND b.bidder_id != $3
       ORDER BY b.max_amount DESC, b.placed_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [lotId, currentBid, currentWinnerId]
    );

    if (rows.length === 0) break;

    const proxyBid = rows[0];
    const proxyMaxAmount = parseInt(proxyBid.max_amount as unknown as string, 10);
    const nextBidAmount = getMinimumNextBid(currentBid);

    if (proxyMaxAmount < nextBidAmount) break; // proxy can't afford next increment

    // Mark current winner's accepted live/auto_increment bid as outbid
    await client.query(
      `UPDATE bids
       SET status = 'outbid', outbid_at = NOW()
       WHERE lot_id = $1 AND bidder_id = $2
         AND status = 'accepted'
         AND bid_type IN ('live', 'auto_increment')`,
      [lotId, currentWinnerId]
    );

    // Insert auto_increment bid for the proxy bidder
    const { rows: newBidRows } = await client.query<BidRow>(
      `INSERT INTO bids (lot_id, bidder_id, bid_type, amount, status, processed_at)
       VALUES ($1, $2, 'auto_increment', $3, 'accepted', NOW())
       RETURNING *`,
      [lotId, proxyBid.bidder_id, nextBidAmount]
    );
    const newBid = newBidRows[0];
    outBids.push(newBid);
    proxyResolutionsTotal.inc();

    currentBid = nextBidAmount;
    currentWinnerId = proxyBid.bidder_id;
    bidCount += 1;

    // Update lot
    await client.query(
      `UPDATE lots
       SET current_bid = $1, current_winner_id = $2, bid_count = $3, version = version + 1
       WHERE id = $4`,
      [currentBid, currentWinnerId, bidCount, lotId]
    );

    // Anti-snipe check for this auto_increment bid
    let snipeTriggered = false;
    if (closingAt) {
      const closingAtMs = new Date(closingAt).getTime();
      const nowMs = Date.now();
      const windowMs = antiSnipeWindowSecs * 1000;

      if (closingAtMs - nowMs < windowMs && closingAtMs > nowMs) {
        const extensionMs = antiSnipeExtensionSecs * 1000;
        closingAt = new Date(closingAtMs + extensionMs);
        snipeTriggered = true;
        antiSnipeTriggersTotal.inc();

        await client.query(
          `UPDATE lots SET closing_at = $1, status = 'open' WHERE id = $2`,
          [closingAt, lotId]
        );

        await appendEvent(client, lotId, 'ANTI_SNIPE_TRIGGERED', {
          previous_closing_at: new Date(closingAtMs),
          new_closing_at: closingAt,
          triggered_by_auto_increment: true,
          triggered_by_bid: newBid.id,
        });
      }
    }

    // Append PROXY_RESOLVED event
    await appendEvent(client, lotId, 'PROXY_RESOLVED', {
      auto_increment_bid_id: newBid.id,
      proxy_bid_id: proxyBid.id,
      proxy_bidder_id: proxyBid.bidder_id,
      amount: nextBidAmount,
      outbid_bidder_id: initialWinnerId,
    });

    onStateChange(currentBid, currentWinnerId, bidCount, closingAt, snipeTriggered);
  }
}

async function appendEvent(
  client: PoolClient,
  lotId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO auction_events (lot_id, event_type, payload)
     VALUES ($1, $2, $3)`,
    [lotId, eventType, JSON.stringify(payload)]
  );
}

async function buildLotSnapshot(client: PoolClient, lotId: string): Promise<LotSnapshot> {
  const { rows } = await client.query<
    LotRow & { auction_id: string }
  >(
    `SELECT id, auction_id, lot_number, title, category,
            current_bid, bid_count, status, closing_at,
            reserve_price, currency
     FROM lots WHERE id = $1`,
    [lotId]
  );
  const lot = rows[0];
  const currentBid = parseInt(lot.current_bid as unknown as string, 10);
  const reservePrice = lot.reserve_price
    ? parseInt(lot.reserve_price as unknown as string, 10)
    : null;

  return {
    id: lot.id,
    auction_id: lot.auction_id,
    lot_number: lot.lot_number,
    title: lot.title,
    category: lot.category,
    current_bid: currentBid,
    bid_count: lot.bid_count,
    status: lot.status,
    closing_at: lot.closing_at ? new Date(lot.closing_at).toISOString() : null,
    reserve_met: reservePrice !== null && currentBid >= reservePrice,
    currency: lot.currency,
  };
}

function formatBid(row: BidRow): BidResponseItem {
  return {
    id: row.id,
    lot_id: row.lot_id,
    bidder_id: row.bidder_id,
    bid_type: row.bid_type,
    amount: parseInt(row.amount as unknown as string, 10),
    max_amount: row.max_amount ? parseInt(row.max_amount as unknown as string, 10) : null,
    status: row.status,
    placed_at: row.placed_at.toISOString(),
    processed_at: row.processed_at ? row.processed_at.toISOString() : null,
  };
}
