package main

import (
	"context"
	"encoding/json"
	"log"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

// refund-orchestrator — Events stream ON_SALE→CANCELLING → RefundBatch + SQS fan-out.
// Phase 11c: checkpointed Query of orders GSI eventId-status=CONFIRMED.
// Phase 11f1: EventBridge Scheduler also invokes this Lambda to resume stuck fan-outs.

func main() {
	if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
		lambda.Start(handler)
		return
	}

	log.Println("refund-orchestrator: Lambda-only binary (Events stream or sweeper schedule)")
}

func handler(ctx context.Context, raw json.RawMessage) error {
	var probe struct {
		Records json.RawMessage `json:"Records"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return err
	}
	if len(probe.Records) > 0 {
		var event events.DynamoDBEvent
		if err := json.Unmarshal(raw, &event); err != nil {
			return err
		}
		return HandleStream(ctx, event)
	}
	return HandleSweep(ctx)
}
