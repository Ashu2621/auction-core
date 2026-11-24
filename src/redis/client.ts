import Redis from 'ioredis';
import { config } from '../config';

/**
 * Redis clients, created on first use rather than on import.
 *
 * DESIGN NOTE — why this is deferred.
 *
 * These used to be constructed while the module was being evaluated, with
 * `lazyConnect: false`. Two consequences followed, and both were felt in the
 * test suite rather than in production:
 *
 *   1. `config.redisUrl` was read at import time, so importing anything that
 *      transitively reached this file threw on a checkout with no REDIS_URL.
 *      The bid processor and the lot closer both import it, which is why
 *      tests/bid-processor.test.ts and tests/settlement.test.ts failed during
 *      collection rather than skipping cleanly.
 *
 *   2. A TCP connection was opened before a single test ran, and never closed
 *      by the tests that only wanted a pure function, so vitest was left with
 *      a live handle at the end of the run.
 *
 * Deferring construction fixes both without changing a single call site:
 * `import { redis }` still returns something you can call `.publish()` on. The
 * first property access builds the real client; every later access reuses it.
 *
 * The indirection is a Proxy rather than a `getRedis()` function purely to
 * keep the ten existing call sites untouched — several of them sit next to Lua
 * source that also spells `redis.call`, and mechanical renaming there is a
 * bug waiting to happen.
 */
function createClient(name: string): Redis {
  const client = new Redis(config.redisUrl, {
    // Connect on the first command, not on construction. Nothing here needs a
    // socket until something actually publishes or evaluates a script.
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    maxRetriesPerRequest: 3,
  });

  client.on('connect', () => console.log(`[redis:${name}] Connected`));
  client.on('error', (err) => console.error(`[redis:${name}] Error:`, err));
  client.on('reconnecting', () => console.log(`[redis:${name}] Reconnecting...`));

  return client;
}

/** Every client actually constructed, so shutdown can close exactly those. */
const liveClients: Redis[] = [];

function lazyClient(name: string): Redis {
  let instance: Redis | null = null;

  const resolve = (): Redis => {
    if (instance === null) {
      instance = createClient(name);
      liveClients.push(instance);
    }
    return instance;
  };

  return new Proxy({} as Redis, {
    get(_target, prop, receiver) {
      const target = resolve();
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_target, prop, value) {
      return Reflect.set(resolve(), prop, value);
    },
    has(_target, prop) {
      return Reflect.has(resolve(), prop);
    },
  });
}

/** Main client for commands. */
export const redis = lazyClient('main');

/** Dedicated subscriber client (cannot issue regular commands while subscribed). */
export const redisSubscriber = lazyClient('subscriber');

/**
 * Close only the clients that were actually built.
 *
 * Shutdown used to call `redis.quit()` unconditionally. Through the Proxy that
 * would construct a connection for the sole purpose of closing it — and on a
 * host with no Redis reachable, hang while doing so.
 */
export async function closeRedisClients(): Promise<void> {
  await Promise.allSettled(liveClients.map((c) => c.quit()));
  liveClients.length = 0;
}
