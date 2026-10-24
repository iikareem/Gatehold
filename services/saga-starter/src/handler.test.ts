import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { ExecutionAlreadyExists } from "@aws-sdk/client-sfn";
import * as dynamodb from "../../shared/src/dynamodb";
import * as sfn from "../../shared/src/sfn";
import { handler } from "./handler";

function sqsEvent(bodies: string[]): SQSEvent {
  return {
    Records: bodies.map(
      (body, i): SQSRecord => ({
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
        eventSourceARN: "arn:aws:sqs:us-east-1:000000000000:gatehold-dev-orders",
        awsRegion: "us-east-1",
      }),
    ),
  };
}

const goodBody = JSON.stringify({
  orderId: "ord_1",
  eventId: "evt_001",
  holdId: "h_1",
  seatIds: ["A-12-07"],
  userId: "alice",
});

function setEnv() {
  process.env.PURCHASE_SAGA_ARN =
    "arn:aws:states:us-east-1:000000000000:stateMachine:gatehold-dev-purchase-saga";
  process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
}

describe("saga-starter handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.PURCHASE_SAGA_ARN;
    delete process.env.ORDERS_TABLE_NAME;
  });

  it("starts an execution named after orderId and stores executionArn", async () => {
    setEnv();
    const sfnCalls: unknown[] = [];
    const ddbCalls: unknown[] = [];

    mock.method(sfn, "getSfnClient", () => ({
      send: async (cmd: { input: unknown }) => {
        sfnCalls.push(cmd.input);
        return {
          executionArn:
            "arn:aws:states:us-east-1:000000000000:execution:gatehold-dev-purchase-saga:ord_1",
          startDate: new Date(),
        };
      },
    }));
    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: { input: unknown }) => {
        ddbCalls.push(cmd.input);
        return {};
      },
    }));

    const result = await handler(sqsEvent([goodBody]));
    assert.deepEqual(result.batchItemFailures, []);
    assert.equal(sfnCalls.length, 1);
    const startInput = sfnCalls[0] as {
      name: string;
      input: string;
      stateMachineArn: string;
    };
    assert.equal(startInput.name, "ord_1");
    assert.equal(startInput.input, goodBody);
    assert.match(startInput.stateMachineArn, /purchase-saga/);
    assert.equal(ddbCalls.length, 1);
  });

  it("acks when ExecutionAlreadyExists (no batch failure)", async () => {
    setEnv();
    mock.method(sfn, "getSfnClient", () => ({
      send: async () => {
        throw new ExecutionAlreadyExists({
          message: "Execution Already Exists: 'ord_1'",
          $metadata: {},
        });
      },
    }));
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        throw new Error("should not update order");
      },
    }));

    const result = await handler(sqsEvent([goodBody]));
    assert.deepEqual(result.batchItemFailures, []);
  });

  it("reports batch failure for invalid JSON body", async () => {
    setEnv();
    mock.method(sfn, "getSfnClient", () => ({
      send: async () => {
        throw new Error("should not start");
      },
    }));

    const result = await handler(sqsEvent(["not-json"]));
    assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: "msg-0" }]);
  });
});
