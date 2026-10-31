import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCompleteRefundBatchUpdateInput,
  buildCreateRefundBatchPutInput,
  buildRefundBatchCheckpointUpdateInput,
  buildRefundBatchCounterUpdateInput,
} from "./refund-batch";

describe("buildCreateRefundBatchPutInput", () => {
  it("puts a RUNNING batch with zero counters", () => {
    const input = buildCreateRefundBatchPutInput({
      tableName: "gatehold-dev-refund-batches",
      batchId: "rb_1",
      eventId: "evt_001",
      startedAt: "2026-11-01T20:00:00.000Z",
    });
    assert.equal(input.ConditionExpression, "attribute_not_exists(batchId)");
    assert.deepEqual(input.Item, {
      batchId: "rb_1",
      eventId: "evt_001",
      status: "RUNNING",
      enqueued: 0,
      succeeded: 0,
      failed: 0,
      startedAt: "2026-11-01T20:00:00.000Z",
    });
  });
});

describe("buildRefundBatchCheckpointUpdateInput", () => {
  it("ADDs enqueued and stores lastEvaluatedKey", () => {
    const lek = { eventId: "evt_001", status: "CONFIRMED", orderId: "ord_1" };
    const input = buildRefundBatchCheckpointUpdateInput({
      tableName: "gatehold-dev-refund-batches",
      batchId: "rb_1",
      enqueuedDelta: 25,
      lastEvaluatedKey: lek,
    });
    assert.match(input.UpdateExpression, /^ADD enqueued :enqueuedDelta/);
    assert.match(input.UpdateExpression, /lastEvaluatedKey = :lek/);
    assert.equal(input.ExpressionAttributeValues[":enqueuedDelta"], 25);
    assert.deepEqual(input.ExpressionAttributeValues[":lek"], lek);
    assert.equal(input.ExpressionAttributeValues[":fanOutComplete"], false);
  });

  it("clears cursor and marks fanOutComplete when key is null", () => {
    const input = buildRefundBatchCheckpointUpdateInput({
      tableName: "gatehold-dev-refund-batches",
      batchId: "rb_1",
      enqueuedDelta: 3,
      lastEvaluatedKey: null,
    });
    assert.match(input.UpdateExpression, /REMOVE lastEvaluatedKey/);
    assert.equal(input.ExpressionAttributeValues[":fanOutComplete"], true);
  });

  it("rejects negative enqueuedDelta", () => {
    assert.throws(
      () =>
        buildRefundBatchCheckpointUpdateInput({
          tableName: "gatehold-dev-refund-batches",
          batchId: "rb_1",
          enqueuedDelta: -1,
        }),
      /non-negative integer/,
    );
  });
});

describe("buildRefundBatchCounterUpdateInput", () => {
  it("ADDs succeeded by default delta 1", () => {
    const input = buildRefundBatchCounterUpdateInput({
      tableName: "gatehold-dev-refund-batches",
      batchId: "rb_1",
      kind: "succeeded",
    });
    assert.equal(input.UpdateExpression, "ADD succeeded :delta");
    assert.equal(input.ExpressionAttributeValues[":delta"], 1);
  });
});

describe("buildCompleteRefundBatchUpdateInput", () => {
  it("moves RUNNING to COMPLETE with finishedAt", () => {
    const input = buildCompleteRefundBatchUpdateInput({
      tableName: "gatehold-dev-refund-batches",
      batchId: "rb_1",
      status: "COMPLETE",
      finishedAt: "2026-11-01T21:00:00.000Z",
    });
    assert.match(input.UpdateExpression, /#status = :done/);
    assert.match(
      input.ConditionExpression,
      /#status = :running OR #status = :done/,
    );
    assert.equal(input.ExpressionAttributeValues[":done"], "COMPLETE");
    assert.equal(
      input.ExpressionAttributeValues[":finishedAt"],
      "2026-11-01T21:00:00.000Z",
    );
  });
});
