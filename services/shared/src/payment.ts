/** Provider HTTP shapes — keep in sync with docs/contracts.md / go/mock-payment. */

export interface AuthorizePaymentRequest {
  idempotencyKey: string;
  orderId: string;
  amount: number;
  currency: string;
}

export interface FollowUpPaymentRequest {
  idempotencyKey: string;
  orderId: string;
  authorizationId: string;
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
  return postPayment(baseUrl, "/v1/payments/authorize", body, "authorize", fetchFn);
}

/**
 * POST /v1/payments/capture — requires prior AUTHORIZED authorizationId.
 * Key: pay:capture:{orderId}.
 */
export async function captureWithProvider(
  baseUrl: string,
  body: FollowUpPaymentRequest,
  fetchFn: typeof fetch = fetch,
): Promise<PaymentProviderResponse> {
  return postPayment(baseUrl, "/v1/payments/capture", body, "capture", fetchFn);
}

/**
 * POST /v1/payments/void — cancel AUTHORIZED funds (no money moved).
 * Key: pay:void:{orderId}.
 */
export async function voidWithProvider(
  baseUrl: string,
  body: FollowUpPaymentRequest,
  fetchFn: typeof fetch = fetch,
): Promise<PaymentProviderResponse> {
  return postPayment(baseUrl, "/v1/payments/void", body, "void", fetchFn);
}

/**
 * POST /v1/payments/refund — return CAPTURED funds.
 * Key: pay:refund:{orderId}.
 */
export async function refundWithProvider(
  baseUrl: string,
  body: FollowUpPaymentRequest,
  fetchFn: typeof fetch = fetch,
): Promise<PaymentProviderResponse> {
  return postPayment(baseUrl, "/v1/payments/refund", body, "refund", fetchFn);
}

async function postPayment(
  baseUrl: string,
  path: string,
  body: unknown,
  op: string,
  fetchFn: typeof fetch,
): Promise<PaymentProviderResponse> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PaymentProviderError(`payment ${op} network error: ${message}`, 0);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new PaymentProviderError(
      `payment ${op} invalid JSON (${response.status})`,
      response.status,
    );
  }

  if (!response.ok) {
    const errBody = parsed as { error?: string; code?: string };
    throw new PaymentProviderError(
      errBody.error || `payment ${op} failed (${response.status})`,
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
