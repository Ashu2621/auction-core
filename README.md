<<<<<<< HEAD
# AuctionCore — Real-Time Auction Engine API

A production-grade TypeScript/Node.js backend implementing a white-label English ascending-bid auction engine. Designed to replace a broken Node.js monolith with correct atomicity, idempotency, server-side anti-sniping, proxy bidding, and real-time WebSocket broadcasting.

---

## Prerequisites

Before running the project you need:

| Tool | Version | Install |
|---|---|---|
| **Docker** | 20+ | https://docs.docker.com/get-docker/ |
| **Docker Compose** | v2+ (ships with Docker Desktop) | included with Docker |
| **Node.js** | 20+ | https://nodejs.org or `nvm install 20` |
| **npm** | 9+ | ships with Node.js |

Optional (for testing WebSockets):
```bash
npm install -g wscat
```

---

## Quick Start (Docker — Recommended)

```bash
# 1. Clone / navigate to the project directory
cd weberInnovations

# 2. Copy environment config
cp .env.example .env

# 3. Start all services (PostgreSQL, Redis, mock services, API)
docker-compose up --build

# The app will:
#   - Start PostgreSQL 15 on port 5432
#   - Start Redis 7 on port 6379
#   - Start Payment Gateway mock on port 3001
#   - Start Identity Verification mock on port 3002
#   - Run DB migrations automatically
#   - Start the AuctionCore API on port 3000
```

**Verify it's running:**
```bash
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"..."}
```

---

## Local Development (without Docker for the app)

```bash
# 1. Start only infrastructure (Postgres + Redis + mock services)
docker-compose up postgres redis payment-gateway identity-verification -d

# 2. Install Node.js dependencies
npm install

# 3. Copy environment config
cp .env.example .env
# .env already has localhost URLs for local development

# 4. Run database migrations
npm run migrate

# 5. Seed test data (optional but recommended)
npm run seed

# 6. Start the development server with hot-reload
npm run dev
# → AuctionCore listening on port 3000
```

---

## Run Tests

```bash
# Make sure PostgreSQL is running (see above)

# Run all tests
npm test

# Run with coverage report (target: ≥75%)
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

Test database uses the same `DATABASE_URL` from `.env`. Tests create isolated fixtures and clean up after themselves.

---

## Seed Data

The seed script creates realistic auction data:
```bash
npm run seed

# Creates:
#   6  auction houses (Christie's, Sotheby's, Bonhams, etc.)
#   22 auctions (mix of live, scheduled, closed, preview)
#  ~200 lots across auctions
#  500 bidders with varied verification tiers
# 2000+ historical bids with realistic increment patterns
#  Settlement invoices for sold lots
```

---

## Example Workflow

### 1. Create a bidder
```bash
curl -X POST http://localhost:3000/api/v1/bidders \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","display_name":"Alice Smith"}'

# Response: { "id": "<BIDDER_UUID>", "email": "...", ... }
export BIDDER_ID="<BIDDER_UUID>"
```

### 2. Find a live auction
```bash
curl "http://localhost:3000/api/v1/auctions?status=live"
export AUCTION_ID="<AUCTION_UUID>"
```

### 3. Register the bidder for the auction
```bash
curl -X POST http://localhost:3000/api/v1/bidders/${BIDDER_ID}/register \
  -H "Authorization: Bearer ${BIDDER_ID}" \
  -H "Content-Type: application/json" \
  -d "{\"auction_id\":\"${AUCTION_ID}\"}"
```

### 4. Browse available lots
```bash
curl "http://localhost:3000/api/v1/auctions/${AUCTION_ID}/lots?status=open"
export LOT_ID="<LOT_UUID>"

# Check current bid
curl http://localhost:3000/api/v1/lots/${LOT_ID}
```

### 5. Submit a live bid (with idempotency key)
```bash
curl -X POST http://localhost:3000/api/v1/lots/${LOT_ID}/bids \
  -H "Authorization: Bearer ${BIDDER_ID}" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"amount_cents":11000,"bid_type":"live"}'

