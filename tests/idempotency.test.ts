/**
 * Idempotency service tests.
 *
 * Verifies:
 *   - Lock acquisition works correctly
 *   - Concurrent requests with the same key get serialized
 *   - Cached responses are returned correctly
 *   - Locks are released on error
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { lotNumber } from './fixtures/ids';
import { acquireLock, releaseLock, forceUnlock } from '../src/internal/idempotency/service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const pool = TEST_DATABASE_URL ? new Pool({ connectionString: TEST_DATABASE_URL }) : null;

async function getClient(p: Pool): Promise<PoolClient> {
  const client = await p.connect();
  await client.query('BEGIN');
  return client;
}

async function commitAndRelease(client: PoolClient): Promise<void> {
  await client.query('COMMIT');
  client.release();
}

async function rollbackAndRelease(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK');
  client.release();
}

async function ensureBidder(p: Pool): Promise<string> {
  const email = `idem-test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
  const { rows: [b] } = await p.query(
    `INSERT INTO bidders (email, display_name) VALUES ($1, 'Idempotency Test Bidder') RETURNING id`,
    [email]
  );
  return b.id;
}

describe('Idempotency Service', () => {
  afterAll(async () => {
    await pool?.end();
  });

  it.skipIf(!pool)('acquires a new lock for a fresh key', async () => {
    const bidderId = await ensureBidder(pool!);
    const key = `fresh-key-${Date.now()}`;

    const client = await getClient(pool!);
    try {
      const result = await acquireLock(client, key, bidderId);
      expect(result.status).toBe('new');
      await commitAndRelease(client);
    } catch (err) {
      await rollbackAndRelease(client);
      throw err;
    }

    // Verify row exists with locked=TRUE
    const { rows } = await pool!.query(
      `SELECT locked FROM bid_idempotency_keys WHERE key = $1 AND bidder_id = $2`,
      [key, bidderId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].locked).toBe(true);
  });

  it.skipIf(!pool)('returns cached response for a completed key', async () => {
    const bidderId = await ensureBidder(pool!);
    const key = `cached-key-${Date.now()}`;
    const mockResponse = { bid: { id: 'abc', amount: 10500 }, lot: { id: 'lot-1' } };

    // Phase 1: acquire and release
    const client1 = await getClient(pool!);
    try {
      const result1 = await acquireLock(client1, key, bidderId);
      expect(result1.status).toBe('new');
      await releaseLock(client1, key, bidderId, 200, mockResponse);
      await commitAndRelease(client1);
    } catch (err) {
      await rollbackAndRelease(client1);
      throw err;
    }

    // Phase 2: replay the same key
    const client2 = await getClient(pool!);
    try {
      const result2 = await acquireLock(client2, key, bidderId);
      expect(result2.status).toBe('cached');
      if (result2.status === 'cached') {
        expect(result2.responseCode).toBe(200);
        expect(result2.responseBody).toMatchObject({ bid: { amount: 10500 } });
      }
      await rollbackAndRelease(client2);
    } catch (err) {
      await rollbackAndRelease(client2);
      throw err;
    }
  });

  it.skipIf(!pool)('detects concurrent in-flight requests via SKIP LOCKED', async () => {
    const bidderId = await ensureBidder(pool!);
    const key = `concurrent-idem-${Date.now()}`;

    // Simulate request 1: acquires lock and holds it (transaction not committed)
    const client1 = await pool!.connect();
    await client1.query('BEGIN');

    try {
      // Insert locked=TRUE row (simulates request 1 in progress)
      await client1.query(
        `INSERT INTO bid_idempotency_keys (key, bidder_id, response_code, response_body, locked)
         VALUES ($1, $2, 0, '{}', TRUE)`,
        [key, bidderId]
      );
      // NOTE: NOT committed yet — row is visible but locked by this transaction

      // Simulate request 2: tries to acquire the same key
      // This must be in a separate connection
      const client2 = await pool!.connect();
      await client2.query('BEGIN');

      try {
        const result2 = await acquireLock(client2, key, bidderId);
        // Should detect the in-flight lock and return 'in_flight'
        expect(result2.status).toBe('in_flight');
        await client2.query('ROLLBACK');
      } finally {
        client2.release();
      }
    } finally {
      await client1.query('ROLLBACK');
      client1.release();
    }
  });

  it.skipIf(!pool)('force-unlocks a stuck key on error', async () => {
    const bidderId = await ensureBidder(pool!);
    const key = `stuck-key-${Date.now()}`;

    // Create a stuck locked key
    await pool!.query(
      `INSERT INTO bid_idempotency_keys (key, bidder_id, response_code, response_body, locked)
       VALUES ($1, $2, 0, '{}', TRUE)`,
      [key, bidderId]
    );

    // Force unlock
    await forceUnlock(key, bidderId, pool!);

    // Verify it's now unlocked
    const { rows } = await pool!.query(
      `SELECT locked FROM bid_idempotency_keys WHERE key = $1 AND bidder_id = $2`,
      [key, bidderId]
    );
    expect(rows[0].locked).toBe(false);
  });

  it.skipIf(!pool)('two concurrent submissions with same key — only one bid recorded', async () => {
    // This is an end-to-end concurrent test using processBid
    // Both requests use the same idempotency key
    // Only one should result in a bid being recorded

    // Create test auction and lot
    const { rows: [ah] } = await pool!.query(
      `INSERT INTO auction_houses (name, slug, currency, buyer_premium_pct)
       VALUES ('Test House Idem', gen_random_uuid()::text, 'USD', 0.15) RETURNING id`
    );
    const { rows: [a] } = await pool!.query(
      `INSERT INTO auctions (auction_house_id, title, status, scheduled_start, scheduled_end, actual_start, allow_proxy_bids)
       VALUES ($1, 'Idem Test Auction', 'live', NOW() - INTERVAL '1h', NOW() + INTERVAL '8h', NOW() - INTERVAL '1h', TRUE)
       RETURNING id`,
      [ah.id]
    );
    const { rows: [lot] } = await pool!.query(
      `INSERT INTO lots (auction_id, lot_number, title, starting_bid, current_bid, status, closing_at, currency)
       VALUES ($1, $2, 'Idem Test Lot', 10000, 10000, 'open', NOW() + INTERVAL '30m', 'USD')
       RETURNING id`,
      [a.id, lotNumber('IDEM')]
    );
    const email = `idem-bidder-${Date.now()}@test.com`;
    const { rows: [bidder] } = await pool!.query(
      `INSERT INTO bidders (email, display_name) VALUES ($1, 'Idem Bidder') RETURNING id`,
      [email]
    );
    await pool!.query(
      `INSERT INTO auction_registrations (auction_id, bidder_id, is_eligible) VALUES ($1, $2, TRUE)`,
      [a.id, bidder.id]
    );

    const sharedKey = `shared-key-${Date.now()}`;
    const { processBid } = await import('../src/internal/bidding/processor');

    // Both requests use the same idempotency key
    const [r1, r2] = await Promise.allSettled([
      processBid({ lotId: lot.id, bidderId: bidder.id, amountCents: 10500, bidType: 'live', idempotencyKey: sharedKey }),
      processBid({ lotId: lot.id, bidderId: bidder.id, amountCents: 10500, bidType: 'live', idempotencyKey: sharedKey }),
    ]);

    // Count accepted bids for this lot+bidder with this idempotency key
    const { rows: acceptedBids } = await pool!.query(
      `SELECT COUNT(*) AS c FROM bids WHERE lot_id = $1 AND bidder_id = $2 AND idempotency_key = $3`,
      [lot.id, bidder.id, sharedKey]
    );
    const bidCount = parseInt(acceptedBids[0].c, 10);

    // Exactly one bid should exist regardless of concurrency
    expect(bidCount).toBe(1);

    // At least one request must have succeeded
    const succeeded = [r1, r2].filter((r) => r.status === 'fulfilled');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
  });
});
