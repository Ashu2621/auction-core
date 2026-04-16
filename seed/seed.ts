/**
 * AuctionCore seed data script.
 *
 * Creates:
 *   - ≥5 auction houses
 *   - ≥20 auctions (mix of scheduled/live/closed)
 *   - ≥200 lots across the auctions
 *   - ≥500 bidders
 *   - ≥2,000 historical bids with realistic increment patterns
 *   - Auction registrations for bidders
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getMinimumNextBid } from '../src/internal/bidding/increment';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

// ── Data Generators ───────────────────────────────────────────────────────────

const AUCTION_HOUSES = [
  { name: 'Christie\'s Digital', slug: 'christies-digital', currency: 'USD', buyer_premium_pct: '0.1500' },
  { name: 'Sotheby\'s Online', slug: 'sothebys-online', currency: 'USD', buyer_premium_pct: '0.1800' },
  { name: 'Bonhams Live', slug: 'bonhams-live', currency: 'GBP', buyer_premium_pct: '0.2000' },
  { name: 'Heritage Auctions', slug: 'heritage-auctions', currency: 'USD', buyer_premium_pct: '0.1750' },
  { name: 'Phillips Contemporary', slug: 'phillips-contemporary', currency: 'USD', buyer_premium_pct: '0.1500' },
  { name: 'Dorotheum Vienna', slug: 'dorotheum-vienna', currency: 'EUR', buyer_premium_pct: '0.1600' },
];

const AUCTION_TITLES = [
  'Important Works of Art', 'Post-War & Contemporary', 'Modern British Art',
  'The Collector\'s Sale', 'Jewels & Timepieces', 'Fine Wine & Spirits',
  'Rare Books & Manuscripts', 'Asian Art & Antiques', 'Impressionist & Modern',
  'American Masters', 'Photography & Digital Art', 'Sculpture & Ceramics',
  'Sports Memorabilia', 'Vintage Automobiles', 'Estate & Consignment',
  'Film & Entertainment Memorabilia', 'Old Masters', 'Russian Art',
  'Middle Eastern & North African Art', 'Latin American Art',
  'Decorative Arts & Design', 'Natural History & Science',
];

const LOT_CATEGORIES = [
  'Painting', 'Sculpture', 'Photograph', 'Drawing', 'Print',
  'Jewelry', 'Watch', 'Wine', 'Book', 'Antique',
  'Furniture', 'Ceramic', 'Textile', 'Coin', 'Memorabilia',
];

function randomLotTitle(category: string): string {
  const titles: Record<string, string[]> = {
    Painting: ['Victorian Oil on Canvas', 'Abstract Expressionist Work', 'Impressionist Landscape', 'Portrait of a Lady', 'Still Life with Flowers'],
    Sculpture: ['Bronze Figure Study', 'Marble Torso Fragment', 'Abstract Steel Construction', 'Carved Ivory Netsuke'],
    Photograph: ['Vintage Silver Gelatin Print', 'Large Format Chromogenic Print', 'Daguerreotype Portrait'],
    Drawing: ['Charcoal Figure Study', 'Pen and Ink Architectural Study', 'Watercolour Landscape'],
    Jewelry: ['Art Deco Diamond Brooch', 'Victorian Gold Locket', 'Sapphire and Diamond Ring'],
    Watch: ['Swiss Chronograph ca. 1960', 'Pocket Watch with Enamel Dial', 'Vintage Dive Watch'],
    Wine: ['Château Pétrus 1982', 'Domaine de la Romanée-Conti 1990', 'Opus One 2000'],
    Book: ['First Edition, Fine Binding', 'Illuminated Manuscript Leaf', 'Early Printed Atlas'],
    Antique: ['Georgian Silver Tea Service', 'Ming Dynasty Vase', 'Japanese Lacquerware Box'],
    Furniture: ['Louis XVI Bergère Chair', 'Arts & Crafts Oak Sideboard', 'Biedermeier Secretary'],
    Ceramic: ['Meissen Porcelain Figure', 'Studio Pottery Vessel', 'Chinese Export Plate'],
    Textile: ['Caucasian Rug ca. 1900', 'French Aubusson Tapestry', 'Kashmiri Shawl'],
    Coin: ['Roman Aureus of Augustus', 'Gold Sovereign 1854', 'American Double Eagle 1907'],
    Memorabilia: ['Signed Beatles Photograph', 'Championship Belt', 'Vintage Sports Card'],
    Print: ['Lithograph after Picasso', 'Woodblock Print by Hiroshige', 'Screenprint by Warhol'],
  };
  const opts = titles[category] ?? ['Fine Art Work'];
  return opts[Math.floor(Math.random() * opts.length)];
}

function randomBidderName(): { email: string; display_name: string } {
  const firstNames = ['James', 'Emma', 'Oliver', 'Sophie', 'William', 'Charlotte', 'Henry', 'Isabella', 'George', 'Amelia', 'Alexander', 'Olivia', 'Theodore', 'Grace', 'Sebastian', 'Victoria', 'Frederick', 'Elizabeth', 'Arthur', 'Catherine'];
  const lastNames = ['Windsor', 'Pemberton', 'Ashworth', 'Blackwood', 'Cavendish', 'Davenport', 'Ellsworth', 'Fairfax', 'Goldstein', 'Hartley', 'Ingram', 'Jennings', 'Kensington', 'Lawson', 'Montgomery', 'Northfield', 'Oakley', 'Pemberton', 'Quincy', 'Rutherford'];
  const fn = firstNames[Math.floor(Math.random() * firstNames.length)];
  const ln = lastNames[Math.floor(Math.random() * lastNames.length)];
  const suffix = Math.floor(Math.random() * 9999);
  return {
    email: `${fn.toLowerCase()}.${ln.toLowerCase()}${suffix}@example.com`,
    display_name: `${fn} ${ln}`,
  };
}

function randomStartingBid(): number {
  const tiers = [
    5_000, 10_000, 25_000, 50_000, 100_000, 250_000,
    500_000, 1_000_000, 5_000_000, 10_000_000,
  ];
  return tiers[Math.floor(Math.random() * tiers.length)];
}

// ── Main Seed Function ────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  const client = await pool.connect();

  try {
    console.log('[seed] Starting seed...');

    // ── Auction Houses ──────────────────────────────────────────────────────
    console.log('[seed] Creating auction houses...');
    const auctionHouseIds: string[] = [];

    for (const ah of AUCTION_HOUSES) {
      const { rows } = await client.query(
        `INSERT INTO auction_houses (name, slug, currency, buyer_premium_pct)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [ah.name, ah.slug, ah.currency, ah.buyer_premium_pct]
      );
      auctionHouseIds.push(rows[0].id);
    }
    console.log(`[seed] Created ${auctionHouseIds.length} auction houses`);

    // ── Bidders ─────────────────────────────────────────────────────────────
    console.log('[seed] Creating 500 bidders...');
    const bidderIds: string[] = [];
    const tiers = ['basic', 'verified', 'premium'];

    for (let i = 0; i < 500; i++) {
      const { email, display_name } = randomBidderName();
      const tier = tiers[Math.floor(Math.random() * tiers.length)];
      const paddle = `P${(1000 + i).toString()}`;

      try {
        const { rows } = await client.query(
          `INSERT INTO bidders (email, display_name, verification_tier, paddle_number)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
           RETURNING id`,
          [email, display_name, tier, paddle]
        );
        bidderIds.push(rows[0].id);
      } catch {
        // Ignore duplicate emails
        bidderIds.push(randomUUID()); // placeholder won't be used
      }
    }
    console.log(`[seed] Created ~${bidderIds.length} bidders`);

    // ── Auctions ────────────────────────────────────────────────────────────
    console.log('[seed] Creating 22 auctions...');
    const auctionIds: string[] = [];
    const now = new Date();

    const auctionDefs = [
      // 4 live auctions (ongoing)
      ...Array.from({ length: 4 }, (_, i) => ({
        status: 'live' as const,
        startOffset: -2 * 60 * 60 * 1000, // started 2h ago
        endOffset: 8 * 60 * 60 * 1000,    // ends in 8h
        title: AUCTION_TITLES[i],
      })),
      // 6 scheduled auctions (future)
      ...Array.from({ length: 6 }, (_, i) => ({
        status: 'scheduled' as const,
        startOffset: (i + 1) * 24 * 60 * 60 * 1000,
        endOffset: (i + 2) * 24 * 60 * 60 * 1000,
        title: AUCTION_TITLES[4 + i],
      })),
      // 8 closed/settled auctions (past)
      ...Array.from({ length: 8 }, (_, i) => ({
        status: 'closed' as const,
        startOffset: -(i + 3) * 24 * 60 * 60 * 1000,
        endOffset: -(i + 2) * 24 * 60 * 60 * 1000,
        title: AUCTION_TITLES[10 + i],
      })),
      // 4 preview auctions
      ...Array.from({ length: 4 }, (_, i) => ({
        status: 'preview' as const,
        startOffset: (12 + i) * 60 * 60 * 1000,
        endOffset: (16 + i) * 60 * 60 * 1000,
        title: AUCTION_TITLES[18 + i % 4],
      })),
    ];

    for (const def of auctionDefs) {
      const ahId = auctionHouseIds[Math.floor(Math.random() * auctionHouseIds.length)];
      const start = new Date(now.getTime() + def.startOffset);
      const end = new Date(now.getTime() + def.endOffset);
      const isLive = def.status === 'live';

      const { rows } = await client.query(
        `INSERT INTO auctions
           (auction_house_id, title, status, scheduled_start, scheduled_end,
            actual_start, allow_proxy_bids, require_verification)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          ahId, def.title, def.status, start, end,
          isLive ? start : null, true, Math.random() < 0.3,
        ]
      );
      auctionIds.push(rows[0].id);
    }
    console.log(`[seed] Created ${auctionIds.length} auctions`);

    // ── Lots ────────────────────────────────────────────────────────────────
    console.log('[seed] Creating ≥200 lots...');
    const lotIds: string[] = [];

    for (const auctionId of auctionIds) {
      const { rows: [auction] } = await client.query(
        `SELECT status FROM auctions WHERE id = $1`,
        [auctionId]
      );

      const lotsCount = 8 + Math.floor(Math.random() * 15); // 8-22 lots per auction

      for (let i = 0; i < lotsCount; i++) {
        const category = LOT_CATEGORIES[Math.floor(Math.random() * LOT_CATEGORIES.length)];
        const title = randomLotTitle(category);
        const startingBid = randomStartingBid();
        const hasReserve = Math.random() < 0.6;
        const reserveMultiplier = 1.5 + Math.random() * 2; // 1.5x-3.5x starting bid
        const reservePrice = hasReserve ? Math.round(startingBid * reserveMultiplier) : null;

        let lotStatus = 'pending';
        let closingAt: Date | null = null;

        if (auction.status === 'live') {
          lotStatus = Math.random() < 0.15 ? 'closing' : 'open';
          const minutesLeft = lotStatus === 'closing'
            ? 1 + Math.random() * 1.5  // 1-2.5 minutes for closing lots
            : 5 + Math.random() * 55;  // 5-60 minutes for open lots
          closingAt = new Date(Date.now() + minutesLeft * 60 * 1000);
        } else if (auction.status === 'closed') {
          lotStatus = Math.random() < 0.75 ? 'sold' : 'passed';
        }

        const lotNumber = `${(i + 1).toString().padStart(3, '0')}`;
        const currency = auction.currency ?? 'USD';

        const { rows } = await client.query(
          `INSERT INTO lots
             (auction_id, lot_number, title, description, category,
              starting_bid, reserve_price, current_bid, status, closing_at, currency)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            auctionId, lotNumber, title,
            `Fine example: ${title}. Estimate: $${Math.round(startingBid / 100).toLocaleString()}-${Math.round(startingBid * 2 / 100).toLocaleString()}.`,
            category, startingBid, reservePrice, startingBid,
            lotStatus, closingAt, 'USD',
          ]
        );
        lotIds.push(rows[0].id);
      }
    }
    console.log(`[seed] Created ${lotIds.length} lots`);

    // ── Auction Registrations ───────────────────────────────────────────────
    console.log('[seed] Creating auction registrations...');
    let regCount = 0;

    for (const auctionId of auctionIds) {
      // Register 20-80 random bidders per auction
      const count = 20 + Math.floor(Math.random() * 60);
      const shuffled = [...bidderIds].sort(() => Math.random() - 0.5).slice(0, count);

      for (const bidderId of shuffled) {
        try {
          await client.query(
            `INSERT INTO auction_registrations (auction_id, bidder_id, is_eligible)
             VALUES ($1, $2, TRUE)
             ON CONFLICT DO NOTHING`,
            [auctionId, bidderId]
          );
          regCount++;
        } catch { /* ignore */ }
      }
    }
    console.log(`[seed] Created ${regCount} registrations`);

    // ── Historical Bids ─────────────────────────────────────────────────────
    console.log('[seed] Creating ≥2,000 historical bids...');
    let bidCount = 0;

    // Focus on sold/closed lots and active lots for realistic history
    const bidTargetLots = lotIds.slice(0, Math.min(lotIds.length, 150));

    for (const lotId of bidTargetLots) {
      const { rows: [lot] } = await client.query(
        `SELECT l.auction_id, l.starting_bid, l.reserve_price, l.status, l.current_bid, l.currency
         FROM lots l WHERE l.id = $1`,
        [lotId]
      );

      if (!lot || lot.status === 'pending' || lot.status === 'withdrawn') continue;

      // Get registered bidders for this auction
      const { rows: regBidders } = await client.query(
        `SELECT bidder_id FROM auction_registrations WHERE auction_id = $1 LIMIT 20`,
        [lot.auction_id]
      );

      if (regBidders.length < 2) continue;

      // Simulate bidding history
      const numBids = 3 + Math.floor(Math.random() * 20);
      let currentBid = parseInt(lot.starting_bid, 10);
      let currentWinnerId: string | null = null;
      const bidHistory: Array<{ bidderId: string; amount: number }> = [];

      for (let i = 0; i < numBids; i++) {
        const nextBid = getMinimumNextBid(currentBid);
        // Add some variation: sometimes bid exactly minimum, sometimes higher
        const bidMultiplier = 1 + (Math.random() < 0.3 ? Math.floor(Math.random() * 3) : 0);
        const bidAmount = nextBid * bidMultiplier;

        // Pick a different bidder than current winner
        const eligible = regBidders.filter((r: { bidder_id: string }) => r.bidder_id !== currentWinnerId);
        if (eligible.length === 0) break;
        const bidder = eligible[Math.floor(Math.random() * eligible.length)];

        bidHistory.push({ bidderId: bidder.bidder_id, amount: bidAmount });
        currentBid = bidAmount;
        currentWinnerId = bidder.bidder_id;
      }

      // Insert bids in chronological order
      const baseTime = new Date(Date.now() - numBids * 60 * 1000);

      for (let i = 0; i < bidHistory.length; i++) {
        const { bidderId, amount } = bidHistory[i];
        const isLast = i === bidHistory.length - 1;
        const status = isLast ? 'accepted' : 'outbid';
        const placedAt = new Date(baseTime.getTime() + i * 60 * 1000);
        const outbidAt = isLast ? null : new Date(baseTime.getTime() + (i + 1) * 60 * 1000);

        try {
          await client.query(
            `INSERT INTO bids (lot_id, bidder_id, bid_type, amount, status, placed_at, processed_at, outbid_at)
             VALUES ($1, $2, 'live', $3, $4, $5, $5, $6)`,
            [lotId, bidderId, amount, status, placedAt, outbidAt]
          );
          bidCount++;
        } catch { /* ignore */ }
      }

      // Update lot with final bid state
      if (currentWinnerId && currentBid > parseInt(lot.starting_bid, 10)) {
        let finalStatus = lot.status;
        let soldPrice: number | null = null;
        let soldAt: Date | null = null;

        if (lot.status === 'sold') {
          soldPrice = currentBid;
          soldAt = new Date();
        }

        await client.query(
          `UPDATE lots
           SET current_bid = $1, current_winner_id = $2, bid_count = $3,
               sold_price = $4, sold_at = $5
           WHERE id = $6`,
          [currentBid, currentWinnerId, bidHistory.length, soldPrice, soldAt, lotId]
        );

        // Create invoice for sold lots
        if (lot.status === 'sold' && currentWinnerId) {
          const { rows: [ah] } = await client.query(
            `SELECT ah.buyer_premium_pct FROM auction_houses ah
             JOIN auctions a ON a.auction_house_id = ah.id
             JOIN lots l ON l.auction_id = a.id
             WHERE l.id = $1`,
            [lotId]
          );

          if (ah) {
            const buyerPremiumPct = parseFloat(ah.buyer_premium_pct);
            const buyerPremium = Math.round(currentBid * buyerPremiumPct);
            const totalDue = currentBid + buyerPremium;

            try {
              await client.query(
                `INSERT INTO settlement_invoices
                   (auction_id, bidder_id, lot_id, hammer_price, buyer_premium, total_due, currency, due_date)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '7 days')
                 ON CONFLICT (lot_id) DO NOTHING`,
                [lot.auction_id, currentWinnerId, lotId, currentBid, buyerPremium, totalDue, lot.currency]
              );
            } catch { /* ignore */ }
          }
        }
      }

      if (bidCount >= 2000) break;
    }

    // If we haven't reached 2000 bids, add more
    if (bidCount < 2000) {
      const remaining = 2000 - bidCount;
      const activeLots = lotIds.slice(0, 50);

      for (let i = 0; i < remaining && activeLots.length > 0; i++) {
        const lotId = activeLots[i % activeLots.length];
        const bidderId = bidderIds[Math.floor(Math.random() * bidderIds.length)];

        try {
          await client.query(
            `INSERT INTO bids (lot_id, bidder_id, bid_type, amount, status, placed_at, processed_at)
             VALUES ($1, $2, 'live', 1000, 'outbid', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour')`,
            [lotId, bidderId]
          );
          bidCount++;
        } catch { /* ignore */ }
      }
    }

    console.log(`[seed] Created ~${bidCount} bids`);

    // ── Auction events for live auctions ────────────────────────────────────
    const { rows: openLots } = await client.query(
      `SELECT l.id, a.id AS auction_id FROM lots l
       JOIN auctions a ON a.id = l.auction_id
       WHERE l.status IN ('open', 'closing')
       LIMIT 30`
    );

    for (const lot of openLots) {
      await client.query(
        `INSERT INTO auction_events (lot_id, event_type, payload)
         VALUES ($1, 'LOT_OPENED', $2)`,
        [lot.id, JSON.stringify({ auction_id: lot.auction_id })]
      );
    }

    console.log('[seed] Seed complete!');
    console.log(`  Auction houses: ${auctionHouseIds.length}`);
    console.log(`  Auctions:       ${auctionIds.length}`);
    console.log(`  Lots:           ${lotIds.length}`);
    console.log(`  Bidders:        ~${bidderIds.length}`);
    console.log(`  Bids:           ~${bidCount}`);

  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('[seed] Fatal error:', err);
  process.exit(1);
});