# Retry the SAME Idempotency-Key — returns cached response, no duplicate bid
```

### 6. Submit a proxy bid (auto-increment up to max)
```bash
curl -X POST http://localhost:3000/api/v1/lots/${LOT_ID}/bids \
  -H "Authorization: Bearer ${BIDDER_ID}" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"amount_cents":12000,"bid_type":"proxy","max_amount_cents":50000}'
```

### 7. Connect to real-time WebSocket feed
```bash
# Receive BID_ACCEPTED, ANTI_SNIPE, LOT_CLOSED events in real-time
wscat -c "ws://localhost:3000/ws/auctions/${AUCTION_ID}"
```

### 8. View settlement report (operator access)
```bash
# Use auction_house_id as the Bearer token for operator access
export AUCTION_HOUSE_ID="<AUCTION_HOUSE_UUID>"
curl http://localhost:3000/api/v1/auctions/${AUCTION_ID}/settlement \
  -H "Authorization: Bearer ${AUCTION_HOUSE_ID}"
```

### 9. View Prometheus metrics
```bash
curl http://localhost:3000/metrics
```

---

## API Reference

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/bidders` | — | Create bidder account |
| `GET` | `/api/v1/bidders/:id` | Bearer | Get bidder |
| `GET` | `/api/v1/bidders/:id/bids` | Bearer | Bidder's bid history |
| `POST` | `/api/v1/bidders/:id/register` | Bearer | Register for auction (calls identity verification) |
| `GET` | `/api/v1/auctions` | — | List auctions |
| `GET` | `/api/v1/auctions/:id` | — | Get auction details |
| `GET` | `/api/v1/auctions/:id/lots` | — | Paginated lots list |
| `POST` | `/api/v1/auctions/:id/open` | Bearer | Open auction (scheduled→live) |
| `POST` | `/api/v1/auctions/:id/pause` | Bearer | Pause live auction |
| `POST` | `/api/v1/auctions/:id/close` | Bearer | Close all lots |
| `GET` | `/api/v1/auctions/:id/settlement` | Operator | Settlement report |
| `GET` | `/api/v1/lots/:id` | — | Lot snapshot (reserve_met never reveals amount) |
| `GET` | `/api/v1/lots/:id/bids` | — | Bid history (paginated, display_name only) |
| `POST` | `/api/v1/lots/:id/bids` | Bearer + Idempotency-Key | **Submit bid** |
| `GET` | `/api/v1/invoices/:id` | Bearer | Get invoice |
| `POST` | `/api/v1/invoices/:id/pay` | Bearer | Trigger payment |
| `WS` | `/ws/auctions/:id` | — | Real-time auction events |
| `GET` | `/metrics` | — | Prometheus metrics |
| `GET` | `/health` | — | Health check |

### Bid Submission Response Codes

| Code | Meaning |
|---|---|
| `200` | Bid accepted (or idempotency replay) |
| `400` | Missing `Idempotency-Key` header |
| `403` | Bidder not registered or ineligible |
| `404` | Lot not found |
| `409` | Lot closed, concurrent request, or outbid |
| `422` | Below minimum increment |
| `429` | Rate limit exceeded (60/min global, 10/min per lot) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AuctionCore Service                               │
│                                                                             │
│  POST /api/v1/lots/:id/bids                                                 │
│       │                                                                     │
│       ├─► Rate Limiter (Redis sliding window, Lua atomic script)            │
│       │        └─► 429 if exceeded (global: 60/min, lot: 10/min)           │
│       │                                                                     │
│       ├─► Idempotency Middleware (bid_idempotency_keys + SKIP LOCKED)       │
│       │        ├─► 409 if in-flight (same key, concurrent request)         │
│       │        └─► 200 if cached (replayed response)                       │
│       │                                                                     │
│       └─► Bid Processor (single PostgreSQL transaction)                    │
│                │                                                            │
│                ├─► SELECT lots FOR UPDATE (exclusive lock)                 │
│                ├─► Validate status / bidder eligibility / increment        │
│                ├─► INSERT bid record                                        │
│                ├─► UPDATE lot (current_bid, winner, bid_count, version)    │
│                ├─► Anti-snipe: extend closing_at if within 2-min window    │
│                ├─► Proxy resolution loop (synchronous, in-transaction)     │
│                ├─► Append all events to auction_events (audit trail)       │
│                └─► COMMIT → Redis PUBLISH → WebSocket fan-out              │
│                                                                             │
│  Background Jobs:                                                           │
│    • Lot Closer (5s):  SELECT closing lots FOR UPDATE SKIP LOCKED           │
│                        → sold (reserve met) or passed                      │
│                        → creates invoice in same transaction               │
│    • Settlement (10m): process pending invoices via payment gateway        │
│                        retry 3× with 1h backoff, then mark overdue         │
│                                                                             │
│  WebSocket: ws://host/ws/auctions/:id                                      │
│    • Redis Pub/Sub fan-out (multi-instance safe)                           │
│    • Heartbeat ping/pong (10s ping, 5s pong timeout)                       │
└─────────────────────────────────────────────────────────────────────────────┘
         │                              │
    ┌────▼────┐                   ┌─────▼─────┐
    │Postgres │                   │  Redis 7  │
    │   15    │                   │           │
    │• lots   │                   │• rate lim │
    │• bids   │                   │• pub/sub  │
    │• events │                   └───────────┘
    └─────────┘
