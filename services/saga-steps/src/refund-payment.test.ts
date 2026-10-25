import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as dynamodb from "../../shared/src/dynamodb";
import * as ledger from "../../shared/src/ledger";
import * as payment from "../../shared/src/payment";
import { PaymentProviderError } from "../../shared/src/payment";
import {
  RefundPaymentError,
  handler,
  type RefundPaymentInput,
} from "./refund-payment";

const input: RefundPaymentInput = {
  orderId: "ord_1",
  eventId: "evt_001",
  holdId: "h_1",
  seatIds: ["A-12-07"],
  userId: "alice",
  amount: 5000,
  currency: "USD",
  authorizationId: "auth_1",
  providerPaymentId: "pay_1",
  error: {
    Error: "IssueTicketError",
    Cause: "ticket write failed",
  },
};

describe("refund-payment handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.LEDGER_TABLE_NAME;
    delete process.env.MOCK_PAYMENT_URL;
  });

  it("calls mock refund, appends REFUND ledger, passes state through", async () => {
    process.env.LEDGER_TABLE_NAME = "gatehold-dev-ledger";
    process.env.MOCK_PAYMENT_URL = "http://127.0.0.1:8090";

    mock.method(payment, "refundWithProvider", async () => ({
      idempotencyKey: "pay:refund:ord_1",
      orderId: "ord_1",
      authorizationId: "auth_1",
      paymentId: "pay_1",
      status: "REFUNDED",
      amount: 5000,
      currency: "USD",
    }));
    mock.method(ledger, "appendLedgerItem", async () => "inserted");
    mock.method(dynamodb, "getDocClient", () => ({ send: async () => ({}) }));

    const result = await handler(input);
    assert.equal(result.authorizationId, "auth_1");
    assert.equal(result.orderId, "ord_1");
    assert.equal(result.error?.Error, "IssueTicketError");
  });

  it("treats ConditionalCheckFailed ledger Put as success", async () => {
    process.env.LEDGER_TABLE_NAME = "gatehold-dev-ledger";
    process.env.MOCK_PAYMENT_URL = "http://127.0.0.1:8090";

    mock.method(payment, "refundWithProvider", async () => ({
      idempotencyKey: "pay:refund:ord_1",
      orderId: "ord_1",
      authorizationId: "auth_1",
      status: "REFUNDED",
      amount: 5000,
      currency: "USD",
    }));
    mock.method(ledger, "appendLedgerItem", async () => "already_exists");
    mock.method(dynamodb, "getDocClient", () => ({ send: async () => ({}) }));

    const result = await handler(input);
    assert.equal(result.authorizationId, "auth_1");
  });

  it("fails hard on non-retryable provider 409", async () => {
    process.env.LEDGER_TABLE_NAME = "gatehold-dev-ledger";
    process.env.MOCK_PAYMENT_URL = "http://127.0.0.1:8090";

    mock.method(payment, "refundWithProvider", async () => {
      throw new PaymentProviderError("not captured", 409, "CONFLICT");
    });

    await assert.rejects(
      () => handler(input),
      (err: unknown) => {
        assert.ok(err instanceof RefundPaymentError);
        return true;
      },
    );
  });

  it("requires authorizationId", async () => {
    process.env.LEDGER_TABLE_NAME = "gatehold-dev-ledger";
    process.env.MOCK_PAYMENT_URL = "http://127.0.0.1:8090";
    const bad = { ...input, authorizationId: "" };
    await assert.rejects(() => handler(bad), RefundPaymentError);
  });
});
