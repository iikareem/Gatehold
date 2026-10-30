import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import * as dynamodb from "../../shared/src/dynamodb";
import * as s3 from "../../shared/src/s3";
import { handler } from "./handler";

const ALICE_SUB = "alice-sub-001";
const BOB_SUB = "bob-sub-002";

function getOrderEvent(
  overrides: {
    orderId?: string | null;
    sub?: string | null;
  } = {},
): APIGatewayProxyEvent {
  const sub = overrides.sub === null ? undefined : (overrides.sub ?? ALICE_SUB);
  const orderId =
    overrides.orderId === null
      ? undefined
      : (overrides.orderId ?? "ord_1");
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: "GET",
    isBase64Encoded: false,
    path: `/orders/${orderId ?? ""}`,
    pathParameters: orderId ? { orderId } : null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: "/orders/{orderId}",
    requestContext: {
      authorizer: sub
        ? { claims: { sub, "cognito:username": "alice" } }
        : undefined,
    } as APIGatewayProxyEvent["requestContext"],
  };
}

function setEnv() {
  process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
  process.env.TICKETS_BUCKET = "gatehold-dev-tickets";
}

describe("get-order handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.ORDERS_TABLE_NAME;
    delete process.env.TICKETS_BUCKET;
  });

  it("returns 401 when authorizer claims are missing", async () => {
    setEnv();
    const result = await handler(getOrderEvent({ sub: null }));
    assert.equal(result.statusCode, 401);
  });

  it("returns 400 when orderId path param is missing", async () => {
    setEnv();
    const result = await handler(getOrderEvent({ orderId: null }));
    assert.equal(result.statusCode, 400);
  });

  it("returns 404 when order does not exist", async () => {
    setEnv();
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({ Item: undefined }),
    }));
    mock.method(s3, "presignTicketGetUrl", async () => {
      throw new Error("should not presign");
    });

    const result = await handler(getOrderEvent());
    assert.equal(result.statusCode, 404);
    assert.equal(JSON.parse(result.body).message, "order not found");
  });

  it("returns 404 when caller is not the order owner", async () => {
    setEnv();
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({
        Item: {
          orderId: "ord_1",
          userId: ALICE_SUB,
          eventId: "evt_001",
          holdId: "h_1",
          seatIds: ["A-12-07"],
          status: "CONFIRMED",
          createdAt: "2026-01-01T00:00:00.000Z",
          ticketIds: ["tkt:ord_1:A-12-07"],
        },
      }),
    }));
    mock.method(s3, "presignTicketGetUrl", async () => {
      throw new Error("should not presign for non-owner");
    });

    const result = await handler(getOrderEvent({ sub: BOB_SUB }));
    assert.equal(result.statusCode, 404);
  });

  it("returns PENDING order without ticket download URLs", async () => {
    setEnv();
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({
        Item: {
          orderId: "ord_1",
          userId: ALICE_SUB,
          eventId: "evt_001",
          holdId: "h_1",
          seatIds: ["A-12-07"],
          status: "PENDING",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    }));
    mock.method(s3, "presignTicketGetUrl", async () => {
      throw new Error("should not presign for PENDING");
    });

    const result = await handler(getOrderEvent());
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.status, "PENDING");
    assert.equal(body.tickets, undefined);
  });

  it("returns CONFIRMED order with presigned ticket URLs", async () => {
    setEnv();
    const ticketIds = ["tkt:ord_1:A-12-07", "tkt:ord_1:A-12-08"];
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({
        Item: {
          orderId: "ord_1",
          userId: ALICE_SUB,
          eventId: "evt_001",
          holdId: "h_1",
          seatIds: ["A-12-07", "A-12-08"],
          status: "CONFIRMED",
          createdAt: "2026-01-01T00:00:00.000Z",
          amount: 5000,
          ticketIds,
        },
      }),
    }));

    const keys: string[] = [];
    mock.method(s3, "presignTicketGetUrl", async (params: { key: string }) => {
      keys.push(params.key);
      return `https://example.test/${params.key}?X-Amz-Signature=test`;
    });

    const result = await handler(getOrderEvent());
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.status, "CONFIRMED");
    assert.deepEqual(body.ticketIds, ticketIds);
    assert.equal(body.amount, 5000);
    assert.equal(body.tickets.length, 2);
    assert.equal(body.tickets[0].ticketId, "tkt:ord_1:A-12-07");
    assert.equal(body.tickets[0].expiresInSeconds, 900);
    assert.match(body.tickets[0].downloadUrl, /X-Amz-Signature=test/);
    assert.deepEqual(keys, [
      "tickets/tkt:ord_1:A-12-07.json",
      "tickets/tkt:ord_1:A-12-08.json",
    ]);
  });
});
