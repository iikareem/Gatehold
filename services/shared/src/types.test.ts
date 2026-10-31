import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_ORDER_AMOUNT_CENTS,
  LEDGER_CURRENCY_USD,
  ORDERS_EVENT_STATUS_INDEX,
  paymentAuthKey,
  paymentCaptureKey,
  paymentRefundKey,
  paymentVoidKey,
  placeholderTicketId,
  placeholderTicketIds,
} from "./types";

describe("payment idempotency keys", () => {
  it("matches mock-payment contract formats", () => {
    assert.equal(paymentAuthKey("ord_1"), "pay:auth:ord_1");
    assert.equal(paymentCaptureKey("ord_1"), "pay:capture:ord_1");
    assert.equal(paymentVoidKey("ord_1"), "pay:void:ord_1");
    assert.equal(paymentRefundKey("ord_1"), "pay:refund:ord_1");
  });
});

describe("placeholder ticket ids", () => {
  it("are deterministic per order and seat", () => {
    assert.equal(placeholderTicketId("ord_1", "A-12-07"), "tkt:ord_1:A-12-07");
    assert.deepEqual(placeholderTicketIds("ord_1", ["A-12-07", "A-12-08"]), [
      "tkt:ord_1:A-12-07",
      "tkt:ord_1:A-12-08",
    ]);
  });
});

describe("ledger defaults", () => {
  it("uses fixed cents and USD until pricing exists", () => {
    assert.equal(DEFAULT_ORDER_AMOUNT_CENTS, 5000);
    assert.equal(LEDGER_CURRENCY_USD, "USD");
  });
});

describe("orders cancel fan-out index", () => {
  it("matches contracts GSI name", () => {
    assert.equal(ORDERS_EVENT_STATUS_INDEX, "eventId-status");
  });
});
