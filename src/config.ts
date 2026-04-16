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

export const config = {
  port: parseInt(optionalEnv('PORT', '3000'), 10),
  logLevel: optionalEnv('LOG_LEVEL', 'info'),
  nodeEnv: optionalEnv('NODE_ENV', 'development'),

  databaseUrl: requireEnv('DATABASE_URL'),
  redisUrl: requireEnv('REDIS_URL'),

  paymentGatewayUrl: optionalEnv('PAYMENT_GATEWAY_URL', 'http://localhost:3001'),
  identityVerificationUrl: optionalEnv('IDENTITY_VERIFICATION_URL', 'http://localhost:3002'),

  antiSnipeWindowSecs: parseInt(optionalEnv('ANTI_SNIPE_WINDOW_SECS', '120'), 10),
  antiSnipeExtensionSecs: parseInt(optionalEnv('ANTI_SNIPE_EXTENSION_SECS', '120'), 10),

  rateLimitWindowMs: parseInt(optionalEnv('RATE_LIMIT_WINDOW_MS', '60000'), 10),
  rateLimitGlobalMax: parseInt(optionalEnv('RATE_LIMIT_GLOBAL_MAX', '60'), 10),
  rateLimitLotMax: parseInt(optionalEnv('RATE_LIMIT_LOT_MAX', '10'), 10),

  buyerPremiumPct: parseFloat(optionalEnv('BUYER_PREMIUM_PCT', '0.15')),
  settlementRetryMax: parseInt(optionalEnv('SETTLEMENT_RETRY_MAX', '3'), 10),
  settlementRetryBackoffMs: parseInt(optionalEnv('SETTLEMENT_RETRY_BACKOFF_MS', '3600000'), 10),

  idempotencyTtlSecs: parseInt(optionalEnv('IDEMPOTENCY_TTL_SECS', '3600'), 10),

  lotCloserIntervalMs: 5000,
  settlementIntervalMs: 10 * 60 * 1000,  // 10 minutes
  wsHeartbeatMs: 10000,
  wsPongTimeoutMs: 5000,
} as const;

export type Config = typeof config;
