import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HOLD_DURATION_MS } from "./hold";
import {
  DEFAULT_MAX_HOLD_SEATS,
  holdDurationMs,
  maxHoldSeats,
  resetSsmCacheForTests,
} from "./ssm";

describe("holdDurationMs", () => {
  afterEach(() => {
    delete process.env.HOLD_DURATION_MS;
    delete process.env.HOLD_TTL_MS_PARAM_NAME;
    resetSsmCacheForTests();
  });

  it("uses HOLD_DURATION_MS override when set", async () => {
    process.env.HOLD_DURATION_MS = "120000";
    assert.equal(await holdDurationMs(), 120000);
  });

  it("falls back to HOLD_DURATION_MS constant when param name unset", async () => {
    assert.equal(await holdDurationMs(), HOLD_DURATION_MS);
  });

  it("rejects non-positive HOLD_DURATION_MS override", async () => {
    process.env.HOLD_DURATION_MS = "0";
    await assert.rejects(() => holdDurationMs(), /positive integer/);
  });
});

describe("maxHoldSeats", () => {
  afterEach(() => {
    delete process.env.MAX_HOLD_SEATS;
    delete process.env.MAX_HOLD_SEATS_PARAM_NAME;
    resetSsmCacheForTests();
  });

  it("uses MAX_HOLD_SEATS override when set", async () => {
    process.env.MAX_HOLD_SEATS = "4";
    assert.equal(await maxHoldSeats(), 4);
  });

  it("falls back to DEFAULT_MAX_HOLD_SEATS when param name unset", async () => {
    assert.equal(await maxHoldSeats(), DEFAULT_MAX_HOLD_SEATS);
  });

  it("rejects non-positive MAX_HOLD_SEATS override", async () => {
    process.env.MAX_HOLD_SEATS = "-1";
    await assert.rejects(() => maxHoldSeats(), /positive integer/);
  });
});
