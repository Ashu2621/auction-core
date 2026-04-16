import * as http from 'http';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const DECLINE_RATE = parseFloat(process.env.DECLINE_RATE ?? '0.1');

const DECLINE_REASONS = [
  'insufficient_funds',
  'card_declined',
  'do_not_honour',
  'expired_card',
];

function makePaymentRef(): string {
  return `PAY-${Math.floor(Math.random() * 10_000_000).toString().padStart(7, '0')}`;
}

const server = http.createServer((req, res) => {
  // ── Health ────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', decline_rate: DECLINE_RATE }));
    return;
  }

  // ── POST /capture ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/capture') {
    // Validate bearer token
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body) as {
          invoice_id: string;
          bidder_id: string;
          amount_cents: number;
          currency: string;
          description: string;
        };

        if (!data.invoice_id || !data.bidder_id || !data.amount_cents) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing_required_fields' }));
          return;
        }

        // Simulate 10% decline rate
        if (Math.random() < DECLINE_RATE) {
          const reason = DECLINE_REASONS[Math.floor(Math.random() * DECLINE_REASONS.length)];
          res.writeHead(402, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'declined', decline_reason: reason }));
          return;
        }

        // Simulate processing delay (50-200ms)
        const delay = 50 + Math.floor(Math.random() * 150);
        setTimeout(() => {
          const paymentRef = makePaymentRef();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ payment_ref: paymentRef, status: 'approved' }));
        }, delay);

      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_json' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[payment-gateway] Mock listening on port ${PORT} (decline_rate=${DECLINE_RATE})`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
