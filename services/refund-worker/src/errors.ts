/** Transient failure — leave the SQS message for retry. */
export class TransientRefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientRefundError";
  }
}

/** Terminal failure — ack the message after recording batch.failed. */
export class PermanentRefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentRefundError";
  }
}
