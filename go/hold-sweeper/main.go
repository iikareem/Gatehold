package main

import (
	"context"
	"log"
	"os"

	"github.com/aws/aws-lambda-go/lambda"
)

// Hold sweeper — releases expired holds that were never converted to PAYING/SOLD.
// Phase 2: manual go run against MiniStack. Phase 2b: EventBridge Scheduler → Lambda.

func main() {
	if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
		lambda.Start(handler)
		return
	}

	if err := Run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

// handler ignores the Scheduler payload and runs one sweep.
func handler(ctx context.Context) error {
	return Run(ctx)
}
