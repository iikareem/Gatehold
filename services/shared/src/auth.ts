import type { APIGatewayProxyEvent } from "aws-lambda";

/** Cognito group for cancel / refund operators (must match Auth construct). */
export const ADMIN_GROUP_NAME = "admin";

/**
 * True when Cognito JWT claims include the admin group.
 * `cognito:groups` may be a string or string[].
 */
export function hasAdminGroup(
  claims: Record<string, unknown> | undefined | null,
  groupName: string = ADMIN_GROUP_NAME,
): boolean {
  if (!claims) return false;
  const raw = claims["cognito:groups"];
  if (typeof raw === "string") {
    return raw === groupName;
  }
  if (Array.isArray(raw)) {
    return raw.some((g) => g === groupName);
  }
  return false;
}

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
