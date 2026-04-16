import Redis from 'ioredis';
import { config } from '../config';

function createClient(name: string): Redis {
  const client = new Redis(config.redisUrl, {
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    maxRetriesPerRequest: 3,
  });

  client.on('connect', () => console.log(`[redis:${name}] Connected`));
  client.on('error', (err) => console.error(`[redis:${name}] Error:`, err));
  client.on('reconnecting', () => console.log(`[redis:${name}] Reconnecting...`));

  return client;
}

// Main client for commands
export const redis = createClient('main');

// Dedicated subscriber client (cannot issue regular commands while subscribed)
export const redisSubscriber = createClient('subscriber');
