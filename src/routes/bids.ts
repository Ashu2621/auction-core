import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { processBid } from '../internal/bidding/processor';
import { checkRateLimit } from '../internal/ratelimit/service';
import { BidError, BidRequest } from '../types';

interface BidBody {
  amount_cents: number;
  bid_type: 'live' | 'proxy';
  max_amount_cents?: number;
}

interface BidParams {
  id: string;
}

export async function bidRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/lots/:id/bids
   *
   * Submit a bid on a lot.
   * Requires:
   *   - Idempotency-Key header
   *   - Authorization: Bearer {bidder_id}
   */
  app.post<{ Params: BidParams; Body: BidBody }>(
    '/lots/:id/bids',
    async (req: FastifyRequest<{ Params: BidParams; Body: BidBody }>, reply: FastifyReply) => {
      // ── Auth ──────────────────────────────────────────────────────────────
      const bidderId = (req as unknown as { bidderId: string }).bidderId;
      if (!bidderId) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      // ── Idempotency key required ──────────────────────────────────────────
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      if (!idempotencyKey) {
        return reply.code(400).send({ error: 'idempotency_key_required' });
      }

      const lotId = req.params.id;
      const { amount_cents, bid_type, max_amount_cents } = req.body;

      // ── Input validation ──────────────────────────────────────────────────
      if (!amount_cents || amount_cents <= 0) {
        return reply.code(422).send({ error: 'invalid_amount', message: 'amount_cents must be positive' });
      }

      if (!['live', 'proxy'].includes(bid_type)) {
        return reply.code(422).send({ error: 'invalid_bid_type', message: 'bid_type must be live or proxy' });
      }

      // ── Rate limiting ─────────────────────────────────────────────────────
      const rateLimit = await checkRateLimit(bidderId, lotId);
      if (!rateLimit.allowed) {
        const resetEpoch = Math.ceil(rateLimit.resetMs / 1000);
        reply.headers({
          'X-RateLimit-Limit': String(rateLimit.limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(resetEpoch),
          'Retry-After': String(rateLimit.retryAfterSecs ?? 1),
        });
        return reply.code(429).send({
          error: 'rate_limit_exceeded',
          bucket: rateLimit.bucket,
          retry_after_secs: rateLimit.retryAfterSecs,
        });
      }

      // ── Process bid ───────────────────────────────────────────────────────
      const bidReq: BidRequest = {
        lotId,
        bidderId,
        amountCents: amount_cents,
        bidType: bid_type,
        maxAmountCents: max_amount_cents,
        idempotencyKey,
      };

      try {
        const result = await processBid(bidReq);

        reply.headers({
          'X-RateLimit-Limit': String(rateLimit.limit),
          'X-RateLimit-Remaining': String(rateLimit.remaining),
          'X-RateLimit-Reset': String(Math.ceil(rateLimit.resetMs / 1000)),
        });

        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof BidError) {
          return mapBidError(reply, err);
        }
        throw err;
      }
    }
  );
}

function mapBidError(reply: FastifyReply, err: BidError): FastifyReply {
  switch (err.code) {
    case 'rejected_closed':
    case 'lot_closed':
    case 'lot_not_active':
      return reply.code(409).send({ error: err.code });

    case 'concurrent_request':
    case 'in_flight':
      return reply.code(409).send({ error: 'concurrent_request' });

    case 'rejected_increment':
    case 'below_increment':
      return reply.code(422).send({
        error: 'below_increment',
        minimum: err.extra?.minimum,
        current_bid: err.extra?.current_bid,
      });

    case 'rejected_ineligible':
    case 'not_registered':
      return reply.code(403).send({ error: err.code });

    case 'proxy_not_allowed':
    case 'invalid_proxy_bid':
      return reply.code(422).send({ error: err.code, message: err.message });

    case 'lot_not_found':
      return reply.code(404).send({ error: 'lot_not_found' });

    default:
      return reply.code(err.statusCode || 500).send({
        error: err.code,
        message: err.message,
        ...err.extra,
      });
  }
}
