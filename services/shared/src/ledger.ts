import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { PutCommandInput } from "@aws-sdk/lib-dynamodb";
import type { LedgerItem, LedgerKind } from "./types";

export interface AppendLedgerParams {
  tableName: string;
  item: LedgerItem;
}

/**
 * Append-only ledger Put. Succeeds only for the first write of this pk.
 * Caller treats ConditionalCheckFailedException as "already recorded."
 */
export function buildAppendLedgerPutInput(
  params: AppendLedgerParams,
): PutCommandInput {
  const { tableName, item } = params;
  return {
    TableName: tableName,
    Item: item,
    ConditionExpression: "attribute_not_exists(pk)",
  };
}

export async function appendLedgerItem(
  send: (cmd: PutCommand) => Promise<unknown>,
  params: AppendLedgerParams,
): Promise<"inserted" | "already_exists"> {
  try {
    await send(new PutCommand(buildAppendLedgerPutInput(params)));
    return "inserted";
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return "already_exists";
    }
    throw err;
  }
}

export function buildLedgerItem(input: {
  pk: string;
  kind: LedgerKind;
  orderId: string;
  amount: number;
  currency: string;
  createdAt: string;
  providerPaymentId?: string;
  authorizationId?: string;
}): LedgerItem {
  const item: LedgerItem = {
    pk: input.pk,
    kind: input.kind,
    orderId: input.orderId,
    amount: input.amount,
    currency: input.currency,
    createdAt: input.createdAt,
  };
  if (input.providerPaymentId) {
    item.providerPaymentId = input.providerPaymentId;
  }
  if (input.authorizationId) {
    item.authorizationId = input.authorizationId;
  }
  return item;
}

export function isConditionalCheckFailed(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { name?: string }).name === "ConditionalCheckFailedException";
}
