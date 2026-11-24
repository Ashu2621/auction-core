import { Pool, PoolClient } from 'pg';
import { config } from '../config';

/**
 * The connection pool, created on first use rather than on import.
 *
 * DESIGN NOTE — same reasoning as src/redis/client.ts.
 *
 * `new Pool({ connectionString: config.databaseUrl })` at module scope reads a
 * required environment variable while the module is being evaluated, so any
 * import that transitively reached this file threw on a checkout without
 * DATABASE_URL. tests/settlement.test.ts imports the lot closer, which imports
 * this — so the suite failed during collection instead of skipping the
 * integration tests it cannot run.
 *
 * Deferring construction keeps `import { pool }` working unchanged while
 * making the module safe to import without a database configured. `pg` already
 * connects lazily per query, so nothing opens a socket until a query is made.
 */
let instance: Pool | null = null;

function resolvePool(): Pool {
  if (instance === null) {
    instance = new Pool({
      connectionString: config.databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    instance.on('error', (err) => {
      console.error('[db] Unexpected pool error:', err);
    });
  }
  return instance;
}

export const pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const target = resolvePool();
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
  set(_target, prop, value) {
    return Reflect.set(resolvePool(), prop, value);
  },
  has(_target, prop) {
    return Reflect.has(resolvePool(), prop);
  },
});

/** True when a pool was actually constructed — shutdown uses this so that
 *  closing does not itself open one. */
export function hasLivePool(): boolean {
  return instance !== null;
}

export async function closePool(): Promise<void> {
  if (instance !== null) {
    await instance.end();
    instance = null;
  }
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
