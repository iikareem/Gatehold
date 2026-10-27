package main

import (
	"context"
	"log"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

// Stream relay — DynamoDB Streams on Orders → EventBridge domain events.
// Phase 8b: PENDING→CONFIRMED → PutEvents OrderConfirmed.

func main() {
	if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
		lambda.Start(handler)
		return
	}

	log.Println("stream-relay: Lambda-only binary (invoke via DynamoDB Streams)")
}

func handler(ctx context.Context, event events.DynamoDBEvent) error {
	return HandleStream(ctx, event)
}
