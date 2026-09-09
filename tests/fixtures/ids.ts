/**
 * Unique identifiers for test fixtures, sized to the schema.
 *
 * DESIGN NOTE — why this exists.
 *
 * `lots.lot_number` is VARCHAR(20). All three fixtures in this suite built a
 * lot number from `Date.now()` in base 10 — thirteen digits before any prefix
 * or random suffix — and so produced values well over the limit:
 *
 *   LOT-<13>-<4>          22 characters   tests/bid-processor.test.ts
 *   LOT-IDEM-<13>         22 characters   tests/idempotency.test.ts
 *   LOT-SETTLE-<13>-<4>   29 characters   tests/settlement.test.ts
 *
 * Every insert failed with SQLSTATE 22001, "value too long for type character
 * varying(20)". None of it had ever surfaced, because these tests are declared
 * `it.skipIf(!pool)` and no CI job had ever supplied a database — so the
 * eighteen tests covering row locking, idempotent replay, anti-snipe and
 * SKIP LOCKED had never actually executed against PostgreSQL.
 *
 * Base-36 milliseconds are eight characters and stay eight until 2059, which
 * leaves room for a short prefix and a random tail inside the twenty. The
 * length check is deliberate: if someone lengthens a prefix later, the fixture
 * fails immediately and says why, rather than surfacing as a driver error from
 * inside an unrelated assertion.
 */
const LOT_NUMBER_MAX = 20;

export function lotNumber(prefix = 'L'): string {
  const ts = Date.now().toString(36);                   // 8 chars until 2059
  const rand = Math.random().toString(36).slice(2, 6);  // 4 chars
  const value = `${prefix}-${ts}-${rand}`;

  if (value.length > LOT_NUMBER_MAX) {
    throw new Error(
      `lotNumber("${prefix}") produced ${value.length} characters; ` +
        `lots.lot_number is VARCHAR(${LOT_NUMBER_MAX}). Use a shorter prefix.`,
    );
  }

  return value;
}
