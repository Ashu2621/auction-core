import * as http from 'http';
import * as url from 'url';

const PORT = parseInt(process.env.PORT ?? '3002', 10);

type Tier = 'basic' | 'verified' | 'premium';

const TIER_DEPOSIT: Record<Tier, number> = {
  basic: 0,
  verified: 50_000,    // $500
  premium: 100_000,    // $1,000
};

/**
 * Deterministic tier assignment based on bidder_id hash.
 * This ensures consistent results across requests for the same bidder.
 */
function getBidderTier(bidderId: string): Tier {
  const hash = bidderId
    .split('')
    .reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) & 0xffffffff, 0);
  const tiers: Tier[] = ['basic', 'verified', 'premium'];
  return tiers[Math.abs(hash) % tiers.length];
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url ?? '', true);

  // ── Health ────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // ── GET /verify?bidder_id={uuid}&auction_id={uuid} ─────────────────────
  if (req.method === 'GET' && parsed.pathname === '/verify') {
    const bidderId = parsed.query.bidder_id as string | undefined;

    if (!bidderId) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bidder_id_required' }));
      return;
    }

    // Simulate a small processing delay (50-100ms)
    const delay = 50 + Math.floor(Math.random() * 50);
    setTimeout(() => {
      const tier = getBidderTier(bidderId);
      const depositRequired = TIER_DEPOSIT[tier];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          eligible: true,
          tier,
          deposit_required_cents: depositRequired,
        })
      );
    }, delay);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[identity-verification] Mock listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
