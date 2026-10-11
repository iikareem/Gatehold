import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HOLD_DURATION_MS,
  buildHoldSeatUpdateInput,
  holdExpiresAt,
} from "./hold";

describe("buildHoldSeatUpdateInput", () => {
  const input = buildHoldSeatUpdateInput({
    tableName: "gatehold-dev-seats",
    eventId: "evt_001",
    seatId: "A-12-07",
    holdId: "h_test",
    holdOwner: "alice",
    expiresAt: "2026-11-01T20:05:00.000Z",
    now: "2026-11-01T20:00:00.000Z",
  });

  it("targets the seat key", () => {
    assert.equal(input.TableName, "gatehold-dev-seats");
    assert.deepEqual(input.Key, { eventId: "evt_001", seatId: "A-12-07" });
  });

  it("sets hold fields without touching version", () => {
    assert.match(input.UpdateExpression, /SET #status = :held/);
    assert.match(input.UpdateExpression, /holdId = :holdId/);
    assert.match(input.UpdateExpression, /holdOwner = :holdOwner/);
    assert.match(input.UpdateExpression, /expiresAt = :expiresAt/);
    assert.doesNotMatch(input.UpdateExpression, /version/);
  });

  it("allows AVAILABLE or expired HELD reclaim", () => {
    assert.equal(
      input.ConditionExpression,
      "#status = :available OR (#status = :held AND expiresAt < :now)",
    );
    assert.equal(input.ExpressionAttributeNames["#status"], "status");
    assert.equal(input.ExpressionAttributeValues[":available"], "AVAILABLE");
    assert.equal(input.ExpressionAttributeValues[":held"], "HELD");
    assert.equal(
      input.ExpressionAttributeValues[":now"],
      "2026-11-01T20:00:00.000Z",
    );
  });
});

describe("holdExpiresAt", () => {
  it("adds HOLD_DURATION_MS to the reference time", () => {
    const nowMs = Date.parse("2026-11-01T20:00:00.000Z");
    assert.equal(HOLD_DURATION_MS, 5 * 60 * 1000);
    assert.equal(
      holdExpiresAt(nowMs),
      new Date(nowMs + HOLD_DURATION_MS).toISOString(),
    );
  });
});
