package main

import (
	"context"
	"log"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

// notify-email — SQS (SNS→EventBridge OrderConfirmed) → SES SendEmail.
// Phase 8d: drain gatehold-{stage}-order-notifications.

func main() {
	if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
		lambda.Start(handler)
		return
	}

	log.Println("notify-email: Lambda-only binary (invoke via SQS)")
}

func handler(ctx context.Context, event events.SQSEvent) (events.SQSEventResponse, error) {
	return HandleSQS(ctx, event)
}
