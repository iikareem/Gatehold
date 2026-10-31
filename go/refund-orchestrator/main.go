package main

import (
	"context"
	"log"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

// refund-orchestrator — Events stream ON_SALE→CANCELLING → RefundBatch + SQS fan-out.
// Phase 11c: checkpointed Query of orders GSI eventId-status=CONFIRMED.

func main() {
	if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
		lambda.Start(handler)
		return
	}

	log.Println("refund-orchestrator: Lambda-only binary (invoke via Events DynamoDB Streams)")
}

func handler(ctx context.Context, event events.DynamoDBEvent) error {
	return HandleStream(ctx, event)
}
