-- AuctionCore Database Schema
-- Migration: 001_schema.sql
-- PostgreSQL 15

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Auction Houses ─────────────────────────────────────────────────────────────
CREATE TABLE auction_houses (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(255) NOT NULL,
  slug              VARCHAR(100) UNIQUE NOT NULL,
  currency          CHAR(3)     NOT NULL DEFAULT 'USD',
  buyer_premium_pct DECIMAL(5,4) NOT NULL DEFAULT 0.15,  -- 15% buyer's premium
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Auctions ───────────────────────────────────────────────────────────────────
CREATE TABLE auctions (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_house_id          UUID         NOT NULL REFERENCES auction_houses(id),
  title                     VARCHAR(255) NOT NULL,
  status                    VARCHAR(20)  NOT NULL,
  -- statuses: scheduled|preview|live|paused|closing|closed|settled|cancelled
  scheduled_start           TIMESTAMPTZ  NOT NULL,
  scheduled_end             TIMESTAMPTZ  NOT NULL,
  actual_start              TIMESTAMPTZ,
  actual_end                TIMESTAMPTZ,
  anti_snipe_window_secs    SMALLINT     NOT NULL DEFAULT 120,  -- 2 min
  anti_snipe_extension_secs SMALLINT     NOT NULL DEFAULT 120,
  allow_proxy_bids          BOOLEAN      NOT NULL DEFAULT TRUE,
  require_verification      BOOLEAN      NOT NULL DEFAULT FALSE,
  version                   INT          NOT NULL DEFAULT 1,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_auctions_status ON auctions(status);
CREATE INDEX idx_auctions_house ON auctions(auction_house_id);

-- ── Lots ───────────────────────────────────────────────────────────────────────
CREATE TABLE lots (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id       UUID         NOT NULL REFERENCES auctions(id),
  lot_number       VARCHAR(20)  NOT NULL,
  title            VARCHAR(255) NOT NULL,
  description      TEXT,
  category         VARCHAR(100),
  starting_bid     BIGINT       NOT NULL,             -- in cents
  reserve_price    BIGINT,                            -- NULL = no reserve; never revealed to bidders
  current_bid      BIGINT       NOT NULL,             -- in cents; starts at starting_bid
  current_winner_id UUID,
  bid_count        INT          NOT NULL DEFAULT 0,
  status           VARCHAR(20)  NOT NULL,
  -- statuses: pending|open|closing|sold|passed|withdrawn
  closing_at       TIMESTAMPTZ,                       -- may be extended by anti-snipe
  sold_at          TIMESTAMPTZ,
  sold_price       BIGINT,
  currency         CHAR(3)      NOT NULL,
  version          INT          NOT NULL DEFAULT 1,
  UNIQUE(auction_id, lot_number)
);

CREATE INDEX idx_lots_auction_status ON lots(auction_id, status);
CREATE INDEX idx_lots_closing ON lots(closing_at) WHERE status IN ('open', 'closing');
CREATE INDEX idx_lots_status ON lots(status);

-- ── Bidders ────────────────────────────────────────────────────────────────────
CREATE TABLE bidders (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             VARCHAR(255) UNIQUE NOT NULL,
  display_name      VARCHAR(100) NOT NULL,
  verification_tier VARCHAR(20) NOT NULL DEFAULT 'basic',
  paddle_number     VARCHAR(20),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bidders_email ON bidders(email);

-- ── Auction Registrations ──────────────────────────────────────────────────────
CREATE TABLE auction_registrations (
  auction_id    UUID        NOT NULL REFERENCES auctions(id),
  bidder_id     UUID        NOT NULL REFERENCES bidders(id),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deposit_held  BIGINT,                              -- security deposit in cents
  is_eligible   BOOLEAN     NOT NULL DEFAULT TRUE,
  PRIMARY KEY (auction_id, bidder_id)
);

CREATE INDEX idx_registrations_bidder ON auction_registrations(bidder_id);
CREATE INDEX idx_registrations_auction ON auction_registrations(auction_id);

-- ── Bids ───────────────────────────────────────────────────────────────────────
CREATE TABLE bids (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id          UUID        NOT NULL REFERENCES lots(id),
  bidder_id       UUID        NOT NULL REFERENCES bidders(id),
  bid_type        VARCHAR(20) NOT NULL,              -- live|proxy|auto_increment
  amount          BIGINT      NOT NULL,              -- in cents
  max_amount      BIGINT,                            -- proxy bid ceiling; NULL for live bids
  status          VARCHAR(30) NOT NULL,
  -- accepted|outbid|rejected_reserve|rejected_closed|rejected_increment|rejected_ineligible
  idempotency_key VARCHAR(255),
  placed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  outbid_at       TIMESTAMPTZ,
  CONSTRAINT bid_positive CHECK (amount > 0)
);

CREATE INDEX idx_bids_lot_status ON bids(lot_id, status);
CREATE INDEX idx_bids_bidder_lot ON bids(bidder_id, lot_id);
CREATE INDEX idx_bids_proxy_active ON bids(lot_id, max_amount DESC)
  WHERE bid_type = 'proxy' AND status = 'accepted';
CREATE INDEX idx_bids_idempotency ON bids(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── State Machine for Lot Status Transitions ──────────────────────────────────
CREATE TABLE lot_state_transitions (
  from_status VARCHAR(20) NOT NULL,
  to_status   VARCHAR(20) NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO lot_state_transitions VALUES
  ('pending',  'open'),
  ('open',     'closing'),
  ('open',     'withdrawn'),
  ('closing',  'sold'),
  ('closing',  'passed'),
  ('closing',  'open');   -- anti-snipe extension resets to open

CREATE OR REPLACE FUNCTION enforce_lot_state_machine() RETURNS trigger AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM lot_state_transitions
    WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'Invalid lot transition: % → %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lot_state_guard
  BEFORE UPDATE OF status ON lots
  FOR EACH ROW EXECUTE FUNCTION enforce_lot_state_machine();

-- ── Idempotency Keys for Bid Submission ───────────────────────────────────────
CREATE TABLE bid_idempotency_keys (
  key           VARCHAR(255) NOT NULL,
  bidder_id     UUID         NOT NULL,
  response_code INT          NOT NULL,
  response_body JSONB        NOT NULL,
  locked        BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '1 hour',
  PRIMARY KEY (key, bidder_id)
);

CREATE INDEX idx_idempotency_expiry ON bid_idempotency_keys(expires_at);

-- ── Event-Sourced Auction Events (Append-Only) ────────────────────────────────
CREATE TABLE auction_events (
  id          BIGSERIAL    PRIMARY KEY,
  lot_id      UUID         NOT NULL,
  event_type  VARCHAR(50)  NOT NULL,
  -- BID_PLACED, BID_ACCEPTED, BID_OUTBID, PROXY_RESOLVED, ANTI_SNIPE_TRIGGERED,
  -- LOT_OPENED, LOT_CLOSING, LOT_SOLD, LOT_PASSED, LOT_WITHDRAWN
  payload     JSONB        NOT NULL,
  occurred_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_lot ON auction_events(lot_id, occurred_at DESC);
CREATE INDEX idx_events_type ON auction_events(event_type);

-- ── Settlement Invoices ────────────────────────────────────────────────────────
CREATE TABLE settlement_invoices (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id    UUID        NOT NULL REFERENCES auctions(id),
  bidder_id     UUID        NOT NULL,
  lot_id        UUID        NOT NULL,
  hammer_price  BIGINT      NOT NULL,
  buyer_premium BIGINT      NOT NULL,
  total_due     BIGINT      NOT NULL,
  currency      CHAR(3)     NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- pending|sent|paid|overdue|disputed|cancelled
  payment_ref   VARCHAR(100),
  retry_count   INT         NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  due_date      DATE        NOT NULL,
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(lot_id)  -- one invoice per won lot
);

CREATE INDEX idx_invoices_pending ON settlement_invoices(status, next_retry_at)
  WHERE status IN ('pending', 'overdue');
CREATE INDEX idx_invoices_auction ON settlement_invoices(auction_id);
CREATE INDEX idx_invoices_bidder ON settlement_invoices(bidder_id);
