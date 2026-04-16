import { PoolClient } from 'pg';
import { BidResult } from '../../types';
import { idempotencyReplaysTotal, idempotencyConflictsTotal } from '../../metrics';

export type IdempotencyOutcome =
  | { status: 'new' }
  | { status: 'cached'; responseCode: number; responseBody: BidResult }
  | { status: 'in_flight' };

/**
 * Attempt to acquire an idempotency lock for a bid submission.
 *
 * Strategy:
 *   1. INSERT new row with locked=TRUE (ON CONFLICT DO NOTHING)
 *   2. If inserted → we own the lock, proceed
 *   3. If conflict → SELECT FOR UPDATE SKIP LOCKED
 *      - 0 rows returned (SKIP LOCKED skipped it) → another request holds it → 409
 *      - Row found with locked=FALSE → completed, return cached response
 *      - Row found with locked=TRUE  → in-flight → 409
 *
 * The caller MUST call releaseLock() after processing (in a try/finally).
 * The client passed in does NOT need to be in a transaction — this function
 * manages its own short transactions internally.
 */
export async function acquireLock(
  client: PoolClient,
  key: string,
  bidderId: string
): Promise<IdempotencyOutcome> {
  // Phase 1: attempt to insert a new locked row
  const { rows: inserted } = await client.query<{
    key: string;
    bidder_id: string;
  }>(
    `INSERT INTO bid_idempotency_keys (key, bidder_id, response_code, response_body, locked)
     VALUES ($1, $2, 0, '{}', TRUE)
     ON CONFLICT (key, bidder_id) DO NOTHING
     RETURNING key`,
    [key, bidderId]
  );

  if (inserted.length > 0) {
    // We own a fresh lock
    return { status: 'new' };
  }

  // Phase 2: key already exists — check its state using SKIP LOCKED
  const { rows: existing } = await client.query<{
    response_code: number;
    response_body: BidResult;
    locked: boolean;
  }>(
    `SELECT response_code, response_body, locked
     FROM bid_idempotency_keys
     WHERE key = $1 AND bidder_id = $2
     FOR UPDATE SKIP LOCKED`,
    [key, bidderId]
  );

  if (existing.length === 0) {
    // Row exists but is locked by another transaction (SKIP LOCKED skipped it)
    idempotencyConflictsTotal.inc();
    return { status: 'in_flight' };
  }

  const row = existing[0];

  if (row.locked) {
    // locked=TRUE in DB but no transaction lock — very brief window between
    // another request's INSERT commit and its bid processing. Treat as in-flight.
    idempotencyConflictsTotal.inc();
    return { status: 'in_flight' };
  }

  // Completed — return cached response
  idempotencyReplaysTotal.inc();
  return {
    status: 'cached',
    responseCode: row.response_code,
    responseBody: row.response_body,
  };
}

/**
 * Release the idempotency lock and store the response for future replays.
 * Must be called whether processing succeeded or failed.
 */
export async function releaseLock(
  client: PoolClient,
  key: string,
  bidderId: string,
  responseCode: number,
  responseBody: unknown
): Promise<void> {
  await client.query(
    `UPDATE bid_idempotency_keys
     SET locked = FALSE, response_code = $3, response_body = $4
     WHERE key = $1 AND bidder_id = $2`,
    [key, bidderId, responseCode, JSON.stringify(responseBody)]
  );
}

/**
 * Force-unlock a key without storing a response (used in error cleanup).
 * Safe to call even if the row does not exist.
 */
export async function forceUnlock(
  key: string,
  bidderId: string,
  dbPool: import('pg').Pool
): Promise<void> {
  try {
    await dbPool.query(
      `UPDATE bid_idempotency_keys SET locked = FALSE WHERE key = $1 AND bidder_id = $2`,
      [key, bidderId]
    );
  } catch {
    // Best effort — log but do not throw
    console.error(`[idempotency] Failed to force-unlock key=${key}`);
  }
}

/**
 * Clean up expired idempotency keys.
 * Should be run periodically (e.g. hourly) to prevent table bloat.
 */
export async function cleanupExpiredKeys(dbPool: import('pg').Pool): Promise<number> {
  const { rowCount } = await dbPool.query(
    `DELETE FROM bid_idempotency_keys WHERE expires_at < NOW() AND locked = FALSE`
  );
  return rowCount ?? 0;
}
