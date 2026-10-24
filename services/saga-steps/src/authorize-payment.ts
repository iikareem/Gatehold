import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  appendLedgerItem,
  buildLedgerItem,
  DEFAULT_ORDER_AMOUNT_CENTS,
  getDocClient,
  LEDGER_CURRENCY_USD,
  paymentAuthKey,
  requireEnv,
} from "../../shared/src";
import {
  authorizeWithProvider,
  isRetryablePaymentStatus,
  PaymentProviderError,
} from "../../shared/src/payment";
import type {
  AuthorizedSagaState,
  SagaInput,
} from "../../shared/src/types";

/**
 * Business / non-retryable authorize failure.
 */
export class AuthorizePaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizePaymentError";
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

/** @deprecated Prefer AuthorizedSagaState from shared types. */
export type AuthorizePaymentResult = AuthorizedSagaState;

/**
 * Phase 6 Slice 4 — AuthorizePayment.
 * Call mock authorize with pay:auth:{orderId}, then append ledger AUTH
 * via conditional Put (attribute_not_exists). No Get-before — safety is
 * mock idempotency key + conditional ledger write.
 */
export async function handler(
  event: SagaInput,
): Promise<AuthorizedSagaState> {
  const ledgerTable = requireEnv("LEDGER_TABLE_NAME");
  const ordersTable = requireEnv("ORDERS_TABLE_NAME");
  const mockBase = requireEnv("MOCK_PAYMENT_URL");
  const amount = orderAmountCents();
  const currency = LEDGER_CURRENCY_USD;
  const pk = paymentAuthKey(event.orderId);
  const createdAt = new Date().toISOString();

  let provider;
  try {
    provider = await authorizeWithProvider(mockBase, {
      idempotencyKey: pk,
      orderId: event.orderId,
      amount,
      currency,
    });
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      if (isRetryablePaymentStatus(err.statusCode)) {
        throw new TransientError(err.message);
      }
      throw new AuthorizePaymentError(err.message);
    }
    throw err;
  }

  if (provider.status !== "AUTHORIZED" || !provider.authorizationId) {
    throw new AuthorizePaymentError(
      `authorize returned unexpected status=${provider.status}`,
    );
  }

  const ledgerResult = await appendLedgerItem(
    (cmd) => getDocClient().send(cmd),
    {
      tableName: ledgerTable,
      item: buildLedgerItem({
        pk,
        kind: "AUTH",
        orderId: event.orderId,
        amount: provider.amount,
        currency: provider.currency,
        createdAt,
        providerPaymentId: provider.paymentId,
        authorizationId: provider.authorizationId,
      }),
    },
  );

  console.info("authorize-payment ok", {
    orderId: event.orderId,
    authorizationId: provider.authorizationId,
    ledger: ledgerResult,
  });

  await setOrderAmountIfMissing(ordersTable, event.orderId, amount);

  const result: AuthorizedSagaState = {
    ...event,
    amount: provider.amount,
    currency: provider.currency,
    authorizationId: provider.authorizationId,
  };
  if (provider.paymentId) {
    result.providerPaymentId = provider.paymentId;
  }
  return result;
}

function orderAmountCents(): number {
  const raw = process.env.ORDER_AMOUNT_CENTS;
  if (raw == null || raw === "") return DEFAULT_ORDER_AMOUNT_CENTS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AuthorizePaymentError(
      `ORDER_AMOUNT_CENTS must be a positive integer, got ${raw}`,
    );
  }
  return n;
}

async function setOrderAmountIfMissing(
  tableName: string,
  orderId: string,
  amount: number,
): Promise<void> {
  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: tableName,
        Key: { orderId },
        UpdateExpression: "SET amount = if_not_exists(amount, :amount)",
        ExpressionAttributeValues: { ":amount": amount },
      }),
    );
  } catch (err) {
    // Non-fatal for authorize — money already reserved + ledgered.
    console.warn("authorize-payment could not set order amount", {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
