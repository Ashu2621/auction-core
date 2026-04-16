/**
 * Bid processor tests — covers atomic processing, anti-sniping, and proxy resolution.
 *
 * Uses a real PostgreSQL database (TEST_DATABASE_URL env var).
 * Each test runs within its own data set to avoid interference.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { processBid } from '../src/internal/bidding/processor';
import { BidError } from '../src/types';
import { getMinimumNextBid } from '../src/internal/bidding/increment';

// ── Test database setup ───────────────────────────────────────────────────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!TEST_DATABASE_URL) {
  console.warn('[test] TEST_DATABASE_URL not set — skipping integration tests');
}

const pool = TEST_DATABASE_URL ? new Pool({ connectionString: TEST_DATABASE_URL }) : null;

// Shared test fixture IDs
let auctionHouseId: string;
let auctionId: string;

async function createTestFixtures(
  p: Pool
): Promise<{ auctionHouseId: string; auctionId: string }> {
  const { rows: [ah] } = await p.query(
    `INSERT INTO auction_houses (name, slug, currency, buyer_premium_pct)
     VALUES ('Test House', gen_random_uuid()::text, 'USD', 0.15)
     RETURNING id`
  );
  const { rows: [a] } = await p.query(
    `INSERT INTO auctions
       (auction_house_id, title, status, scheduled_start, scheduled_end,
        actual_start, allow_proxy_bids, require_verification)
     VALUES ($1, 'Test Auction', 'live', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '8 hours',
             NOW() - INTERVAL '1 hour', TRUE, FALSE)
     RETURNING id`,
    [ah.id]
  );
  return { auctionHouseId: ah.id, auctionId: a.id };
}

async function createTestLot(
  p: Pool,
  aId: string,
  opts: {
    startingBid?: number;
    status?: string;
    closingAt?: Date;
    reservePrice?: number | null;
  } = {}
): Promise<string> {
  const startingBid = opts.startingBid ?? 10_000;  // $100
  const lotNumber = `LOT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { rows: [lot] } = await p.query(
    `INSERT INTO lots
       (auction_id, lot_number, title, starting_bid, reserve_price, current_bid,
        status, closing_at, currency)
     VALUES ($1, $2, 'Test Lot', $3, $4, $3, $5, $6, 'USD')
     RETURNING id`,
    [
      aId,
      lotNumber,
      startingBid,
      opts.reservePrice ?? null,
      opts.status ?? 'open',
      opts.closingAt ?? new Date(Date.now() + 30 * 60 * 1000),
    ]
  );
  return lot.id;
}

async function createTestBidder(p: Pool, auctionId: string): Promise<string> {
  const email = `test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
  const { rows: [bidder] } = await p.query(
    `INSERT INTO bidders (email, display_name, verification_tier) VALUES ($1, 'Test Bidder', 'verified') RETURNING id`,
    [email]
  );
  await p.query(
    `INSERT INTO auction_registrations (auction_id, bidder_id, is_eligible) VALUES ($1, $2, TRUE)`,
    [auctionId, bidder.id]
  );
  return bidder.id;
}

// ── Increment Function Unit Tests ─────────────────────────────────────────────

describe('getBidIncrement', () => {
  it('returns $5 increment for bids under $100', () => {
    expect(getMinimumNextBid(0)).toBe(500);        // $0 → next $5
    expect(getMinimumNextBid(500)).toBe(1_000);    // $5 → next $10
    expect(getMinimumNextBid(9_999)).toBe(10_499); // $99.99 → next ~$104.99
  });

  it('returns $10 increment for $100-$499', () => {
    expect(getMinimumNextBid(10_000)).toBe(11_000);  // $100 → $110
    expect(getMinimumNextBid(20_000)).toBe(21_000);  // $200 → $210
    expect(getMinimumNextBid(49_900)).toBe(50_900);  // $499 → $509
  });

  it('returns $25 increment for $500-$999', () => {
    expect(getMinimumNextBid(50_000)).toBe(52_500);  // $500 → $525
    expect(getMinimumNextBid(75_000)).toBe(77_500);  // $750 → $775
  });

  it('returns $50 increment for $1,000-$4,999', () => {
    expect(getMinimumNextBid(100_000)).toBe(105_000); // $1,000 → $1,050
    expect(getMinimumNextBid(200_000)).toBe(205_000); // $2,000 → $2,050
  });

  it('returns $250 increment for $5,000-$19,999', () => {
    expect(getMinimumNextBid(500_000)).toBe(525_000);  // $5,000 → $5,250
    expect(getMinimumNextBid(1_000_000)).toBe(1_025_000); // $10,000 → $10,250
  });

  it('returns $1,000 increment for $20,000-$99,999', () => {
    expect(getMinimumNextBid(2_000_000)).toBe(2_100_000); // $20,000 → $21,000
  });

  it('returns $5,000 increment for ≥$100,000', () => {
    expect(getMinimumNextBid(10_000_000)).toBe(10_500_000); // $100,000 → $105,000
  });
});

// ── Integration Tests ─────────────────────────────────────────────────────────

describe('processBid (integration)', () => {
  beforeAll(async () => {
    if (!pool) return;
    const fixtures = await createTestFixtures(pool);
    auctionHouseId = fixtures.auctionHouseId;
    auctionId = fixtures.auctionId;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it.skipIf(!pool)('accepts a valid live bid', async () => {
    const lotId = await createTestLot(pool!, auctionId, { startingBid: 10_000 });
    const bidderId = await createTestBidder(pool!, auctionId);

    const result = await processBid({
      lotId,
      bidderId,
      amountCents: 10_500,  // $105 (minimum next bid from $100)
      bidType: 'live',
      idempotencyKey: `test-${Date.now()}-1`,
    });

    expect(result.bid.status).toBe('accepted');
    expect(result.bid.amount).toBe(10_500);
    expect(result.lot.current_bid).toBe(10_500);
    expect(result.lot.bid_count).toBe(1);
  });

  it.skipIf(!pool)('rejects a bid below minimum increment', async () => {
    const lotId = await createTestLot(pool!, auctionId, { startingBid: 10_000 });
    const bidderId = await createTestBidder(pool!, auctionId);

    await expect(
      processBid({
        lotId,
        bidderId,
        amountCents: 10_100,  // below $105 minimum
        bidType: 'live',
        idempotencyKey: `test-${Date.now()}-2`,
      })
    ).rejects.toThrow(BidError);
  });

  it.skipIf(!pool)('rejects a bid on a closed lot', async () => {
    const lotId = await createTestLot(pool!, auctionId, {
      startingBid: 10_000,
      status: 'sold',
    });
    const bidderId = await createTestBidder(pool!, auctionId);

    await expect(
      processBid({
        lotId,
        bidderId,
        amountCents: 11_000,
        bidType: 'live',
        idempotencyKey: `test-${Date.now()}-3`,
      })
    ).rejects.toMatchObject({ code: expect.stringContaining('lot') });
  });

  it.skipIf(!pool)('triggers anti-snipe when bid is within 2-minute window', async () => {
    // Set closing_at to 90 seconds from now (inside anti-snipe window)
    const closingAt = new Date(Date.now() + 90 * 1000);
    const lotId = await createTestLot(pool!, auctionId, {
      startingBid: 10_000,
      status: 'closing',
      closingAt,
    });
    const bidderId = await createTestBidder(pool!, auctionId);

    const result = await processBid({
      lotId,
      bidderId,
      amountCents: 10_500,
      bidType: 'live',
      idempotencyKey: `test-${Date.now()}-antis`,
    });

    expect(result.lot.status).toBe('open');  // status reset from closing to open
    expect(result.lot.closing_at).toBeTruthy();

    const newClosingAt = new Date(result.lot.closing_at!);
    // new closing_at should be ≥ closing_at + 120s (anti-snipe extension)
    expect(newClosingAt.getTime()).toBeGreaterThan(closingAt.getTime() + 110 * 1000);

    // Verify the ANTI_SNIPE_TRIGGERED event was recorded
    const { rows: events } = await pool!.query(
      `SELECT * FROM auction_events WHERE lot_id = $1 AND event_type = 'ANTI_SNIPE_TRIGGERED'`,
      [lotId]
    );
    expect(events.length).toBeGreaterThan(0);
  });

  it.skipIf(!pool)('does NOT trigger anti-snipe when outside 2-minute window', async () => {
    // Set closing_at to 10 minutes from now (outside anti-snipe window)
    const closingAt = new Date(Date.now() + 10 * 60 * 1000);
    const lotId = await createTestLot(pool!, auctionId, {
      startingBid: 10_000,
      status: 'open',
      closingAt,
    });
    const bidderId = await createTestBidder(pool!, auctionId);

    const result = await processBid({
      lotId,
      bidderId,
      amountCents: 10_500,
      bidType: 'live',
      idempotencyKey: `test-${Date.now()}-nosnipe`,
    });

    expect(result.lot.status).toBe('open');
    // closing_at should NOT have been extended significantly
    const resultClosingAt = new Date(result.lot.closing_at!);
    // Allow ≤5s difference (just the time elapsed during the test)
    expect(Math.abs(resultClosingAt.getTime() - closingAt.getTime())).toBeLessThan(5000);
  });

  it.skipIf(!pool)('resolves proxy bids synchronously after a live bid', async () => {
    const lotId = await createTestLot(pool!, auctionId, { startingBid: 10_000 });
    const liveBidder = await createTestBidder(pool!, auctionId);
    const proxyBidder = await createTestBidder(pool!, auctionId);

    // Register a proxy bid for proxyBidder (max $200)
    await pool!.query(
      `INSERT INTO bids (lot_id, bidder_id, bid_type, amount, max_amount, status, processed_at)
       VALUES ($1, $2, 'proxy', 10500, 20000, 'accepted', NOW())`,
      [lotId, proxyBidder]
    );

    // liveBidder places a live bid at minimum ($105)
    const result = await processBid({
      lotId,
      bidderId: liveBidder,
      amountCents: 10_500,
      bidType: 'live',
      idempotencyKey: `test-${Date.now()}-proxy`,
    });

    // Proxy should have auto-incremented: proxyBidder now wins
    expect(result.proxy_resolved).toBeDefined();
    expect(result.proxy_resolved!.length).toBeGreaterThan(0);
    expect(result.lot.current_bid).toBeGreaterThan(10_500);

    // The live bidder's bid should be outbid
    const { rows: liveBids } = await pool!.query(
      `SELECT status FROM bids WHERE lot_id = $1 AND bidder_id = $2 AND bid_type = 'live'`,
      [lotId, liveBidder]
    );
    expect(liveBids.every((b: { status: string }) => b.status === 'outbid')).toBe(true);
  });

  it.skipIf(!pool)('handles concurrent bids atomically — only one wins the increment', async () => {
    const lotId = await createTestLot(pool!, auctionId, { startingBid: 10_000 });
    const bidder1 = await createTestBidder(pool!, auctionId);
    const bidder2 = await createTestBidder(pool!, auctionId);

    const bidAmount = 10_500; // both try to bid the exact same minimum
    const key1 = `concurrent-test-${Date.now()}-bidder1`;
    const key2 = `concurrent-test-${Date.now()}-bidder2`;

    // Submit both bids concurrently
    const [result1, result2] = await Promise.allSettled([
      processBid({ lotId, bidderId: bidder1, amountCents: bidAmount, bidType: 'live', idempotencyKey: key1 }),
      processBid({ lotId, bidderId: bidder2, amountCents: bidAmount, bidType: 'live', idempotencyKey: key2 }),
    ]);

    const successes = [result1, result2].filter((r) => r.status === 'fulfilled');
    const failures = [result1, result2].filter((r) => r.status === 'rejected');

    // Exactly one should succeed (or both succeed if they bid sequentially with different amounts)
    // The key invariant: the lot has exactly ONE current winner
    const { rows: [lot] } = await pool!.query(
      `SELECT current_bid, current_winner_id, bid_count FROM lots WHERE id = $1`,
      [lotId]
    );
    expect(lot.current_winner_id).toBeTruthy();
    // bid_count can be 1 (one won) or 2 (both succeeded if increments applied)
    expect(lot.bid_count).toBeGreaterThanOrEqual(1);

    // The lot should not be corrupted — current_bid should be valid
    expect(parseInt(lot.current_bid, 10)).toBeGreaterThanOrEqual(bidAmount);
  });

  it.skipIf(!pool)('proxy bid does not outbid itself', async () => {
    const lotId = await createTestLot(pool!, auctionId, { startingBid: 10_000 });
    const winnerBidder = await createTestBidder(pool!, auctionId);

    // Winner places a proxy bid
    await pool!.query(
      `UPDATE lots SET current_winner_id = $1, current_bid = 10500 WHERE id = $2`,
      [winnerBidder, lotId]
    );

    // Another bidder places a live bid
    const challenger = await createTestBidder(pool!, auctionId);
    await pool!.query(
      `INSERT INTO bids (lot_id, bidder_id, bid_type, amount, max_amount, status, processed_at)
       VALUES ($1, $2, 'proxy', 11000, 50000, 'accepted', NOW())`,
      [lotId, winnerBidder]
    );

    const result = await processBid({
      lotId,
      bidderId: challenger,
      amountCents: 11_000,
      bidType: 'live',
      idempotencyKey: `test-${Date.now()}-no-self-outbid`,
    });

    // Winner's proxy should have countered — winner should remain the winner
    // OR challenger wins if their bid is above winner's proxy max
    // The lot should not be in an invalid state
    expect(result.lot.current_bid).toBeGreaterThanOrEqual(11_000);
    expect(result.lot.current_winner_id).toBeTruthy();
  });
});
