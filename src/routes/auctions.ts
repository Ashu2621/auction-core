import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool, withTransaction } from '../db/pool';
import { AuctionRow } from '../types';

export async function auctionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/auctions/:id/open
   * Transitions auction from scheduled → live, opens all pending lots.
   */
  app.post<{ Params: { id: string } }>(
    '/auctions/:id/open',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const auctionId = req.params.id;

      try {
        await withTransaction(async (client) => {
          const { rows } = await client.query<AuctionRow>(
            `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
            [auctionId]
          );

          if (rows.length === 0) {
            throw Object.assign(new Error('auction_not_found'), { statusCode: 404 });
          }

          const auction = rows[0];
          if (auction.status !== 'scheduled' && auction.status !== 'preview') {
            throw Object.assign(new Error('invalid_transition'), {
              statusCode: 409,
              current: auction.status,
            });
          }

          await client.query(
            `UPDATE auctions SET status = 'live', actual_start = NOW() WHERE id = $1`,
            [auctionId]
          );

          await client.query(
            `UPDATE lots
             SET status = 'open',
                 closing_at = $1
             WHERE auction_id = $2 AND status = 'pending'`,
            [auction.scheduled_end, auctionId]
          );

          await client.query(
            `INSERT INTO auction_events (lot_id, event_type, payload)
             SELECT id, 'LOT_OPENED', '{"triggered_by": "auction_open"}'
             FROM lots
             WHERE auction_id = $1 AND status = 'open'`,
            [auctionId]
          );
        });

        return reply.send({ status: 'live' });
      } catch (err: unknown) {
        const e = err as Error & { statusCode?: number; current?: string };
        if (e.statusCode) {
          return reply.code(e.statusCode).send({ error: e.message, current: e.current });
        }
        throw err;
      }
    }
  );

  /**
   * POST /api/v1/auctions/:id/pause
   * live → paused
   */
  app.post<{ Params: { id: string } }>(
    '/auctions/:id/pause',
    async (req, reply) => {
      try {
        await withTransaction(async (client) => {
          const { rows } = await client.query<AuctionRow>(
            `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
            [req.params.id]
          );

          if (rows.length === 0) {
            throw Object.assign(new Error('auction_not_found'), { statusCode: 404 });
          }

          if (rows[0].status !== 'live') {
            throw Object.assign(new Error('not_live'), { statusCode: 409, current: rows[0].status });
          }

          await client.query(
            `UPDATE auctions SET status = 'paused' WHERE id = $1`,
            [req.params.id]
          );
        });

        return reply.send({ status: 'paused' });
      } catch (err: unknown) {
        const e = err as Error & { statusCode?: number };
        if (e.statusCode) return reply.code(e.statusCode).send({ error: e.message });
        throw err;
      }
    }
  );

  /**
   * POST /api/v1/auctions/:id/close
   * Closes all open/closing lots, transitions auction to closed.
   */
  app.post<{ Params: { id: string } }>(
    '/auctions/:id/close',
    async (req, reply) => {
      try {
        await withTransaction(async (client) => {
          const { rows } = await client.query<AuctionRow>(
            `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
            [req.params.id]
          );

          if (rows.length === 0) {
            throw Object.assign(new Error('auction_not_found'), { statusCode: 404 });
          }

          // Move all open lots to closing with closing_at = NOW()
          // Lot-closer will pick them up on next 5-second cycle
          await client.query(
            `UPDATE lots
             SET status = 'closing', closing_at = NOW()
             WHERE auction_id = $1 AND status = 'open'`,
            [req.params.id]
          );

          await client.query(
            `UPDATE auctions
             SET status = 'closed', actual_end = NOW()
             WHERE id = $1`,
            [req.params.id]
          );
        });

        return reply.send({ status: 'closed' });
      } catch (err: unknown) {
        const e = err as Error & { statusCode?: number };
        if (e.statusCode) return reply.code(e.statusCode).send({ error: e.message });
        throw err;
      }
    }
  );

  /**
   * GET /api/v1/auctions/:id
   */
  app.get<{ Params: { id: string } }>(
    '/auctions/:id',
    async (req, reply) => {
      const { rows } = await pool.query(
        `SELECT a.*, ah.name AS auction_house_name, ah.slug AS auction_house_slug,
                ah.buyer_premium_pct
         FROM auctions a
         JOIN auction_houses ah ON ah.id = a.auction_house_id
         WHERE a.id = $1`,
        [req.params.id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'auction_not_found' });
      }

      return reply.send(rows[0]);
    }
  );

  /**
   * GET /api/v1/auctions
   */
  app.get<{ Querystring: { status?: string; page?: string } }>(
    '/auctions',
    async (req, reply) => {
      const page = Math.max(1, parseInt(req.query.page ?? '1', 10));
      const limit = 20;
      const offset = (page - 1) * limit;

      const params: unknown[] = [];
      let where = '';

      if (req.query.status) {
        params.push(req.query.status);
        where = `WHERE a.status = $1`;
      }

      const { rows } = await pool.query(
        `SELECT a.*, ah.name AS auction_house_name
         FROM auctions a
         JOIN auction_houses ah ON ah.id = a.auction_house_id
         ${where}
         ORDER BY a.scheduled_start DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params
      );

      return reply.send({ auctions: rows });
    }
  );
}
