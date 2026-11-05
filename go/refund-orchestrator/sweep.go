package main

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

const defaultFanOutStaleAfter = 5 * time.Minute

// HandleSweep finds RUNNING batches whose fan-out went stale and resumes them.
// Phase 11f1: EventBridge Scheduler → same Lambda as the Events stream path.
func HandleSweep(ctx context.Context) error {
	deps, err := loadOrchestratorDeps(ctx)
	if err != nil {
		return err
	}
	staleAfter := fanOutStaleAfter()
	return sweepStuckFanOuts(ctx, deps, time.Now().UTC(), staleAfter)
}

func fanOutStaleAfter() time.Duration {
	raw := envOr("FAN_OUT_STALE_AFTER_SECONDS", "")
	if raw == "" {
		return defaultFanOutStaleAfter
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		log.Printf("invalid FAN_OUT_STALE_AFTER_SECONDS %q; using default %s", raw, defaultFanOutStaleAfter)
		return defaultFanOutStaleAfter
	}
	return time.Duration(n) * time.Second
}

func sweepStuckFanOuts(
	ctx context.Context,
	deps orchestratorDeps,
	now time.Time,
	staleAfter time.Duration,
) error {
	var startKey map[string]types.AttributeValue
	resumed := 0

	for {
		out, err := deps.dynamo.Scan(ctx, &dynamodb.ScanInput{
			TableName:        aws.String(deps.refundBatchesTbl),
			ExclusiveStartKey: startKey,
			FilterExpression: aws.String(
				"#status = :running AND (attribute_not_exists(fanOutComplete) OR fanOutComplete = :false)",
			),
			ExpressionAttributeNames: map[string]string{
				"#status": "status",
			},
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":running": &types.AttributeValueMemberS{Value: "RUNNING"},
				":false":   &types.AttributeValueMemberBOOL{Value: false},
			},
		})
		if err != nil {
			return fmt.Errorf("scan refund batches: %w", err)
		}

		for _, item := range out.Items {
			if !isFanOutStuck(item, now, staleAfter) {
				continue
			}
			eventID := attrS(item, "eventId")
			batchID := attrS(item, "batchId")
			if eventID == "" || batchID == "" {
				log.Printf("skip stuck batch missing ids batchId=%s eventId=%s", batchID, eventID)
				continue
			}
			log.Printf(
				"refund sweeper resume batchId=%s eventId=%s lastFanOutAt=%s",
				batchID,
				eventID,
				fanOutTimestamp(item),
			)
			if err := fanOutEvent(ctx, deps, eventID); err != nil {
				return fmt.Errorf("sweep resume eventId=%s batchId=%s: %w", eventID, batchID, err)
			}
			resumed++
		}

		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		startKey = out.LastEvaluatedKey
	}

	log.Printf("refund sweeper done resumed=%d staleAfter=%s", resumed, staleAfter)
	return nil
}

// isFanOutStuck is true when a RUNNING batch still needs fan-out and its
// lastFanOutAt (or startedAt fallback) is older than staleAfter.
func isFanOutStuck(
	item map[string]types.AttributeValue,
	now time.Time,
	staleAfter time.Duration,
) bool {
	if attrS(item, "status") != "RUNNING" {
		return false
	}
	if b, ok := item["fanOutComplete"].(*types.AttributeValueMemberBOOL); ok && b.Value {
		return false
	}

	raw := fanOutTimestamp(item)
	if raw == "" {
		return true
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		t, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			return true
		}
	}
	return !t.After(now.Add(-staleAfter))
}

func fanOutTimestamp(item map[string]types.AttributeValue) string {
	if v := attrS(item, "lastFanOutAt"); v != "" {
		return v
	}
	return attrS(item, "startedAt")
}
