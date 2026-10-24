import {
  appendLedgerItem,
  buildLedgerItem,
  getDocClient,
  paymentCaptureKey,
  requireEnv,
} from "../../shared/src";
import {
  captureWithProvider,
  isRetryablePaymentStatus,
  PaymentProviderError,
} from "../../shared/src/payment";
import type { AuthorizedSagaState } from "../../shared/src/types";

/**
 * Business / non-retryable capture failure.
 */
export class CapturePaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapturePaymentError";
  }
}

/**
 * Transient provider / network failure — safe for Step Functions retry.
 */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * Phase 6 Slice 6 — CapturePayment.
 * After seats are SOLD: call mock capture with pay:capture:{orderId},
 * then append ledger CAPTURE via conditional Put.
 */
export async function handler(
  event: AuthorizedSagaState,
): Promise<AuthorizedSagaState> {
  const ledgerTable = requireEnv("LEDGER_TABLE_NAME");
  const mockBase = requireEnv("MOCK_PAYMENT_URL");

  if (!event.authorizationId) {
    throw new CapturePaymentError(
      "authorizationId required (run AuthorizePayment first)",
    );
  }
  if (!Number.isInteger(event.amount) || event.amount <= 0) {
    throw new CapturePaymentError(
      `amount required (got ${String(event.amount)})`,
    );
  }

  const pk = paymentCaptureKey(event.orderId);
  const currency = event.currency || "USD";
  const createdAt = new Date().toISOString();

  let provider;
  try {
    provider = await captureWithProvider(mockBase, {
      idempotencyKey: pk,
      orderId: event.orderId,
      authorizationId: event.authorizationId,
      amount: event.amount,
      currency,
    });
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      if (isRetryablePaymentStatus(err.statusCode)) {
        throw new TransientError(err.message);
      }
      throw new CapturePaymentError(err.message);
    }
    throw err;
  }

  if (provider.status !== "CAPTURED") {
    throw new CapturePaymentError(
      `capture returned unexpected status=${provider.status}`,
    );
  }

  const ledgerResult = await appendLedgerItem(
    (cmd) => getDocClient().send(cmd),
    {
      tableName: ledgerTable,
      item: buildLedgerItem({
        pk,
        kind: "CAPTURE",
        orderId: event.orderId,
        amount: provider.amount,
        currency: provider.currency,
        createdAt,
        providerPaymentId: provider.paymentId || event.providerPaymentId,
        authorizationId: provider.authorizationId || event.authorizationId,
      }),
    },
  );

  console.info("capture-payment ok", {
    orderId: event.orderId,
    authorizationId: event.authorizationId,
    ledger: ledgerResult,
  });

  return {
    ...event,
    amount: provider.amount,
    currency: provider.currency,
    authorizationId: provider.authorizationId || event.authorizationId,
    ...(provider.paymentId || event.providerPaymentId
      ? {
          providerPaymentId:
            provider.paymentId || event.providerPaymentId,
        }
      : {}),
  };
}
