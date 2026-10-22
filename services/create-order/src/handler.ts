/**
 * Create order Lambda — wired to POST /orders.
 * Stub until shared builders + accept logic (idempotency, PAYING, PENDING, SQS → 202).
 */

export async function handler(_event: unknown): Promise<{ statusCode: number; body: string }> {
  return {
    statusCode: 501,
    body: JSON.stringify({ message: "TODO: implement create-order" }),
  };
}
