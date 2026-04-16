import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool, withTransaction } from '../db/pool';
import { config } from '../config';
import { IdentityVerificationResponse } from '../types';

export async function bidderRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/bidders/:id/register
   * Register a bidder for an auction.
   * Calls the identity verification mock service.
   * Body: { auction_id }
   */
  app.post<{ Params: { id: string }; Body: { auction_id: string } }>(
    '/bidders/:id/register',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { auction_id: string } }>, reply: FastifyReply) => {
      const bidderId = req.params.id;
      const { auction_id } = req.body;

      if (!auction_id) {
        return reply.code(422).send({ error: 'auction_id_required' });
      }

      // Verify bidder exists
      const { rows: bidderRows } = await pool.query(
        `SELECT id, email FROM bidders WHERE id = $1`,
        [bidderId]
      );
      if (bidderRows.length === 0) {
        return reply.code(404).send({ error: 'bidder_not_found' });
      }

      // Verify auction exists and is accepting registrations
      const { rows: auctionRows } = await pool.query(
        `SELECT id, require_verification, status FROM auctions WHERE id = $1`,
        [auction_id]
      );
      if (auctionRows.length === 0) {
        return reply.code(404).send({ error: 'auction_not_found' });
      }

      const auction = auctionRows[0];
      if (['closed', 'settled', 'cancelled'].includes(auction.status)) {
        return reply.code(409).send({ error: 'auction_not_accepting_registrations' });
      }

      // Call identity verification mock
      let verificationResult: IdentityVerificationResponse;
      try {
        const res = await fetch(
          `${config.identityVerificationUrl}/verify?bidder_id=${bidderId}&auction_id=${auction_id}`,
          { signal: AbortSignal.timeout(5000) }
        );
        verificationResult = (await res.json()) as IdentityVerificationResponse;
      } catch (err) {
        console.error('[register] Identity verification call failed:', err);
        return reply.code(503).send({ error: 'identity_verification_unavailable' });
      }

      // Upsert registration
      await withTransaction(async (client) => {
        // Update bidder tier based on verification result
        await client.query(
          `UPDATE bidders SET verification_tier = $1 WHERE id = $2`,
          [verificationResult.tier, bidderId]
        );

        // Create/update registration
        await client.query(
          `INSERT INTO auction_registrations
             (auction_id, bidder_id, deposit_held, is_eligible)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (auction_id, bidder_id)
           DO UPDATE SET
             deposit_held = EXCLUDED.deposit_held,
             is_eligible = EXCLUDED.is_eligible`,
          [
            auction_id,
            bidderId,
            verificationResult.deposit_required_cents,
            verificationResult.eligible,
          ]
        );
      });

      return reply.send({
        auction_id,
        bidder_id: bidderId,
        eligible: verificationResult.eligible,
        tier: verificationResult.tier,
        deposit_required_cents: verificationResult.deposit_required_cents,
      });
    }
  );

  /**
   * GET /api/v1/bidders/:id
   */
  app.get<{ Params: { id: string } }>(
    '/bidders/:id',
    async (req, reply) => {
      const { rows } = await pool.query(
        `SELECT id, email, display_name, verification_tier, paddle_number, created_at
         FROM bidders WHERE id = $1`,
        [req.params.id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'bidder_not_found' });
      }

      return reply.send(rows[0]);
    }
  );

  /**
   * GET /api/v1/bidders/:id/bids
   */
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/bidders/:id/bids',
    async (req, reply) => {
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 100);

      const { rows } = await pool.query(
        `SELECT b.id, b.lot_id, b.bid_type, b.amount, b.status, b.placed_at,
                l.title AS lot_title, l.currency
         FROM bids b
         JOIN lots l ON l.id = b.lot_id
         WHERE b.bidder_id = $1
         ORDER BY b.placed_at DESC
         LIMIT $2`,
        [req.params.id, limit]
      );

      return reply.send({
        bids: rows.map((r) => ({
          ...r,
          amount: parseInt(r.amount, 10),
        })),
      });
    }
  );

  /**
   * POST /api/v1/bidders
   * Create a new bidder account.
   */
  app.post<{ Body: { email: string; display_name: string; paddle_number?: string } }>(
    '/bidders',
    async (req, reply) => {
      const { email, display_name, paddle_number } = req.body;

      if (!email || !display_name) {
        return reply.code(422).send({ error: 'email_and_display_name_required' });
      }

      try {
        const { rows } = await pool.query(
          `INSERT INTO bidders (email, display_name, paddle_number)
           VALUES ($1, $2, $3)
           RETURNING id, email, display_name, verification_tier, created_at`,
          [email, display_name, paddle_number ?? null]
        );
        return reply.code(201).send(rows[0]);
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          return reply.code(409).send({ error: 'email_already_registered' });
        }
        throw err;
      }
    }
  );
}
