import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool';
import { LotRow, BidRow, LotSnapshot } from '../types';

export async function lotRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/lots/:id
   * Returns a lot snapshot (never exposes reserve_price amount).
   */
  app.get<{ Params: { id: string } }>(
    '/lots/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { rows } = await pool.query<LotRow>(
        `SELECT id, auction_id, lot_number, title, category, description,
                current_bid, bid_count, status, closing_at, reserve_price, currency
         FROM lots WHERE id = $1`,
        [req.params.id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'lot_not_found' });
      }

      const lot = rows[0];
      return reply.send(buildSnapshot(lot));
    }
  );

  /**
   * GET /api/v1/lots/:id/bids
   * Paginated bid history — shows amounts and bidder display names only.
   * Query: limit=50&before_id=uuid
   */
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; before_id?: string };
  }>(
    '/lots/:id/bids',
    async (req, reply) => {
      const lotId = req.params.id;
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 100);
      const beforeId = req.query.before_id;

      let query: string;
      let params: unknown[];

      if (beforeId) {
        query = `
          SELECT b.id, b.amount, b.bid_type, b.placed_at,
                 bd.display_name AS bidder_display_name
          FROM bids b
          JOIN bidders bd ON bd.id = b.bidder_id
          WHERE b.lot_id = $1
            AND b.status = 'accepted'
            AND b.id < $2
          ORDER BY b.placed_at DESC
          LIMIT $3
        `;
        params = [lotId, beforeId, limit];
      } else {
        query = `
          SELECT b.id, b.amount, b.bid_type, b.placed_at,
                 bd.display_name AS bidder_display_name
          FROM bids b
          JOIN bidders bd ON bd.id = b.bidder_id
          WHERE b.lot_id = $1
            AND b.status = 'accepted'
          ORDER BY b.placed_at DESC
          LIMIT $2
        `;
        params = [lotId, limit];
      }

      const { rows } = await pool.query(query, params);

      return reply.send({
        bids: rows.map((r) => ({
          id: r.id,
          amount: parseInt(r.amount, 10),
          bid_type: r.bid_type,
          bidder_display_name: r.bidder_display_name,
          placed_at: r.placed_at,
        })),
      });
    }
  );

  /**
   * GET /api/v1/auctions/:id/lots
   * Paginated lot list for an auction with snapshots.
   * Query: status, category, page
   */
  app.get<{
    Params: { id: string };
    Querystring: { status?: string; category?: string; page?: string };
  }>(
    '/auctions/:id/lots',
    async (req, reply) => {
      const auctionId = req.params.id;
      const page = Math.max(1, parseInt(req.query.page ?? '1', 10));
      const pageSize = 20;
      const offset = (page - 1) * pageSize;

      const conditions = ['l.auction_id = $1'];
      const params: unknown[] = [auctionId];
      let paramIdx = 2;

      if (req.query.status) {
        conditions.push(`l.status = $${paramIdx++}`);
        params.push(req.query.status);
      }
      if (req.query.category) {
        conditions.push(`l.category = $${paramIdx++}`);
        params.push(req.query.category);
      }

      const where = conditions.join(' AND ');

      const [{ rows: lots }, { rows: countRows }] = await Promise.all([
        pool.query<LotRow>(
          `SELECT * FROM lots l WHERE ${where}
           ORDER BY l.lot_number ASC
           LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
          [...params, pageSize, offset]
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM lots l WHERE ${where}`,
          params
        ),
      ]);

      return reply.send({
        lots: lots.map(buildSnapshot),
        pagination: {
          page,
          page_size: pageSize,
          total: parseInt(countRows[0].count, 10),
          total_pages: Math.ceil(parseInt(countRows[0].count, 10) / pageSize),
        },
      });
    }
  );
}

function buildSnapshot(lot: LotRow): LotSnapshot {
  const currentBid = parseInt(lot.current_bid as unknown as string, 10);
  const reservePrice = lot.reserve_price
    ? parseInt(lot.reserve_price as unknown as string, 10)
    : null;

  return {
    id: lot.id,
    auction_id: lot.auction_id,
    lot_number: lot.lot_number,
    title: lot.title,
    category: lot.category,
    current_bid: currentBid,
    bid_count: lot.bid_count,
    status: lot.status,
    closing_at: lot.closing_at ? new Date(lot.closing_at).toISOString() : null,
    reserve_met: reservePrice !== null && currentBid >= reservePrice,
    currency: lot.currency,
  };
}
