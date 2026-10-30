import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";

/**
 * DynamoDB write grant that matches TransactWriteItems call sites.
 *
 * CDK `grantWriteData` covers Put/Update/Delete/BatchWrite but omits
 * `dynamodb:TransactWriteItems`, which hold/order/confirm/release need.
 */
export function grantTableWriteWithTransact(
  table: dynamodb.ITable,
  fn: lambda.IFunction,
): void {
  table.grantWriteData(fn);
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["dynamodb:TransactWriteItems"],
      resources: [table.tableArn],
    }),
  );
}
