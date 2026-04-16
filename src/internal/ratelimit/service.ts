import { redis } from '../../redis/client';
import { config } from '../../config';
import { RateLimitResult } from '../../types';
import { rateLimitHitsTotal } from '../../metrics';

/**
 * Sliding window rate limiter using Redis sorted sets + Lua.
 *
 * Two buckets per bid attempt:
 *   - global:  60 bids / minute  per bidder (all lots combined)
 *   - per-lot: 10 bids / minute  per (bidder, lot) pair
 *
 * The Lua script is atomic — no race condition between check and increment.
 * Window slides continuously: we store each bid timestamp as a sorted set member,
 * ZREMRANGEBYSCORE trims entries older than (now - windowMs), and ZCARD gives
 * the count within the current window. This gives true sliding-window semantics
 * (1 token replenished per second, not fixed boundary reset).
 */

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_count = tonumber(ARGV[3])
local unique_id = ARGV[4]

local cutoff = now - window_ms

-- Remove expired entries from the window
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

-- Count entries in current window
local count = tonumber(redis.call('ZCARD', key))

if count >= max_count then
  -- Return: allowed=0, limit, remaining=0, oldest_score (reset time)
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset_at = 0
  if #oldest >= 2 then
    reset_at = tonumber(oldest[2]) + window_ms
  end
  return {0, max_count, 0, reset_at}
end

-- Allowed — record this request
redis.call('ZADD', key, now, unique_id)
redis.call('PEXPIRE', key, window_ms + 1000)

local remaining = max_count - count - 1
return {1, max_count, remaining, now + window_ms}
`;

/**
 * Check and consume rate limit tokens for a bid attempt.
 * Checks BOTH the global bucket and the per-lot bucket atomically (Lua for each).
 * Returns the result of whichever bucket is more restrictive.
 */
export async function checkRateLimit(
  bidderId: string,
  lotId: string
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = config.rateLimitWindowMs;
  const uniqueId = `${now}:${Math.random().toString(36).slice(2)}`;

  const globalKey = `ratelimit:global:${bidderId}`;
  const lotKey = `ratelimit:lot:${bidderId}:${lotId}`;

  const [globalResult, lotResult] = await Promise.all([
    redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      globalKey,
      String(now),
      String(windowMs),
      String(config.rateLimitGlobalMax),
      `${uniqueId}:g`
    ) as Promise<[number, number, number, number]>,
    redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      lotKey,
      String(now),
      String(windowMs),
      String(config.rateLimitLotMax),
      `${uniqueId}:l`
    ) as Promise<[number, number, number, number]>,
  ]);

  const [globalAllowed, globalLimit, globalRemaining, globalReset] = globalResult;
  const [lotAllowed, lotLimit, lotRemaining, lotReset] = lotResult;

  if (!globalAllowed) {
    rateLimitHitsTotal.inc({ bucket: 'global' });
    const resetSecs = Math.ceil((globalReset - now) / 1000);
    return {
      allowed: false,
      limit: globalLimit,
      remaining: 0,
      resetMs: globalReset,
      retryAfterSecs: Math.max(1, resetSecs),
      bucket: 'global',
    };
  }

  if (!lotAllowed) {
    rateLimitHitsTotal.inc({ bucket: 'lot' });
    // Roll back the global token we just consumed since the lot bucket rejected
    await redis.zrem(globalKey, `${uniqueId}:g`);
    const resetSecs = Math.ceil((lotReset - now) / 1000);
    return {
      allowed: false,
      limit: lotLimit,
      remaining: 0,
      resetMs: lotReset,
      retryAfterSecs: Math.max(1, resetSecs),
      bucket: 'lot',
    };
  }

  return {
    allowed: true,
    limit: Math.min(globalLimit, lotLimit),
    remaining: Math.min(globalRemaining, lotRemaining),
    resetMs: Math.max(globalReset, lotReset),
  };
}
