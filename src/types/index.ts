// ── Domain Types ──────────────────────────────────────────────────────────────

export type AuctionStatus =
  | 'scheduled'
  | 'preview'
  | 'live'
  | 'paused'
  | 'closing'
  | 'closed'
  | 'settled'
  | 'cancelled';

export type LotStatus = 'pending' | 'open' | 'closing' | 'sold' | 'passed' | 'withdrawn';

export type BidType = 'live' | 'proxy' | 'auto_increment';

export type BidStatus =
  | 'accepted'
  | 'outbid'
  | 'rejected_reserve'
  | 'rejected_closed'
  | 'rejected_increment'
  | 'rejected_ineligible';

export type VerificationTier = 'basic' | 'verified' | 'premium';

export type InvoiceStatus = 'pending' | 'sent' | 'paid' | 'overdue' | 'disputed' | 'cancelled';

// ── Database Row Types ────────────────────────────────────────────────────────

export interface AuctionHouseRow {
  id: string;
  name: string;
  slug: string;
  currency: string;
  buyer_premium_pct: string; // pg returns DECIMAL as string
  created_at: Date;
}

export interface AuctionRow {
  id: string;
  auction_house_id: string;
  title: string;
  status: AuctionStatus;
  scheduled_start: Date;
  scheduled_end: Date;
  actual_start: Date | null;
  actual_end: Date | null;
  anti_snipe_window_secs: number;
  anti_snipe_extension_secs: number;
  allow_proxy_bids: boolean;
  require_verification: boolean;
  version: number;
  created_at: Date;
}

export interface LotRow {
  id: string;
  auction_id: string;
  lot_number: string;
  title: string;
  description: string | null;
  category: string | null;
  starting_bid: string; // pg returns BIGINT as string
  reserve_price: string | null;
  current_bid: string;
  current_winner_id: string | null;
  bid_count: number;
  status: LotStatus;
  closing_at: Date | null;
  sold_at: Date | null;
  sold_price: string | null;
  currency: string;
  version: number;
}

export interface BidderRow {
  id: string;
  email: string;
  display_name: string;
  verification_tier: VerificationTier;
  paddle_number: string | null;
  created_at: Date;
}

export interface BidRow {
  id: string;
  lot_id: string;
  bidder_id: string;
  bid_type: BidType;
  amount: string; // BIGINT
  max_amount: string | null;
  status: BidStatus;
  idempotency_key: string | null;
  placed_at: Date;
  processed_at: Date | null;
  outbid_at: Date | null;
}

export interface AuctionRegistrationRow {
  auction_id: string;
  bidder_id: string;
  registered_at: Date;
  deposit_held: string | null;
  is_eligible: boolean;
}

export interface InvoiceRow {
  id: string;
  auction_id: string;
  bidder_id: string;
  lot_id: string;
  hammer_price: string;
  buyer_premium: string;
  total_due: string;
  currency: string;
  status: InvoiceStatus;
  payment_ref: string | null;
  retry_count: number;
  next_retry_at: Date | null;
  due_date: Date;
  paid_at: Date | null;
  created_at: Date;
}

// ── API Response Types ────────────────────────────────────────────────────────

export interface LotSnapshot {
  id: string;
  auction_id: string;
  lot_number: string;
  title: string;
  category: string | null;
  current_bid: number;  // in cents
  bid_count: number;
  status: LotStatus;
  closing_at: string | null;
  reserve_met: boolean;  // never reveals reserve_price amount
  currency: string;
}

export interface BidEntry {
  id: string;
  amount: number;
  bid_type: BidType;
  bidder_display_name: string;
  placed_at: string;
}

// ── Bid Processing ─────────────────────────────────────────────────────────────

export interface BidRequest {
  lotId: string;
  bidderId: string;
  amountCents: number;
  bidType: BidType;
  maxAmountCents?: number;
  idempotencyKey: string;
}

export interface BidResult {
  bid: BidResponseItem;
  lot: LotSnapshot;
  proxy_resolved?: BidResponseItem[];
}

export interface BidResponseItem {
  id: string;
  lot_id: string;
  bidder_id: string;
  bid_type: BidType;
  amount: number;
  max_amount: number | null;
  status: BidStatus;
  placed_at: string;
  processed_at: string | null;
}

// ── WebSocket Messages ─────────────────────────────────────────────────────────

export type WsMessageType =
  | 'BID_ACCEPTED'
  | 'ANTI_SNIPE'
  | 'LOT_CLOSED'
  | 'HEARTBEAT';

export interface WsBidAccepted {
  type: 'BID_ACCEPTED';
  lot_id: string;
  new_current_bid: number;
  bid_count: number;
  closing_at: string | null;
  reserve_met: boolean;
}

export interface WsAntiSnipe {
  type: 'ANTI_SNIPE';
  lot_id: string;
  new_closing_at: string;
}

export interface WsLotClosed {
  type: 'LOT_CLOSED';
  lot_id: string;
  status: 'sold' | 'passed';
  sold_price?: number;
}

export type WsMessage = WsBidAccepted | WsAntiSnipe | WsLotClosed;

// ── Rate Limiting ─────────────────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterSecs?: number;
  bucket?: 'global' | 'lot';
}

// ── Identity Verification ─────────────────────────────────────────────────────

export interface IdentityVerificationResponse {
  eligible: boolean;
  tier: VerificationTier;
  deposit_required_cents: number;
}

// ── Payment Gateway ───────────────────────────────────────────────────────────

export interface PaymentCaptureRequest {
  invoice_id: string;
  bidder_id: string;
  amount_cents: number;
  currency: string;
  description: string;
}

export interface PaymentCaptureResponse {
  payment_ref?: string;
  status: 'approved' | 'declined';
  decline_reason?: string;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class BidError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly extra?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'BidError';
  }
}
