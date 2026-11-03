import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import * as dynamodb from "../../shared/src/dynamodb";
import * as ledger from "../../shared/src/ledger";
import * as payment from "../../shared/src/payment";
import { PaymentProviderError } from "../../shared/src/payment";
import { PermanentRefundError, TransientRefundError } from "./errors";
import { processRefundJob } from "./process-refund";

const tables = {
  ordersTable: "orders",
  ledgerTable: "ledger",
  refundBatchesTable: "refund-batches",
  eventsTable: "events",
};

const message = {
  orderId: "ord_1",
  eventId: "evt_001",
  batchId: "rb_1",
};

const captureItem = {
  pk: "pay:capture:ord_1",
  kind: "CAPTURE",
  orderId: "ord_1",
  amount: 5000,
  currency: "USD",
  authorizationId: "auth_1",
  providerPaymentId: "pay_1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const drainedBatch = {
  batchId: "rb_1",
  eventId: "evt_001",
  status: "RUNNING",
  enqueued: 1,
  succeeded: 1,
  failed: 0,
  fanOutComplete: true,
  startedAt: "2026-01-01T00:00:00.000Z",
};

describe("processRefundJob", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.MOCK_PAYMENT_URL;
  });

  it("claims, refunds, writes ledger, completes order, bumps succeeded", async () => {
    process.env.MOCK_PAYMENT_URL = "http://127.0.0.1:8090";

    const sends: unknown[] = [];
    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: unknown) => {
        sends.push(cmd);
        if (
          cmd &&
          typeof cmd === "object" &&
          "input" in cmd &&
          (cmd as { input: { Key?: { pk?: string } } }).input.Key?.pk ===
            "pay:capture:ord_1"
        ) {
          return { Item: captureItem };
        }
        if (
          cmd &&
          typeof cmd === "object" &&
          "input" in cmd &&
          (cmd as { input: { Key?: { batchId?: string }; ReturnValues?: string } })
            .input.Key?.batchId === "rb_1" &&
          (cmd as { input: { ReturnValues?: string } }).input.ReturnValues ===
            "ALL_NEW"
        ) {
          // Not drained yet — no complete writes.
          return {
            Attributes: {
              ...drainedBatch,
              succeeded: 1,
              enqueued: 2,
              fanOutComplete: true,
            },
          };
        }
        return {};
      },
    }));
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

    await processRefundJob(message, tables);

    assert.equal(sends.length, 4); // claim, get capture, complete order, bump
    assert.ok(sends[0] instanceof UpdateCommand);
  });

  it("closes batch and event when counters drain", async () => {
    process.env.MOCK_PAYMENT_URL = "http://127.0.0.1:8090";

    const sends: unknown[] = [];
    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: unknown) => {
        sends.push(cmd);
        if (
          cmd &&
          typeof cmd === "object" &&
          "input" in cmd &&
          (cmd as { input: { Key?: { pk?: string } } }).input.Key?.pk ===
            "pay:capture:ord_1"
        ) {
          return { Item: captureItem };
        }
        if (
          cmd &&
          typeof cmd === "object" &&
          "input" in cmd &&
          (cmd as { input: { Key?: { batchId?: string }; ReturnValues?: string } })
            .input.Key?.batchId === "rb_1" &&
          (cmd as { input: { ReturnValues?: string } }).input.ReturnValues ===
            "ALL_NEW"
        ) {
          return { Attributes: drainedBatch };
        }
        return {};
      },
    }));
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

    await processRefundJob(message, tables);

    // claim, capture get, complete order, bump, complete batch, mark CANCELLED
    assert.equal(sends.length, 6);
    const batchDone = (sends[4] as UpdateCommand).input;
    assert.equal(batchDone.ExpressionAttributeValues?.[":done"], "COMPLETE");
    const eventDone = (sends[5] as UpdateCommand).input;
    assert.equal(
      eventDone.ExpressionAttributeValues?.[":cancelled"],
      "CANCELLED",
    );
  });

  it("skips when order already REFUNDED", async () => {
    process.env.MOCK_PAYMENT_URL = "http://127.0.0.1:8090";

    let call = 0;
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        call += 1;
        if (call === 1) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        return { Item: { status: "REFUNDED" } };
      },
    }));
    const refund = mock.method(payment, "refundWithProvider", async () => {
      throw new Error("should not call provider");
    });

    await processRefundJob(message, tables);
    assert.equal(refund.mock.callCount(), 0);
  });

  it("retries on provider 429", async () => {
    process.env.MOCK_PAYMENT_URL = "http://127.0.0.1:8090";

    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: unknown) => {
        if (
          cmd &&
          typeof cmd === "object" &&
          "input" in cmd &&
          (cmd as { input: { Key?: { pk?: string } } }).input.Key?.pk ===
            "pay:capture:ord_1"
        ) {
          return { Item: captureItem };
        }
        return {};
      },
    }));
    mock.method(payment, "refundWithProvider", async () => {
      throw new PaymentProviderError("rate limited", 429);
    });

    await assert.rejects(
      () => processRefundJob(message, tables),
      TransientRefundError,
    );
  });

  it("fails permanently when CAPTURE is missing", async () => {
    process.env.MOCK_PAYMENT_URL = "http://127.0.0.1:8090";

    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: unknown) => {
        if (
          cmd &&
          typeof cmd === "object" &&
          "input" in cmd &&
          (cmd as { input: { Key?: { pk?: string } } }).input.Key?.pk ===
            "pay:capture:ord_1"
        ) {
          return {};
        }
        return {};
      },
    }));

    await assert.rejects(
      () => processRefundJob(message, tables),
      PermanentRefundError,
    );
  });
});
