/**
 * Phase 9a — seed Cognito fan + admin users (MiniStack or real AWS).
 *
 * Prereq: stack deployed (UserPoolId / UserPoolClientId in .cdk-outputs.json).
 * Run from the **repo root** (Gatehold/), not go/:
 *
 *   cd /path/to/Gatehold
 *   set -a && source .env.example && set +a
 *   npm run seed:auth
 *
 * If env is not sourced, defaults to MiniStack endpoint + test credentials.
 * Default passwords (local only): Gatehold1!
 */

import * as fs from "fs";
import * as path from "path";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  InitiateAuthCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { createCognitoIdpClient } from "../services/shared/src/cognito";

const ADMIN_GROUP = "admin";
const DEFAULT_PASSWORD = "Gatehold1!";
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUTS_PATH = path.join(REPO_ROOT, ".cdk-outputs.json");

type SeedUser = {
  username: string;
  password: string;
  groups: string[];
};

const USERS: SeedUser[] = [
  { username: "alice", password: DEFAULT_PASSWORD, groups: [] },
  { username: "admin", password: DEFAULT_PASSWORD, groups: [ADMIN_GROUP] },
];

/** Apply MiniStack-friendly defaults when env was not sourced. */
function ensureLocalAwsEnv(): void {
  if (!process.env.AWS_ENDPOINT_URL) {
    process.env.AWS_ENDPOINT_URL = "http://localhost.localstack.cloud:4566";
  }
  if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_DEFAULT_REGION = "us-east-1";
  }
  if (!process.env.AWS_ACCESS_KEY_ID) {
    process.env.AWS_ACCESS_KEY_ID = "test";
  }
  if (!process.env.AWS_SECRET_ACCESS_KEY) {
    process.env.AWS_SECRET_ACCESS_KEY = "test";
  }
}

function readOutput(key: string): string | undefined {
  try {
    const raw = fs.readFileSync(OUTPUTS_PATH, "utf8");
    const outputs = JSON.parse(raw) as Record<string, Record<string, string>>;
    const stack = outputs["Gatehold-dev"] ?? Object.values(outputs)[0];
    return stack?.[key];
  } catch {
    return undefined;
  }
}

function envOrOutput(envKey: string, outputKey: string): string {
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) return fromEnv;
  const fromOut = readOutput(outputKey);
  if (fromOut) return fromOut;
  throw new Error(
    `${envKey} missing — deploy first (writes .cdk-outputs.json) or set env`,
  );
}

async function ensureUser(
  client: ReturnType<typeof createCognitoIdpClient>,
  userPoolId: string,
  user: SeedUser,
): Promise<string> {
  try {
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: user.username,
        MessageAction: "SUPPRESS",
        TemporaryPassword: user.password,
      }),
    );
  } catch (err) {
    if (!(err instanceof UsernameExistsException)) {
      throw err;
    }
  }

  await client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: user.username,
      Password: user.password,
      Permanent: true,
    }),
  );

  for (const group of user.groups) {
    await client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: user.username,
        GroupName: group,
      }),
    );
  }

  const got = await client.send(
    new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: user.username,
    }),
  );
  const sub = got.UserAttributes?.find((a) => a.Name === "sub")?.Value;
  if (!sub) {
    throw new Error(`missing sub for user ${user.username}`);
  }
  return sub;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) {
    throw new Error("malformed JWT");
  }
  const json = Buffer.from(part, "base64url").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

async function main(): Promise<void> {
  // Real AWS: set USER_POOL_ID and leave AWS_ENDPOINT_URL unset.
  // Otherwise default to MiniStack endpoint + test credentials.
  const realAws =
    Boolean(process.env.USER_POOL_ID) && !process.env.AWS_ENDPOINT_URL;
  if (!realAws) {
    ensureLocalAwsEnv();
  }

  const userPoolId = envOrOutput("USER_POOL_ID", "UserPoolId");
  const clientId = envOrOutput("USER_POOL_CLIENT_ID", "UserPoolClientId");

  const client = createCognitoIdpClient();
  const seeded: Array<{
    username: string;
    sub: string;
    groups: string[];
    claims?: Record<string, unknown>;
  }> = [];

  for (const user of USERS) {
    const sub = await ensureUser(client, userPoolId, user);

    const auth = await client.send(
      new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: {
          USERNAME: user.username,
          PASSWORD: user.password,
        },
      }),
    );
    const idToken = auth.AuthenticationResult?.IdToken;
    if (!idToken) {
      throw new Error(`InitiateAuth returned no IdToken for ${user.username}`);
    }

    seeded.push({
      username: user.username,
      sub,
      groups: user.groups,
      claims: decodeJwtPayload(idToken),
    });
  }

  console.log(
    JSON.stringify(
      {
        userPoolId,
        userPoolClientId: clientId,
        password: DEFAULT_PASSWORD,
        note: "API still uses X-User-Id stub until Phase 9b",
        users: seeded.map((u) => ({
          username: u.username,
          sub: u.sub,
          groups: u.groups,
          cognitoGroups: u.claims?.["cognito:groups"] ?? [],
          cognitoUsername: u.claims?.["cognito:username"],
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
