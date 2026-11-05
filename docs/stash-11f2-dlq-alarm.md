# Stashed: Slice 11f2 — Refund DLQ alarm

Parked while checking **11f1 EventBridge sweeper**. Restore after 11f1 looks good.

**Not in `main.go`.** 11f2 is only CloudWatch alarm + stack output.

## Restore into `infra/lib/constructs/cancel-refund.ts`

```ts
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
```

On the construct class:

```ts
  readonly refundDlqAlarm: cloudwatch.Alarm;
```

After the refund-worker SQS event source:

```ts
    this.refundDlqAlarm = new cloudwatch.Alarm(this, "RefundDlqDepthAlarm", {
      alarmName: `gatehold-${stage}-refunds-dlq-depth`,
      alarmDescription:
        "Refund DLQ has visible messages — inspect and redrive manually",
      metric: this.refundDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
```

## Restore into `infra/lib/helpers/stack-outputs.ts`

```ts
  new cdk.CfnOutput(stack, "RefundDlqAlarmName", {
    value: cancelRefund.refundDlqAlarm.alarmName,
    description: "Phase 11f2 — alarm when refund DLQ has visible messages",
  });
```
