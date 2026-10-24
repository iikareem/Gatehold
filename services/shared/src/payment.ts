/** Provider HTTP shapes — keep in sync with docs/contracts.md / go/mock-payment. */

export interface AuthorizePaymentRequest {
  idempotencyKey: string;
  orderId: string;
  amount: number;
  currency: string;
}

export interface PaymentProviderResponse {
  idempotencyKey: string;
  orderId: string;
  authorizationId?: string;
  paymentId?: string;
  status: string;
  amount: number;
  currency: string;
  failReason?: string;
}

export class PaymentProviderError extends Error {
  readonly statusCode: number;
  readonly code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = "PaymentProviderError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * POST /v1/payments/authorize against MOCK_PAYMENT_URL.
 * Same idempotency key returns the stored outcome from the mock.
 */
export async function authorizeWithProvider(
  baseUrl: string,
  body: AuthorizePaymentRequest,
  fetchFn: typeof fetch = fetch,
): Promise<PaymentProviderResponse> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/payments/authorize`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PaymentProviderError(`payment authorize network error: ${message}`, 0);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new PaymentProviderError(
      `payment authorize invalid JSON (${response.status})`,
      response.status,
    );
  }

  if (!response.ok) {
    const errBody = parsed as { error?: string; code?: string };
    throw new PaymentProviderError(
      errBody.error || `payment authorize failed (${response.status})`,
      response.status,
      errBody.code,
    );
  }

  return parsed as PaymentProviderResponse;
}

/** 429 / 5xx are worth a Step Functions retry; 4xx business errors are not. */
export function isRetryablePaymentStatus(statusCode: number): boolean {
  return statusCode === 0 || statusCode === 429 || statusCode >= 500;
}
