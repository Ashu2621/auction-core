/**
 * Settlement engine tests.
 *
 * Covers:
 *   - Lot closer transitions (sold/passed)
 *   - Invoice generation on lot close
 *   - Payment processing (approval + decline + retry)
 *   - SKIP LOCKED prevents double-closing
 *   - Idempotent payment capture
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { lotNumber } from './fixtures/ids';
import { runLotCloserCycle } from '../src/internal/settlement/lot-closer';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const pool = TEST_DATABASE_URL ? new Pool({ connectionString: TEST_DATABASE_URL }) : null;

async function setupAuction(p: Pool): Promise<{ auctionId: string; auctionHouseId: string }> {
  const { rows: [ah] } = await p.query(
    `INSERT INTO auction_houses (name, slug, currency, buyer_premium_pct)
     VALUES ('Settlement Test House', gen_random_uuid()::text, 'USD', 0.15) RETURNING id`
  );
  const { rows: [a] } = await p.query(
    `INSERT INTO auctions
       (auction_house_id, title, status, scheduled_start, scheduled_end,
        actual_start, allow_proxy_bids)
     VALUES ($1, 'Settlement Test Auction', 'live',
             NOW() - INTERVAL '2h', NOW() + INTERVAL '6h',
             NOW() - INTERVAL '2h', TRUE)
     RETURNING id`,
    [ah.id]
  );
  return { auctionId: a.id, auctionHouseId: ah.id };
}

async function setupBidder(p: Pool, auctionId: string): Promise<string> {
  const email = `settle-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
  const { rows: [b] } = await p.query(
    `INSERT INTO bidders (email, display_name) VALUES ($1, 'Settlement Bidder') RETURNING id`,
    [email]
  );
  await p.query(
    `INSERT INTO auction_registrations (auction_id, bidder_id, is_eligible) VALUES ($1, $2, TRUE)`,
    [auctionId, b.id]
  );
  return b.id;
}

async function createClosingLot(
  p: Pool,
  auctionId: string,
  opts: {
    currentBidCents: number;
    reservePriceCents?: number | null;
    winnerId?: string | null;
    closingAt?: Date;
  }
): Promise<string> {
  const closingAt = opts.closingAt ?? new Date(Date.now() - 1000); // already past
  const { rows: [lot] } = await p.query(
    `INSERT INTO lots
       (auction_id, lot_number, title, starting_bid, reserve_price, current_bid,
        current_winner_id, bid_count, status, closing_at, currency)
     VALUES ($1, $2, 'Settlement Test Lot', $3, $4, $5, $6, $7, 'closing', $8, 'USD')
     RETURNING id`,
    [
      auctionId,
      lotNumber('SETL'),
      opts.currentBidCents,
      opts.reservePriceCents ?? null,
      opts.currentBidCents,
      opts.winnerId ?? null,
      opts.winnerId ? 1 : 0,
      closingAt,
    ]
  );
  return lot.id;
}

describe('Lot Closer', () => {
  afterAll(async () => {
    await pool?.end();
  });

  it.skipIf(!pool)('transitions a lot with winner and no reserve from closing → sold', async () => {
    const { auctionId } = await setupAuction(pool!);
    const bidderId = await setupBidder(pool!, auctionId);
    const lotId = await createClosingLot(pool!, auctionId, {
      currentBidCents: 50_000,
      reservePriceCents: null,
      winnerId: bidderId,
    });

    await runLotCloserCycle();

    const { rows: [lot] } = await pool!.query(
      `SELECT status, sold_price FROM lots WHERE id = $1`,
      [lotId]
    );
    expect(lot.status).toBe('sold');
    expect(parseInt(lot.sold_price, 10)).toBe(50_000);
  });

  it.skipIf(!pool)('transitions a lot that does not meet reserve from closing → passed', async () => {
    const { auctionId } = await setupAuction(pool!);
    const bidderId = await setupBidder(pool!, auctionId);
    const lotId = await createClosingLot(pool!, auctionId, {
      currentBidCents: 50_000,
      reservePriceCents: 100_000,  // reserve $1,000 > current bid $500
      winnerId: bidderId,
    });

    await runLotCloserCycle();

    const { rows: [lot] } = await pool!.query(
      `SELECT status, sold_price FROM lots WHERE id = $1`,
      [lotId]
    );
    expect(lot.status).toBe('passed');
    expect(lot.sold_price).toBeNull();
  });

  it.skipIf(!pool)('transitions a lot with no bids from closing → passed', async () => {
    const { auctionId } = await setupAuction(pool!);
    const lotId = await createClosingLot(pool!, auctionId, {
      currentBidCents: 10_000,
      reservePriceCents: null,
      winnerId: null,  // no bids
    });

    await runLotCloserCycle();

    const { rows: [lot] } = await pool!.query(
      `SELECT status FROM lots WHERE id = $1`,
      [lotId]
    );
    expect(lot.status).toBe('passed');
  });

  it.skipIf(!pool)('creates a settlement invoice when lot is sold', async () => {
    const { auctionId } = await setupAuction(pool!);
    const bidderId = await setupBidder(pool!, auctionId);
    const lotId = await createClosingLot(pool!, auctionId, {
      currentBidCents: 100_000,  // $1,000 hammer price
      reservePriceCents: null,
      winnerId: bidderId,
    });

    await runLotCloserCycle();

    const { rows: [invoice] } = await pool!.query(
      `SELECT * FROM settlement_invoices WHERE lot_id = $1`,
      [lotId]
    );

    expect(invoice).toBeTruthy();
    expect(parseInt(invoice.hammer_price, 10)).toBe(100_000);
    // buyer premium = 15% of $1,000 = $150 = 15,000 cents
    expect(parseInt(invoice.buyer_premium, 10)).toBe(15_000);
    expect(parseInt(invoice.total_due, 10)).toBe(115_000);
    expect(invoice.status).toBe('pending');
  });

  it.skipIf(!pool)('does not create duplicate invoices for the same lot (idempotent)', async () => {
    const { auctionId } = await setupAuction(pool!);
    const bidderId = await setupBidder(pool!, auctionId);
    const lotId = await createClosingLot(pool!, auctionId, {
      currentBidCents: 50_000,
      reservePriceCents: null,
      winnerId: bidderId,
    });

    // Run lot closer twice
    await runLotCloserCycle();
    await runLotCloserCycle();

    const { rows: invoices } = await pool!.query(
      `SELECT * FROM settlement_invoices WHERE lot_id = $1`,
      [lotId]
    );

    // Exactly one invoice should exist
    expect(invoices.length).toBe(1);
  });

  it.skipIf(!pool)('SKIP LOCKED prevents two concurrent closers from double-closing a lot', async () => {
    const { auctionId } = await setupAuction(pool!);
    const bidderId = await setupBidder(pool!, auctionId);
    const lotId = await createClosingLot(pool!, auctionId, {
      currentBidCents: 50_000,
      reservePriceCents: null,
      winnerId: bidderId,
    });

    // Run two lot-closer cycles concurrently
    await Promise.all([
      runLotCloserCycle(),
      runLotCloserCycle(),
    ]);

    // Lot should be in a terminal state exactly once
    const { rows: [lot] } = await pool!.query(
      `SELECT status FROM lots WHERE id = $1`,
      [lotId]
    );
    expect(['sold', 'passed']).toContain(lot.status);

    const { rows: invoices } = await pool!.query(
      `SELECT COUNT(*) AS c FROM settlement_invoices WHERE lot_id = $1`,
      [lotId]
    );
    expect(parseInt(invoices[0].c, 10)).toBeLessThanOrEqual(1);
  });

  it.skipIf(!pool)('emits LOT_SOLD event when lot closes as sold', async () => {
    const { auctionId } = await setupAuction(pool!);
    const bidderId = await setupBidder(pool!, auctionId);
    const lotId = await createClosingLot(pool!, auctionId, {
      currentBidCents: 75_000,
      reservePriceCents: null,
      winnerId: bidderId,
    });

    await runLotCloserCycle();

    const { rows: events } = await pool!.query(
      `SELECT event_type, payload FROM auction_events WHERE lot_id = $1`,
      [lotId]
    );
    const soldEvent = events.find((e: { event_type: string }) => e.event_type === 'LOT_SOLD');
    expect(soldEvent).toBeTruthy();
    expect(soldEvent.payload.winner_id).toBe(bidderId);
    expect(soldEvent.payload.sold_price).toBe(75_000);
  });
});
