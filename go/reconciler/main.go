package main

import (
	"context"
	"log"
	"os"

	"github.com/aws/aws-lambda-go/lambda"
)

// Reconciler — detect-only: CONFIRMED orders whose seats are not SOLD for that orderId.
// Slice 12c: Events → Orders GSI → GetItem seats → structured logs (no repair writes).

func main() {
	if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
		lambda.Start(handler)
		return
	}

	if err := Run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

// handler ignores the Scheduler payload and runs one reconcile pass.
func handler(ctx context.Context) error {
	return Run(ctx)
}
