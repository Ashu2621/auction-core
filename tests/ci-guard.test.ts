/**
 * Guard: integration tests must never silently skip in CI.
 *
 * Every test that proves something load-bearing in this repository —
 * SELECT ... FOR UPDATE serialising contending bids, the three-state
 * idempotency lock, anti-snipe extension, SKIP LOCKED in the lot closer — is
 * declared with `it.skipIf(!pool)`. That is the right behaviour on a laptop
 * with no database: the suite still runs and reports honestly.
 *
 * It is the wrong behaviour in CI. Without this file, a workflow that forgot
 * to set DATABASE_URL would skip all twenty integration tests and report a
 * green build, so the pipeline would certify nothing while looking like it
 * certified everything. A suite that passes because it ran nothing is worse
 * than no suite at all, because it is trusted.
 *
 * So in CI the absence of a database is a build failure, not a skip.
 */
import { describe, it, expect } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe('CI configuration', () => {
  it('has a database configured whenever CI is set', () => {
    if (!process.env.CI) {
      // Local run without a database: skipping the integration tests is fine,
      // and the console warning in bid-processor.test.ts already says so.
      expect(true).toBe(true);
      return;
    }

    expect(
      DATABASE_URL,
      'CI is set but neither TEST_DATABASE_URL nor DATABASE_URL is — the ' +
        'integration tests would skip and the build would pass having proven ' +
        'nothing. Check the services block in .github/workflows/ci.yml.',
    ).toBeTruthy();
  });

  it('has redis configured whenever CI is set', () => {
    if (!process.env.CI) {
      expect(true).toBe(true);
      return;
    }

    expect(
      process.env.REDIS_URL,
      'CI is set but REDIS_URL is not. src/redis/client.ts connects at import ' +
        'time, so the bid processor tests cannot even load without it.',
    ).toBeTruthy();
  });
});
