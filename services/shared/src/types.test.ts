import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_ORDER_AMOUNT_CENTS,
  LEDGER_CURRENCY_USD,
  paymentAuthKey,
  paymentCaptureKey,
  paymentRefundKey,
  paymentVoidKey,
} from "./types";

describe("payment idempotency keys", () => {
  it("matches mock-payment contract formats", () => {
    assert.equal(paymentAuthKey("ord_1"), "pay:auth:ord_1");
    assert.equal(paymentCaptureKey("ord_1"), "pay:capture:ord_1");
    assert.equal(paymentVoidKey("ord_1"), "pay:void:ord_1");
    assert.equal(paymentRefundKey("ord_1"), "pay:refund:ord_1");
  });
});

describe("ledger defaults", () => {
  it("uses fixed cents and USD until pricing exists", () => {
    assert.equal(DEFAULT_ORDER_AMOUNT_CENTS, 5000);
    assert.equal(LEDGER_CURRENCY_USD, "USD");
  });
});