```

---

## Language Choice Rationale

**TypeScript (Node.js 20)** over Go for this project:

| Concern | Decision |
|---|---|
| **Concurrency** | Node.js async/await handles high bid-submission I/O well. Critical serialization happens in PostgreSQL (`SELECT FOR UPDATE`), not in app threads. |
| **Type Safety** | TypeScript's structural types catch domain errors at compile time (`BidType`, `LotStatus` unions prevent invalid state). |
| **Ecosystem** | `pg`, `ioredis`, `fastify`, `prom-client` are production-grade and battle-tested. |
| **Team** | AuctionCore's existing team is Node.js-native — a Go rewrite adds language upskilling overhead. |

Go would be better for CPU-intensive work; this is an I/O-bound auction engine.

---

## Idempotency Design

```
Phase 1: INSERT bid_idempotency_keys (key, bidder_id) with locked=TRUE
         ON CONFLICT DO NOTHING
         
         If inserted → we own a fresh lock, proceed to process bid
         If conflict:
           SELECT ... FOR UPDATE SKIP LOCKED
           ├─ 0 rows (SKIP LOCKED skipped it) → another request in-flight → 409
           ├─ locked=TRUE                     → processing              → 409
           └─ locked=FALSE                    → completed               → return cached response
           
Phase 2: Process bid in same transaction
         → INSERT bid, UPDATE lot, anti-snipe, proxy resolution, events

Phase 3: UPDATE idempotency key: locked=FALSE, store response_code + response_body

Error path: finally block force-unlocks the key so it never stays permanently locked
Expiry: expires_at = NOW() + 1 hour; hourly cleanup removes expired keys
```

---

## Anti-Sniping + Proxy Resolution

**Anti-snipe** runs server-side inside the transaction (not client-side):
- If `closing_at - NOW() < anti_snipe_window_secs` when bid is accepted:
  - `closing_at += anti_snipe_extension_secs`
  - lot status resets `closing → open`
  - `ANTI_SNIPE_TRIGGERED` event appended

**Proxy resolution** is synchronous within the same transaction:
```
while bid accepted and iterations < 50:
  find highest proxy bid WHERE max_amount > current_bid AND bidder != winner
  if none or proxy.max_amount < next_increment: break
  auto-increment proxy bidder to current_bid + increment
  mark previous winner's bid as outbid
  check anti-snipe again
  append PROXY_RESOLVED event
```
Loop terminates because `current_bid` strictly increases each iteration.

---

## Settlement Architecture

- **Event-driven** (not batch): Invoice created in the **same transaction** as lot closure — no Monday-morning timeout problem
- **Background payment job** runs every 10 minutes: captures payment via gateway mock
- **Retry**: up to 3 attempts with 1-hour backoff, then mark `overdue`
- **Idempotent**: payment skipped if `payment_ref` already set (prevents duplicate captures)

---

## WebSocket Fan-Out

All API instances subscribe to Redis Pub/Sub pattern `auction:*`. When a bid is committed:
1. `COMMIT` (DB transaction completes)
2. `PUBLISH auction:{auctionId} {message}` (best-effort, after commit)
3. Every instance's subscriber receives the message and fans it out to connected WebSocket clients

**If Redis goes down**: bids still process normally; WebSocket clients get no push updates but can poll `GET /lots/:id`. ioredis auto-reconnects.

---

## Prometheus Metrics

```
# Bid submission
bids_total{status="accepted|rejected_increment|rejected_closed|..."}
bid_processing_duration_seconds (target p95 < 150ms)

