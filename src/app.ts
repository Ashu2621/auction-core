import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import FastifyCors from '@fastify/cors';
import FastifyWebsocket from '@fastify/websocket';

import { config } from './config';
import { bidRoutes } from './routes/bids';
import { lotRoutes } from './routes/lots';
import { auctionRoutes } from './routes/auctions';
import { bidderRoutes } from './routes/bidders';
import { settlementRoutes } from './routes/settlement';
import { websocketRoutes } from './routes/websocket';
import { metricsRoute } from './routes/metrics';

// Track in-flight bid requests for graceful shutdown
let inflightBids = 0;
const inflightWaiters: Array<() => void> = [];

export function incrementInflight(): void {
  inflightBids++;
}

export function decrementInflight(): void {
  inflightBids--;
  if (inflightBids === 0) {
    inflightWaiters.forEach((resolve) => resolve());
    inflightWaiters.length = 0;
  }
}

export function waitForInflightBids(): Promise<void> {
  if (inflightBids === 0) return Promise.resolve();
  return new Promise((resolve) => inflightWaiters.push(resolve));
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.nodeEnv === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    trustProxy: true,
    requestIdHeader: 'x-request-id',
  });

  // ── Plugins ────────────────────────────────────────────────────────────────
  await app.register(FastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  });

  await app.register(FastifyWebsocket, {
    options: {
      maxPayload: 1_048_576, // 1MB
    },
  });

  // ── Auth Hook ──────────────────────────────────────────────────────────────
  // Simple Bearer token auth: token is the bidder's UUID
  // For operator routes the token can be an auction_house_id
  app.addHook('preHandler', async (req: FastifyRequest, _reply: FastifyReply) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '').trim();
      // Attach to request for downstream handlers
      (req as unknown as Record<string, unknown>).bidderId = token;
      (req as unknown as Record<string, unknown>).operatorId = token;
    }
  });

  // ── Error Handler ──────────────────────────────────────────────────────────
  app.setErrorHandler((error, req, reply) => {
    // Handle structured errors from route handlers (Error with extra statusCode property)
    const statusCode = (error as Error & { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: error.message });
    }

    // PostgreSQL unique violation
    if ((error as { code?: string }).code === '23505') {
      return reply.code(409).send({ error: 'conflict', message: error.message });
    }

    app.log.error({ err: error, reqId: req.id }, 'Unhandled error');
    return reply.code(500).send({ error: 'internal_server_error' });
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  // Metrics exposed at root level (not under /api/v1)
  await app.register(metricsRoute);

  // WebSocket routes (not under /api/v1 prefix)
  await app.register(websocketRoutes);

  // REST API routes
  await app.register(async (api) => {
    await api.register(bidRoutes);
    await api.register(lotRoutes);
    await api.register(auctionRoutes);
    await api.register(bidderRoutes);
    await api.register(settlementRoutes);
  }, { prefix: '/api/v1' });

  // ── Health Check ───────────────────────────────────────────────────────────
  app.get('/health', async (_req, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}
