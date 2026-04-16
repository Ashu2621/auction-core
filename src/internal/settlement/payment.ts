import { pool } from '../../db/pool';
import { config } from '../../config';
import { InvoiceRow, PaymentCaptureRequest, PaymentCaptureResponse } from '../../types';
import { settlementInvoicesTotal, settlementPaymentAttemptsTotal } from '../../metrics';

let settlementInterval: ReturnType<typeof setInterval> | null = null;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function startSettlementEngine(): void {
  if (settlementInterval) return;
  console.log('[settlement] Starting payment engine (interval: 10m)');
  settlementInterval = setInterval(async () => {
    try {
      await processPendingInvoices();
    } catch (err) {
      console.error('[settlement] Engine cycle error:', err);
    }
  }, config.settlementIntervalMs);
}

export function stopSettlementEngine(): void {
  if (settlementInterval) {
    clearInterval(settlementInterval);
    settlementInterval = null;
    console.log('[settlement] Payment engine stopped');
  }
}

// ── Core Logic ────────────────────────────────────────────────────────────────

/**
 * Process a single invoice by ID (used by the manual payment route).
 */
export async function processInvoiceById(invoiceId: string): Promise<void> {
  const { rows } = await pool.query<InvoiceRow>(
    `SELECT * FROM settlement_invoices WHERE id = $1`,
    [invoiceId]
  );
  if (rows.length > 0) {
    await processInvoice(rows[0]);
  }
}

/**
 * Process all pending invoices.
 * Idempotent: skips invoices that already have a payment_ref set.
 */
export async function processPendingInvoices(): Promise<void> {
  const { rows: invoices } = await pool.query<InvoiceRow>(
    `SELECT si.*
     FROM settlement_invoices si
     WHERE si.status = 'pending'
       AND si.payment_ref IS NULL
       AND (si.next_retry_at IS NULL OR si.next_retry_at <= NOW())
     ORDER BY si.created_at ASC
     LIMIT 50`
  );

  if (invoices.length === 0) return;

  console.log(`[settlement] Processing ${invoices.length} pending invoice(s)`);

  for (const invoice of invoices) {
    await processInvoice(invoice);
  }
}

async function processInvoice(invoice: InvoiceRow): Promise<void> {
  // Idempotency: if payment_ref already set, this invoice was already paid
  if (invoice.payment_ref) {
    console.log(`[settlement] Invoice ${invoice.id} already paid, skipping`);
    return;
  }

  // Fetch lot title for description
  const { rows: lotRows } = await pool.query(
    `SELECT l.title, b.display_name
     FROM lots l
     LEFT JOIN bidders b ON b.id = $2
     WHERE l.id = $1`,
    [invoice.lot_id, invoice.bidder_id]
  );
  const lotTitle = lotRows[0]?.title ?? 'Auction Lot';

  const captureReq: PaymentCaptureRequest = {
    invoice_id: invoice.id,
    bidder_id: invoice.bidder_id,
    amount_cents: parseInt(invoice.total_due as unknown as string, 10),
    currency: invoice.currency,
    description: `Invoice ${invoice.id} - ${lotTitle}`,
  };

  try {
    const result = await callPaymentGateway(captureReq);

    if (result.status === 'approved') {
      await pool.query(
        `UPDATE settlement_invoices
         SET status = 'paid', payment_ref = $1, paid_at = NOW()
         WHERE id = $2`,
        [result.payment_ref, invoice.id]
      );
      settlementInvoicesTotal.inc({ status: 'paid' });
      settlementPaymentAttemptsTotal.inc({ outcome: 'approved' });
      console.log(`[settlement] Invoice ${invoice.id} paid (ref: ${result.payment_ref})`);
    } else {
      await handleDecline(invoice);
      settlementPaymentAttemptsTotal.inc({ outcome: 'declined' });
    }
  } catch (err) {
    console.error(`[settlement] Payment error for invoice ${invoice.id}:`, err);
    await handleDecline(invoice);
    settlementPaymentAttemptsTotal.inc({ outcome: 'error' });
  }
}

async function handleDecline(invoice: InvoiceRow): Promise<void> {
  const retryCount = (invoice.retry_count || 0) + 1;

  if (retryCount >= config.settlementRetryMax) {
    // Max retries exceeded → mark overdue
    await pool.query(
      `UPDATE settlement_invoices
       SET status = 'overdue', retry_count = $1
       WHERE id = $2`,
      [retryCount, invoice.id]
    );
    settlementInvoicesTotal.inc({ status: 'overdue' });
    console.warn(`[settlement] Invoice ${invoice.id} marked overdue after ${retryCount} attempts`);
  } else {
    // Schedule retry with 1-hour backoff
    const nextRetryAt = new Date(Date.now() + config.settlementRetryBackoffMs);
    await pool.query(
      `UPDATE settlement_invoices
       SET retry_count = $1, next_retry_at = $2
       WHERE id = $3`,
      [retryCount, nextRetryAt, invoice.id]
    );
    console.log(
      `[settlement] Invoice ${invoice.id} retry ${retryCount}/${config.settlementRetryMax} scheduled at ${nextRetryAt.toISOString()}`
    );
  }
}

/**
 * Call the payment gateway mock.
 * In production this would include circuit-breaker, timeout, and retry logic.
 */
async function callPaymentGateway(
  req: PaymentCaptureRequest
): Promise<PaymentCaptureResponse> {
  const url = `${config.paymentGatewayUrl}/capture`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer operator_api_key`,
    },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(10000),
  });

  const body = (await response.json()) as PaymentCaptureResponse;

  if (response.status === 200) {
    return { ...body, status: 'approved' };
  } else {
    return { ...body, status: 'declined' };
  }
}
