import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAttachRefundBatchUpdateInput,
  buildCancelEventUpdateInput,
  buildMarkEventCancelledUpdateInput,
} from "./event";

describe("buildCancelEventUpdateInput", () => {
  it("sets CANCELLING from ON_SALE with cancelledAt", () => {
    const input = buildCancelEventUpdateInput({
      tableName: "gatehold-dev-events",
      eventId: "evt_001",
      cancelledAt: "2026-11-01T20:00:00.000Z",
    });
    assert.equal(
      input.UpdateExpression,
      "SET #status = :cancelling, cancelledAt = :cancelledAt",
    );
    assert.match(input.ConditionExpression, /#status = :onSale/);
    assert.equal(input.ExpressionAttributeValues[":cancelling"], "CANCELLING");
    assert.equal(input.ExpressionAttributeValues[":onSale"], "ON_SALE");
    assert.equal(
      input.ExpressionAttributeValues[":cancelledAt"],
      "2026-11-01T20:00:00.000Z",
    );
  });
});

describe("buildAttachRefundBatchUpdateInput", () => {
  it("sets refundBatchId only while CANCELLING and unset", () => {
    const input = buildAttachRefundBatchUpdateInput({
      tableName: "gatehold-dev-events",
      eventId: "evt_001",
      refundBatchId: "rb_1",
    });
    assert.equal(input.UpdateExpression, "SET refundBatchId = :batchId");
    assert.match(input.ConditionExpression, /attribute_not_exists\(refundBatchId\)/);
    assert.equal(input.ExpressionAttributeValues[":batchId"], "rb_1");
    assert.equal(input.ExpressionAttributeValues[":cancelling"], "CANCELLING");
  });
});

describe("buildMarkEventCancelledUpdateInput", () => {
  it("allows CANCELLING or already CANCELLED", () => {
    const input = buildMarkEventCancelledUpdateInput({
      tableName: "gatehold-dev-events",
      eventId: "evt_001",
    });
    assert.equal(input.UpdateExpression, "SET #status = :cancelled");
    assert.match(
      input.ConditionExpression,
      /#status = :cancelling OR #status = :cancelled/,
    );
    assert.equal(input.ExpressionAttributeValues[":cancelled"], "CANCELLED");
  });
});
