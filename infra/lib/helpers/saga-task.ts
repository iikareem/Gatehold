import * as cdk from "aws-cdk-lib";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import {LambdaInvoke} from "aws-cdk-lib/aws-stepfunctions-tasks";
import {Construct} from "constructs";

/**
 * Bridge: turn a Lambda into a Step Functions task/state.
 *
 * A Lambda alone is just a function. This wraps it so the saga can use it as
 * a step — invoke it, unwrap `$.Payload` for the next state, and retry on
 * TransientError (plus AWS service exceptions).
 *
 * Timeout stays on the Lambda (`createNodeFn`). Catch / compensation are
 * wired on the returned task by the caller (`.addCatch(...)`).
 *
 * Business errors (e.g. VerifyHoldError) are not listed → execution fails
 * (or hits Catch) instead of retrying forever.
 */
export function createSagaTask(
    scope: Construct,
    id: string,
    lambdaFunction: lambda.IFunction,
): LambdaInvoke {
    const task = new tasks.LambdaInvoke(scope, id, {
        lambdaFunction,
        outputPath: "$.Payload",
        retryOnServiceExceptions: true,
    });
    task.addRetry({
        errors: ["TransientError"],
        interval: cdk.Duration.seconds(2),
        maxAttempts: 3,
        backoffRate: 2,
    });
    return task;
}