# Anti-snipe
anti_snipe_triggers_total

# Proxy bidding
proxy_resolutions_total

# Settlement
settlement_invoices_total{status="created|paid|overdue"}
settlement_payment_attempts_total{outcome="approved|declined|error"}

# Rate limiting
rate_limit_hits_total{bucket="global|lot"}

# WebSocket
websocket_connections_active (gauge)

# Idempotency
idempotency_replays_total
idempotency_conflicts_total

# Background jobs
lot_closer_iterations_total{outcome="processed|skipped|error"}
```

---

## Bid Increment Table

| Current Price | Increment |
|---|---|
| < $100 | $5 |
| $100 – $499 | $10 |
| $500 – $999 | $25 |
| $1,000 – $4,999 | $50 |
| $5,000 – $19,999 | $250 |
| $20,000 – $99,999 | $1,000 |
| ≥ $100,000 | $5,000 |

All amounts stored in cents (integers) to avoid floating-point precision issues.

---

## Project Structure

```
├── docker-compose.yml           # PostgreSQL 15 + Redis 7 + mock services + app
├── Dockerfile                   # Multi-stage build
├── entrypoint.sh                # Runs migrations then starts server
├── db/
│   ├── migrations/001_schema.sql  # Full DB schema (exact tables from spec)
│   └── migrate.ts               # Migration runner
├── mock-services/
│   ├── payment-gateway/         # POST /capture → 200|402 (10% decline rate)
│   └── identity-verification/   # GET /verify?bidder_id= → eligible + tier
├── seed/
│   └── seed.ts                  # 500 bidders, 22 auctions, 200+ lots, 2000+ bids
├── src/
│   ├── app.ts                   # Fastify app factory
│   ├── server.ts                # Entry point + graceful shutdown
│   ├── config.ts                # Environment config
│   ├── types/index.ts           # Domain types
│   ├── db/pool.ts               # PostgreSQL connection pool
│   ├── redis/client.ts          # ioredis clients (main + subscriber)
│   ├── metrics/index.ts         # Prometheus metrics
│   ├── internal/
│   │   ├── bidding/
│   │   │   ├── processor.ts     # Core atomic bid processing (★)
│   │   │   └── increment.ts     # Bid increment table function
│   │   ├── idempotency/
│   │   │   └── service.ts       # SKIP LOCKED idempotency middleware (★)
│   │   ├── ratelimit/
│   │   │   └── service.ts       # Redis sliding window (Lua) rate limiter (★)
│   │   ├── settlement/
│   │   │   ├── lot-closer.ts    # Background lot closer job (★)
│   │   │   └── payment.ts       # Payment processing + retry engine (★)
│   │   └── websocket/
│   │       └── broadcaster.ts   # Redis Pub/Sub → WebSocket fan-out (★)
│   └── routes/
│       ├── bids.ts              # POST /lots/:id/bids
│       ├── lots.ts              # GET /lots/:id + bid history
│       ├── auctions.ts          # Auction lifecycle endpoints
│       ├── bidders.ts           # Bidder registration
│       ├── settlement.ts        # Settlement report + invoice management
│       ├── websocket.ts         # ws://host/ws/auctions/:id
│       └── metrics.ts           # GET /metrics
└── tests/
    ├── bid-processor.test.ts    # Atomicity, anti-snipe, proxy, concurrency
    ├── idempotency.test.ts      # Lock acquisition, replay, concurrent requests
    └── settlement.test.ts       # Lot closer, invoice generation, SKIP LOCKED
```
=======
# auction-core
Distributed auction engine with atomic bid processing, idempotency, anti-sniping, and proxy bidding (Node.js + TypeScript)
>>>>>>> f0371570c82226643046d8f97aa66e9c11a1a233
