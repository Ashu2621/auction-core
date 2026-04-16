/**
 * Bid increment table for AuctionCore.
 * All amounts are in cents (integers).
 *
 * Tier table (per assignment spec):
 *   < $100          → $5 increments
 *   $100 – $499     → $10 increments
 *   $500 – $999     → $25 increments
 *   $1,000 – $4,999 → $50 increments
 *   $5,000 – $19,999 → $250 increments
 *   $20,000 – $99,999 → $1,000 increments
 *   ≥ $100,000      → $5,000 increments
 */

const INCREMENT_TABLE: Array<{ thresholdCents: number; incrementCents: number }> = [
  { thresholdCents: 10_000,     incrementCents: 500    },  // < $100   → $5
  { thresholdCents: 50_000,     incrementCents: 1_000  },  // < $500   → $10
  { thresholdCents: 100_000,    incrementCents: 2_500  },  // < $1,000 → $25
  { thresholdCents: 500_000,    incrementCents: 5_000  },  // < $5,000 → $50
  { thresholdCents: 2_000_000,  incrementCents: 25_000 },  // < $20,000 → $250
  { thresholdCents: 10_000_000, incrementCents: 100_000},  // < $100,000 → $1,000
];
const FINAL_INCREMENT_CENTS = 500_000; // ≥ $100,000 → $5,000

/**
 * Returns the minimum bid increment (in cents) for the given current bid.
 * @param currentBidCents Current lot price in cents.
 */
export function getBidIncrement(currentBidCents: number): number {
  for (const tier of INCREMENT_TABLE) {
    if (currentBidCents < tier.thresholdCents) {
      return tier.incrementCents;
    }
  }
  return FINAL_INCREMENT_CENTS;
}

/**
 * Returns the minimum valid next bid (in cents).
 * @param currentBidCents Current lot price in cents.
 */
export function getMinimumNextBid(currentBidCents: number): number {
  return currentBidCents + getBidIncrement(currentBidCents);
}

/**
 * Returns whether a proposed bid meets the minimum increment requirement.
 * @param currentBidCents Current lot price in cents.
 * @param proposedBidCents Proposed new bid in cents.
 */
export function isValidBidAmount(
  currentBidCents: number,
  proposedBidCents: number
): boolean {
  return proposedBidCents >= getMinimumNextBid(currentBidCents);
}
