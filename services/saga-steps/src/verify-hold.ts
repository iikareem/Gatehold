import type { SagaInput } from "../../shared/src/types";

/**
 * Phase 6 Slice 1 — stub VerifyHold Task.
 * Echoes saga input so the state machine can reach Succeed.
 * Real checks (order PENDING, event ON_SALE, seats PAYING / payUntil) land in Slice 2.
 */
export async function handler(event: SagaInput): Promise<SagaInput> {
  return event;
}
