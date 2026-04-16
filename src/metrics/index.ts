import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

export const registry = new Registry();

// Collect default Node.js metrics (event loop lag, memory, etc.)
collectDefaultMetrics({ register: registry });

// ── Bid Metrics ───────────────────────────────────────────────────────────────

export const bidsTotal = new Counter({
  name: 'bids_total',
  help: 'Total number of bid submissions by final status',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const bidProcessingDuration = new Histogram({
  name: 'bid_processing_duration_seconds',
  help: 'Duration of bid processing from receipt to DB commit (p95 target < 150ms)',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1.0, 2.5],
  registers: [registry],
});

// ── Anti-Snipe Metrics ────────────────────────────────────────────────────────

export const antiSnipeTriggersTotal = new Counter({
  name: 'anti_snipe_triggers_total',
  help: 'Total number of anti-snipe extensions triggered',
  registers: [registry],
});

// ── Proxy Resolution Metrics ──────────────────────────────────────────────────

export const proxyResolutionsTotal = new Counter({
  name: 'proxy_resolutions_total',
  help: 'Total number of proxy bid auto-increments resolved',
  registers: [registry],
});

// ── Settlement Metrics ────────────────────────────────────────────────────────

export const settlementInvoicesTotal = new Counter({
  name: 'settlement_invoices_total',
  help: 'Total settlement invoices created or transitioned by status',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const settlementPaymentAttemptsTotal = new Counter({
  name: 'settlement_payment_attempts_total',
  help: 'Payment capture attempts to the payment gateway',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

// ── Rate Limit Metrics ────────────────────────────────────────────────────────

export const rateLimitHitsTotal = new Counter({
  name: 'rate_limit_hits_total',
  help: 'Total bid submissions rejected by rate limiting',
  labelNames: ['bucket'] as const,  // global | lot
  registers: [registry],
});

// ── WebSocket Metrics ─────────────────────────────────────────────────────────

export const wsConnectionsActive = new Gauge({
  name: 'websocket_connections_active',
  help: 'Number of currently active WebSocket connections',
  registers: [registry],
});

// ── Idempotency Metrics ───────────────────────────────────────────────────────

export const idempotencyReplaysTotal = new Counter({
  name: 'idempotency_replays_total',
  help: 'Total idempotency key cache hits (replayed responses)',
  registers: [registry],
});

export const idempotencyConflictsTotal = new Counter({
  name: 'idempotency_conflicts_total',
  help: 'Total concurrent in-flight requests rejected via idempotency lock',
  registers: [registry],
});

// ── Lot Closer Metrics ────────────────────────────────────────────────────────

export const lotCloserIterationsTotal = new Counter({
  name: 'lot_closer_iterations_total',
  help: 'Total lot-closer background job iterations',
  labelNames: ['outcome'] as const,  // processed | skipped | error
  registers: [registry],
});
