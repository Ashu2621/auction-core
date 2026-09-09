// Load .env in development; in production env vars are injected by the container
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
} catch { /* dotenv optional */ }

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

/**
 * Configuration is resolved on access, not on import.
 *
 * DESIGN NOTE — why these are getters.
 *
 * `requireEnv` used to run while this module was being evaluated, so merely
 * *importing* anything downstream of it threw when a variable was absent. That
 * is a module-load side effect, and it made the code untestable in the one
 * place it mattered most: tests/bid-processor.test.ts and
 * tests/settlement.test.ts import the bid processor and the lot closer, so on
 * a checkout without DATABASE_URL both suites failed during collection.
 * Twenty-two integration tests never ran, and the failure read as a broken
 * test rather than as a missing variable.
 *
 * As getters the check fires when a value is actually read. A process that
 * genuinely needs the database still fails with the same message; a test that
 * imports a module to reach a pure function no longer pays for a variable it
 * never uses.
 *
 * The validation is not weaker, only later — assertRuntimeConfig() below
 * restores fail-fast at the server entry point, where failing at boot rather
 * than on the first request is the behaviour worth having.
 */
export const config = {
  get port(): number { return parseInt(optionalEnv('PORT', '3000'), 10); },
  get logLevel(): string { return optionalEnv('LOG_LEVEL', 'info'); },
  get nodeEnv(): string { return optionalEnv('NODE_ENV', 'development'); },

  get databaseUrl(): string { return requireEnv('DATABASE_URL'); },
  get redisUrl(): string { return requireEnv('REDIS_URL'); },

  get paymentGatewayUrl(): string { return optionalEnv('PAYMENT_GATEWAY_URL', 'http://localhost:3001'); },
  get identityVerificationUrl(): string { return optionalEnv('IDENTITY_VERIFICATION_URL', 'http://localhost:3002'); },

  get antiSnipeWindowSecs(): number { return parseInt(optionalEnv('ANTI_SNIPE_WINDOW_SECS', '120'), 10); },
  get antiSnipeExtensionSecs(): number { return parseInt(optionalEnv('ANTI_SNIPE_EXTENSION_SECS', '120'), 10); },

  get rateLimitWindowMs(): number { return parseInt(optionalEnv('RATE_LIMIT_WINDOW_MS', '60000'), 10); },
  get rateLimitGlobalMax(): number { return parseInt(optionalEnv('RATE_LIMIT_GLOBAL_MAX', '60'), 10); },
  get rateLimitLotMax(): number { return parseInt(optionalEnv('RATE_LIMIT_LOT_MAX', '10'), 10); },

  get buyerPremiumPct(): number { return parseFloat(optionalEnv('BUYER_PREMIUM_PCT', '0.15')); },
  get settlementRetryMax(): number { return parseInt(optionalEnv('SETTLEMENT_RETRY_MAX', '3'), 10); },
  get settlementRetryBackoffMs(): number { return parseInt(optionalEnv('SETTLEMENT_RETRY_BACKOFF_MS', '3600000'), 10); },

  get idempotencyTtlSecs(): number { return parseInt(optionalEnv('IDEMPOTENCY_TTL_SECS', '3600'), 10); },

  lotCloserIntervalMs: 5000,
  settlementIntervalMs: 10 * 60 * 1000,  // 10 minutes
  wsHeartbeatMs: 10000,
  wsPongTimeoutMs: 5000,
} as const;

/**
 * Read every required variable once, so a long-running process fails at boot
 * rather than on the first request that happens to need one. Called from the
 * server entry point; tests deliberately do not call it.
 */
export function assertRuntimeConfig(): void {
  void config.databaseUrl;
  void config.redisUrl;
}

export type Config = typeof config;
