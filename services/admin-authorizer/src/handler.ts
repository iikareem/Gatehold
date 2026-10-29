import type {
  APIGatewayAuthorizerResult,
  APIGatewayTokenAuthorizerEvent,
} from "aws-lambda";
import { JwtVerifier } from "aws-jwt-verify";
import {
  ADMIN_GROUP_NAME,
  hasAdminGroup,
  requireEnv,
} from "../../shared/src";

/**
 * Phase 9c — TOKEN authorizer for /admin/* routes.
 *
 * Verifies Cognito IdToken (signature via JWKS), then requires `admin` group.
 * Invalid/missing token → throw Unauthorized (API Gateway 401).
 * Valid fan JWT → Deny policy (API Gateway 403) before admin Lambdas run.
 * Admin JWT → Allow (+ sub/username in context).
 */
export async function handler(
  event: APIGatewayTokenAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> {
  const token = extractBearerToken(event.authorizationToken);
  if (!token) {
    throw new Error("Unauthorized");
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await getVerifier().verify(token)) as Record<string, unknown>;
  } catch {
    throw new Error("Unauthorized");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) {
    throw new Error("Unauthorized");
  }

  const methodArn = event.methodArn;
  if (!hasAdminGroup(payload, adminGroupName())) {
    return policy(sub, "Deny", methodArn);
  }

  const username =
    typeof payload["cognito:username"] === "string"
      ? payload["cognito:username"]
      : "";

  return policy(sub, "Allow", methodArn, {
    sub,
    username,
    groups: ADMIN_GROUP_NAME,
  });
}

function extractBearerToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return (match?.[1] ?? trimmed).trim() || undefined;
}

function adminGroupName(): string {
  return process.env.ADMIN_GROUP_NAME || ADMIN_GROUP_NAME;
}

function jwksUri(): string {
  const poolId = requireEnv("USER_POOL_ID");
  const endpoint = process.env.AWS_ENDPOINT_URL?.replace(/\/$/, "");
  if (endpoint) {
    return `${endpoint}/${poolId}/.well-known/jwks.json`;
  }
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  return `https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`;
}

let verifier: ReturnType<typeof JwtVerifier.create> | undefined;

/** Test helper — drop cached JwtVerifier between cases. */
export function resetVerifierForTests(): void {
  verifier = undefined;
}

function getVerifier(): ReturnType<typeof JwtVerifier.create> {
  if (!verifier) {
    verifier = JwtVerifier.create({
      issuer: requireEnv("USER_POOL_ISSUER"),
      audience: requireEnv("USER_POOL_CLIENT_ID"),
      jwksUri: jwksUri(),
    });
  }
  return verifier;
}

function policy(
  principalId: string,
  effect: "Allow" | "Deny",
  resource: string,
  context?: Record<string, string>,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    ...(context ? { context } : {}),
  };
}
