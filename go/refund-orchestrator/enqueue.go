package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// RefundQueueMessage matches docs/contracts.md Phase 11.
type RefundQueueMessage struct {
	OrderID string `json:"orderId"`
	EventID string `json:"eventId"`
	BatchID string `json:"batchId"`
}

type sqsSender interface {
	SendMessageBatch(ctx context.Context, params *sqs.SendMessageBatchInput, optFns ...func(*sqs.Options)) (*sqs.SendMessageBatchOutput, error)
}

const sqsBatchMax = 10

// enqueueOrders sends one refund message per orderId (SendMessageBatch chunks of 10).
func enqueueOrders(
	ctx context.Context,
	client sqsSender,
	queueURL string,
	eventID string,
	batchID string,
	orderIDs []string,
) error {
	for i := 0; i < len(orderIDs); i += sqsBatchMax {
		end := i + sqsBatchMax
		if end > len(orderIDs) {
			end = len(orderIDs)
		}
		chunk := orderIDs[i:end]
		entries := make([]sqstypes.SendMessageBatchRequestEntry, 0, len(chunk))
		for j, orderID := range chunk {
			body, err := json.Marshal(RefundQueueMessage{
				OrderID: orderID,
				EventID: eventID,
				BatchID: batchID,
			})
			if err != nil {
				return fmt.Errorf("marshal refund message orderId=%s: %w", orderID, err)
			}
			entries = append(entries, sqstypes.SendMessageBatchRequestEntry{
				Id:          aws.String(fmt.Sprintf("%d", j)),
				MessageBody: aws.String(string(body)),
			})
		}

		out, err := client.SendMessageBatch(ctx, &sqs.SendMessageBatchInput{
			QueueUrl: aws.String(queueURL),
			Entries:  entries,
		})
		if err != nil {
			return fmt.Errorf("SendMessageBatch: %w", err)
		}
		if len(out.Failed) > 0 {
			f := out.Failed[0]
			return fmt.Errorf(
				"SendMessageBatch partial failure: id=%s code=%s message=%s",
				aws.ToString(f.Id),
				aws.ToString(f.Code),
				aws.ToString(f.Message),
			)
		}
	}
	return nil
}
