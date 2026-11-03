import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { SQSEvent } from "aws-lambda";
import { PermanentRefundError, TransientRefundError } from "./errors";
import { handler } from "./handler";
import * as processRefund from "./process-refund";

function sqsEvent(bodies: string[]): SQSEvent {
  return {
    Records: bodies.map((body, i) => ({
      messageId: `msg-${i}`,
      receiptHandle: `rh-${i}`,
      body,
      attributes: {
        ApproximateReceiveCount: "1",
        SentTimestamp: "0",
        SenderId: "test",
        ApproximateFirstReceiveTimestamp: "0",
      },
      messageAttributes: {},
      md5OfBody: "",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:us-east-1:123:refunds",
      awsRegion: "us-east-1",
    })),
  };
}

describe("refund-worker handler", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("acks successful messages", async () => {
    mock.method(processRefund, "processRefundJob", async () => undefined);

    const result = await handler(
      sqsEvent([
        JSON.stringify({
          orderId: "ord_1",
          eventId: "evt_001",
          batchId: "rb_1",
        }),
      ]),
    );
    assert.deepEqual(result.batchItemFailures, []);
  });

  it("reports transient failures for retry", async () => {
    mock.method(processRefund, "processRefundJob", async () => {
      throw new TransientRefundError("429");
    });

    const result = await handler(
      sqsEvent([
        JSON.stringify({
          orderId: "ord_1",
          eventId: "evt_001",
          batchId: "rb_1",
        }),
      ]),
    );
    assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: "msg-0" }]);
  });

  it("acks permanent failures after recording failed", async () => {
    mock.method(processRefund, "processRefundJob", async () => {
      throw new PermanentRefundError("not captured");
    });
    const recordFailed = mock.method(
      processRefund,
      "recordPermanentFailure",
      async () => undefined,
    );

    const result = await handler(
      sqsEvent([
        JSON.stringify({
          orderId: "ord_1",
          eventId: "evt_001",
          batchId: "rb_1",
        }),
      ]),
    );
    assert.deepEqual(result.batchItemFailures, []);
    assert.equal(recordFailed.mock.callCount(), 1);
    assert.equal(recordFailed.mock.calls[0]?.arguments[0], "rb_1");
  });
});
