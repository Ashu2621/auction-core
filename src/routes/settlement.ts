import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool';
import { processInvoiceById } from '../internal/settlement/payment';

export async function settlementRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/auctions/:id/settlement
   * Aggregate settlement report for an auction.
   * Only accessible by the auction house operator (bearer token = auction_house_id).
   */
  app.get<{ Params: { id: string } }>(
    '/auctions/:id/settlement',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const auctionId = req.params.id;

      // Verify the requesting user is the auction house operator
      const operatorId = (req as unknown as { operatorId?: string }).operatorId;
      if (operatorId) {
        const { rows } = await pool.query(
          `SELECT 1 FROM auctions WHERE id = $1 AND auction_house_id = $2`,
          [auctionId, operatorId]
        );
        if (rows.length === 0) {
          return reply.code(403).send({ error: 'forbidden' });
        }
      }

      // Aggregate settlement data
      const { rows: summary } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE l.status = 'sold')           AS lots_sold,
           COUNT(*) FILTER (WHERE l.status = 'passed')         AS lots_passed,
           COUNT(*) FILTER (WHERE l.status IN ('open','closing')) AS lots_active,
           COUNT(*)                                             AS lots_total,
           COALESCE(SUM(si.hammer_price) FILTER (WHERE si.id IS NOT NULL), 0)  AS total_hammer_value,
           COALESCE(SUM(si.buyer_premium) FILTER (WHERE si.id IS NOT NULL), 0) AS total_buyer_premium,
           COALESCE(SUM(si.total_due) FILTER (WHERE si.id IS NOT NULL), 0)     AS total_due
         FROM lots l
         LEFT JOIN settlement_invoices si ON si.lot_id = l.id
         WHERE l.auction_id = $1`,
        [auctionId]
      );

      const { rows: invoices } = await pool.query(
        `SELECT
           l.lot_number, l.title, l.currency,
           l.sold_price,
           si.id AS invoice_id, si.hammer_price, si.buyer_premium, si.total_due,
           si.status AS invoice_status, si.payment_ref, si.due_date, si.paid_at,
           b.display_name AS winner_name
         FROM lots l
         LEFT JOIN settlement_invoices si ON si.lot_id = l.id
         LEFT JOIN bidders b ON b.id = si.bidder_id
         WHERE l.auction_id = $1
         ORDER BY l.lot_number ASC`,
        [auctionId]
      );

      const s = summary[0];
      return reply.send({
        auction_id: auctionId,
        summary: {
          lots_sold: parseInt(s.lots_sold, 10),
          lots_passed: parseInt(s.lots_passed, 10),
          lots_active: parseInt(s.lots_active, 10),
          lots_total: parseInt(s.lots_total, 10),
          total_hammer_value: parseInt(s.total_hammer_value, 10),
          total_buyer_premium: parseInt(s.total_buyer_premium, 10),
          total_realized_value: parseInt(s.total_due, 10),
        },
        lots: invoices.map((r) => ({
          lot_number: r.lot_number,
          title: r.title,
          currency: r.currency,
          sold_price: r.sold_price ? parseInt(r.sold_price, 10) : null,
          invoice: r.invoice_id
            ? {
                id: r.invoice_id,
                hammer_price: parseInt(r.hammer_price, 10),
                buyer_premium: parseInt(r.buyer_premium, 10),
                total_due: parseInt(r.total_due, 10),
                status: r.invoice_status,
                payment_ref: r.payment_ref,
                due_date: r.due_date,
                paid_at: r.paid_at,
                winner: r.winner_name,
              }
            : null,
        })),
      });
    }
  );

  /**
   * GET /api/v1/invoices/:id
   */
  app.get<{ Params: { id: string } }>(
    '/invoices/:id',
    async (req, reply) => {
      const { rows } = await pool.query(
        `SELECT si.*, b.display_name AS bidder_name, l.title AS lot_title
         FROM settlement_invoices si
         JOIN bidders b ON b.id = si.bidder_id
         JOIN lots l ON l.id = si.lot_id
         WHERE si.id = $1`,
        [req.params.id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'invoice_not_found' });
      }

      const inv = rows[0];
      return reply.send({
        ...inv,
        hammer_price: parseInt(inv.hammer_price, 10),
        buyer_premium: parseInt(inv.buyer_premium, 10),
        total_due: parseInt(inv.total_due, 10),
      });
    }
  );

  /**
   * POST /api/v1/invoices/:id/pay
   * Manually trigger payment processing for an invoice.
   */
  app.post<{ Params: { id: string } }>(
    '/invoices/:id/pay',
    async (req, reply) => {
      const invoiceId = req.params.id;

      const { rows } = await pool.query(
        `SELECT id, status, payment_ref FROM settlement_invoices WHERE id = $1`,
        [invoiceId]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'invoice_not_found' });
      }

      const inv = rows[0];
      if (inv.status === 'paid') {
        return reply.send({ status: 'already_paid', payment_ref: inv.payment_ref });
      }

      await processInvoiceById(invoiceId);

      const { rows: updated } = await pool.query(
        `SELECT status, payment_ref FROM settlement_invoices WHERE id = $1`,
        [invoiceId]
      );

      return reply.send(updated[0]);
    }
  );
}
