import type { APIGatewayProxyEvent } from "aws-lambda";

/**
 * Caller identity from API Gateway Cognito authorizer claims.
 * Prefer `sub` (stable Cognito user id). No X-User-Id fallback.
 */
export function callerUserId(
  event: APIGatewayProxyEvent,
): string | undefined {
  const authorizer = event.requestContext?.authorizer;
  if (!authorizer || typeof authorizer !== "object") {
    return undefined;
  }

  const claims = authorizer.claims;
  if (claims && typeof claims === "object") {
    const sub = (claims as Record<string, unknown>).sub;
    if (typeof sub === "string" && sub.length > 0) {
      return sub;
    }
  }

  // Some local/event shapes flatten claims onto authorizer.
  const flatSub = (authorizer as Record<string, unknown>).sub;
  if (typeof flatSub === "string" && flatSub.length > 0) {
    return flatSub;
  }

  return undefined;
}
