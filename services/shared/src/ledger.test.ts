import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendLedgerItem,
  buildAppendLedgerPutInput,
  buildLedgerItem,
} from "./ledger";

describe("buildAppendLedgerPutInput", () => {
  it("requires attribute_not_exists(pk)", () => {
    const item = buildLedgerItem({
      pk: "pay:auth:ord_1",
      kind: "AUTH",
      orderId: "ord_1",
      amount: 5000,
      currency: "USD",
      createdAt: "2026-01-01T00:00:00.000Z",
      authorizationId: "auth_1",
    });
    const input = buildAppendLedgerPutInput({
      tableName: "gatehold-dev-ledger",
      item,
    });
    assert.equal(input.ConditionExpression, "attribute_not_exists(pk)");
    assert.equal(input.Item?.pk, "pay:auth:ord_1");
    assert.equal(input.Item?.kind, "AUTH");
  });
});

describe("appendLedgerItem", () => {
  it("returns inserted on success", async () => {
    const result = await appendLedgerItem(async () => ({}), {
      tableName: "ledger",
      item: buildLedgerItem({
        pk: "pay:auth:ord_1",
        kind: "AUTH",
        orderId: "ord_1",
        amount: 5000,
        currency: "USD",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    });
    assert.equal(result, "inserted");
  });

  it("returns already_exists on ConditionalCheckFailed", async () => {
    const result = await appendLedgerItem(
      async () => {
        const err = new Error(" ConditionalCheckFailed");
        err.name = "ConditionalCheckFailedException";
        throw err;
      },
      {
        tableName: "ledger",
        item: buildLedgerItem({
          pk: "pay:auth:ord_1",
          kind: "AUTH",
          orderId: "ord_1",
          amount: 5000,
          currency: "USD",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      },
    );
    assert.equal(result, "already_exists");
  });
});
