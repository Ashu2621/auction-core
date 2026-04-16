import { FastifyInstance } from 'fastify';
import { registry } from '../metrics';

export async function metricsRoute(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    const metrics = await registry.metrics();
    reply.header('Content-Type', registry.contentType);
    return reply.send(metrics);
  });
}
