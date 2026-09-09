import { buildApp, waitForInflightBids } from './app';
import { assertRuntimeConfig, config } from './config';
import { closePool } from './db/pool';
import { closeRedisClients, redisSubscriber } from './redis/client';
import { initBroadcaster } from './internal/websocket/broadcaster';
import { startLotCloser, stopLotCloser, waitForCurrentIteration } from './internal/settlement/lot-closer';
import { startSettlementEngine, stopSettlementEngine } from './internal/settlement/payment';

async function main(): Promise<void> {
  // Config is resolved lazily (see config.ts), so read the required variables
  // once here — a long-running server should fail at boot, not on the first
  // request that happens to need one.
  assertRuntimeConfig();

  const app = await buildApp();

  // Initialize WebSocket broadcaster with Redis subscriber
  initBroadcaster(redisSubscriber);

  // Start background jobs
  startLotCloser();
  startSettlementEngine();

  // Start HTTP server
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[server] AuctionCore listening on port ${config.port}`);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    console.log(`[server] ${signal} received — starting graceful shutdown`);

    // 1. Stop accepting new requests
    await app.close();

    // 2. Wait for in-flight bid transactions (max 10s)
    await Promise.race([
      waitForInflightBids(),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);

    // 3. Complete current lot-closer iteration
    stopLotCloser();
    stopSettlementEngine();
    await waitForCurrentIteration();

    // 4. Close infrastructure connections
    await closePool();
    await closeRedisClients();

    console.log('[server] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
