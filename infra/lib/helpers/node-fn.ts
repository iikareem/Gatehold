import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {
  NodejsFunction,
  type NodejsFunctionProps,
} from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

/** Repo root (infra/lib/helpers → ../../..). */
export const projectRoot = path.join(__dirname, "../../..");

const defaultBundling: NodejsFunctionProps["bundling"] = {
  minify: true,
  sourceMap: true,
  target: "node20",
};

export interface CreateNodeFnProps {
  stage: string;
  /** Short name → `gatehold-${stage}-${name}`. */
  name: string;
  /** Absolute path to the handler entry file. */
  entry: string;
  environment?: Record<string, string>;
  timeout?: cdk.Duration;
  memorySize?: number;
}

/**
 * Gatehold Node.js Lambda defaults (runtime, bundling, memory, handler).
 * Callers still pass stage-specific env and entry path.
 */
export function createNodeFn(
  scope: Construct,
  id: string,
  props: CreateNodeFnProps,
): NodejsFunction {
  const {
    stage,
    name,
    entry,
    environment = {},
    timeout = cdk.Duration.seconds(10),
    memorySize = 256,
  } = props;

  return new NodejsFunction(scope, id, {
    functionName: `gatehold-${stage}-${name}`,
    entry,
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_22_X,
    timeout,
    memorySize,
    environment,
    bundling: defaultBundling,
    projectRoot,
  });
}

/**
 * Base env shared by most Lambdas: stage, events/seats table names,
 * and MiniStack endpoint rewritten for Docker containers.
 */
export function baseLambdaEnv(
  stage: string,
  tables: { eventsTableName: string; seatsTableName: string },
): Record<string, string> {
  return {
    STAGE: stage,
    EVENTS_TABLE_NAME: tables.eventsTableName,
    SEATS_TABLE_NAME: tables.seatsTableName,
    ...(process.env.AWS_ENDPOINT_URL
      ? {
          AWS_ENDPOINT_URL: dockerReachableEndpoint(
            process.env.AWS_ENDPOINT_URL,
          ),
        }
      : {}),
  };
}

/**
 * Rewrite local emulator hosts so Lambda containers can reach MiniStack on the host.
 * `localhost`, `127.0.0.1`, and `*.localstack.cloud` all resolve to loopback inside
 * the container and must become `host.docker.internal` instead.
 */
export function dockerReachableEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    const isLoopback =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".localstack.cloud") ||
      host === "ministack";
    if (isLoopback) {
      url.hostname = "host.docker.internal";
      url.port = url.port || "4566";
      return url.toString().replace(/\/$/, "");
    }
  } catch {
    // leave as-is
  }
  return endpoint;
}
