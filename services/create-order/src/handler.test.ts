import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import * as dynamodb from "../../shared/src/dynamodb";
import * as sqs from "../../shared/src/sqs";
import { handler } from "./handler";

const ALICE_SUB = "alice-sub-001";

function orderEvent(
  overrides: {
    body?: string | null;
    headers?: Record<string, string>;
    sub?: string | null;
  } = {},
): APIGatewayProxyEvent {
  const sub = overrides.sub === null ? undefined : (overrides.sub ?? ALICE_SUB);
  return {
    body:
      overrides.body === undefined
        ? JSON.stringify({
            eventId: "evt_001",
            holdId: "h_test",
            seatIds: ["A-12-07"],
          })
        : overrides.body,
    headers: overrides.headers ?? {
      "Idempotency-Key": "idem-1",
    },
    multiValueHeaders: {},
    httpMethod: "POST",
    isBase64Encoded: false,
    path: "/orders",
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: "/orders",
    requestContext: {
      authorizer: sub
        ? { claims: { sub, "cognito:username": "alice" } }
        : undefined,
    } as APIGatewayProxyEvent["requestContext"],
  };
}

function setEnv() {
  process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
  process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
  process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
  process.env.IDEMPOTENCY_TABLE_NAME = "gatehold-dev-idempotency";
  process.env.ORDER_QUEUE_URL =
    "http://localhost:4566/000000000000/gatehold-dev-orders";
}

describe("create-order handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.SEATS_TABLE_NAME;
    delete process.env.EVENTS_TABLE_NAME;
    delete process.env.ORDERS_TABLE_NAME;
    delete process.env.IDEMPOTENCY_TABLE_NAME;
    delete process.env.ORDER_QUEUE_URL;
  });

  it("returns 401 when authorizer claims are missing", async () => {
    setEnv();
    const result = await handler(orderEvent({ sub: null }));
    assert.equal(result.statusCode, 401);
  });

  it("returns 400 when Idempotency-Key is missing", async () => {
    setEnv();
    const result = await handler(orderEvent({ headers: {} }));
    assert.equal(result.statusCode, 400);
  });

  it("returns 400 when seatIds is empty or over the cap", async () => {
    setEnv();
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        throw new Error("should not call DynamoDB");
      },
    }));

    const empty = await handler(
      orderEvent({
        body: JSON.stringify({
          eventId: "evt_001",
          holdId: "h_test",
          seatIds: [],
        }),
      }),
    );
    assert.equal(empty.statusCode, 400);

    const nine = Array.from({ length: 9 }, (_, i) => `A-12-0${i + 1}`);
    const tooMany = await handler(
      orderEvent({
        body: JSON.stringify({
          eventId: "evt_001",
          holdId: "h_test",
          seatIds: nine,
        }),
      }),
    );
    assert.equal(tooMany.statusCode, 400);
  });

  it("returns 202 when txn and SQS succeed", async () => {
    setEnv();
    const ddbSend = mock.fn(async () => ({}));
    const sqsSend = mock.fn(async () => ({}));
    mock.method(dynamodb, "getDocClient", () => ({ send: ddbSend }));
    mock.method(sqs, "getSqsClient", () => ({ send: sqsSend }));

    const result = await handler(orderEvent());

    assert.equal(result.statusCode, 202);
    const body = JSON.parse(result.body);
    assert.match(body.orderId, /^ord_/);
    assert.equal(body.status, "PENDING");
    // TransactWrite + Update idempotency ACCEPTED
    assert.equal(ddbSend.mock.callCount(), 2);
    assert.equal(sqsSend.mock.callCount(), 1);
  });

  it("returns 409 when seat/event conditions fail", async () => {
    setEnv();
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        const err = new Error("Transaction cancelled") as Error & {
          CancellationReasons: Array<{ Code: string }>;
        };
        err.name = "TransactionCanceledException";
        // First item (idempotency) ok; a later seat/event check failed
        err.CancellationReasons = [
          { Code: "None" },
          { Code: "ConditionalCheckFailed" },
        ];
        throw err;
      },
    }));
    mock.method(sqs, "getSqsClient", () => ({
      send: async () => {
        throw new Error("should not call SQS");
      },
    }));

    const result = await handler(orderEvent());
    assert.equal(result.statusCode, 409);
    const body = JSON.parse(result.body);
    assert.equal(body.message, "order not acceptable");
  });

  it("returns stored 202 when idempotency key was already ACCEPTED", async () => {
    setEnv();
    const stored = { orderId: "ord_existing", status: "PENDING" };
    let call = 0;
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        call += 1;
        if (call === 1) {
          const err = new Error("Transaction cancelled") as Error & {
            CancellationReasons: Array<{ Code: string }>;
          };
          err.name = "TransactionCanceledException";
          err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
          throw err;
        }
        return {
          Item: {
            key: "idem-1",
            status: "ACCEPTED",
            responseStatus: 202,
            responseBody: JSON.stringify(stored),
            orderId: "ord_existing",
          },
        };
      },
    }));
    mock.method(sqs, "getSqsClient", () => ({
      send: async () => {
        throw new Error("should not call SQS");
      },
    }));

    const result = await handler(orderEvent());
    assert.equal(result.statusCode, 202);
    assert.deepEqual(JSON.parse(result.body), stored);
  });

  it("returns 409 in progress when idempotency key is IN_PROGRESS", async () => {
    setEnv();
    let call = 0;
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        call += 1;
        if (call === 1) {
          const err = new Error("Transaction cancelled") as Error & {
            CancellationReasons: Array<{ Code: string }>;
          };
          err.name = "TransactionCanceledException";
          err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
          throw err;
        }
        return {
          Item: {
            key: "idem-1",
            status: "IN_PROGRESS",
            orderId: "ord_inflight",
          },
        };
      },
    }));

    const result = await handler(orderEvent());
    assert.equal(result.statusCode, 409);
    const body = JSON.parse(result.body);
    assert.equal(body.message, "in progress");
    assert.equal(body.orderId, "ord_inflight");
  });

  it("returns 500 when SQS fails after a successful txn", async () => {
    setEnv();
    const ddbSend = mock.fn(async () => ({}));
    mock.method(dynamodb, "getDocClient", () => ({ send: ddbSend }));
    mock.method(sqs, "getSqsClient", () => ({
      send: async () => {
        throw new Error("SQS down");
      },
    }));

    const result = await handler(orderEvent());
    assert.equal(result.statusCode, 500);
    const body = JSON.parse(result.body);
    assert.equal(body.message, "failed to enqueue order");
    assert.match(body.orderId, /^ord_/);
    // Only the TransactWrite — no ACCEPTED update
    assert.equal(ddbSend.mock.callCount(), 1);
  });
});
