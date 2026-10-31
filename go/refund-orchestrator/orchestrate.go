package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

const (
	ordersEventStatusIndex = "eventId-status"
	defaultPageSize        = int32(100)
)

// CancellingCandidate is an Events MODIFY ON_SALE → CANCELLING.
type CancellingCandidate struct {
	EventID  string
	StreamID string
}

type dynamoAPI interface {
	GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(ctx context.Context, params *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	UpdateItem(ctx context.Context, params *dynamodb.UpdateItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
	Query(ctx context.Context, params *dynamodb.QueryInput, optFns ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
}

type orchestratorDeps struct {
	dynamo           dynamoAPI
	sqs              sqsSender
	eventsTable      string
	ordersTable      string
	refundBatchesTbl string
	queueURL         string
	pageSize         int32
}

type refundBatchState struct {
	BatchID          string
	EventID          string
	Status           string
	FanOutComplete   bool
	LastEvaluatedKey map[string]types.AttributeValue
}

// HandleStream filters Events stream records and fans out refund jobs.
func HandleStream(ctx context.Context, event events.DynamoDBEvent) error {
	eventsTable, err := requireEnv("EVENTS_TABLE_NAME")
	if err != nil {
		return err
	}
	ordersTable, err := requireEnv("ORDERS_TABLE_NAME")
	if err != nil {
		return err
	}
	refundBatchesTbl, err := requireEnv("REFUND_BATCHES_TABLE_NAME")
	if err != nil {
		return err
	}
	queueURL, err := requireEnv("REFUND_QUEUE_URL")
	if err != nil {
		return err
	}

	ddb, err := newDynamoClient(ctx)
	if err != nil {
		return err
	}
	sqsClient, err := newSQSClient(ctx)
	if err != nil {
		return err
	}

	pageSize := defaultPageSize
	if raw := envOr("ORDERS_PAGE_SIZE", ""); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 1000 {
			return fmt.Errorf("invalid ORDERS_PAGE_SIZE %q", raw)
		}
		pageSize = int32(n)
	}

	deps := orchestratorDeps{
		dynamo:           ddb,
		sqs:              sqsClient,
		eventsTable:      eventsTable,
		ordersTable:      ordersTable,
		refundBatchesTbl: refundBatchesTbl,
		queueURL:         queueURL,
		pageSize:         pageSize,
	}

	for _, record := range event.Records {
		c, ok := cancellingFromRecord(record)
		if !ok {
			continue
		}
		log.Printf(
			"cancel fan-out start eventId=%s streamEventId=%s",
			c.EventID,
			c.StreamID,
		)
		if err := fanOutEvent(ctx, deps, c.EventID); err != nil {
			return fmt.Errorf("eventId=%s: %w", c.EventID, err)
		}
		log.Printf("cancel fan-out done eventId=%s", c.EventID)
	}
	return nil
}

func cancellingFromRecord(record events.DynamoDBEventRecord) (CancellingCandidate, bool) {
	if record.EventName != "MODIFY" {
		return CancellingCandidate{}, false
	}
	oldStatus := attrString(record.Change.OldImage, "status")
	newStatus := attrString(record.Change.NewImage, "status")
	if oldStatus != "ON_SALE" || newStatus != "CANCELLING" {
		return CancellingCandidate{}, false
	}
	eventID := attrString(record.Change.NewImage, "eventId")
	if eventID == "" {
		return CancellingCandidate{}, false
	}
	return CancellingCandidate{
		EventID:  eventID,
		StreamID: record.EventID,
	}, true
}

func attrString(img map[string]events.DynamoDBAttributeValue, key string) string {
	v, ok := img[key]
	if !ok || v.DataType() != events.DataTypeString {
		return ""
	}
	return v.String()
}

func fanOutEvent(ctx context.Context, deps orchestratorDeps, eventID string) error {
	batch, err := claimOrLoadBatch(ctx, deps, eventID)
	if err != nil {
		return err
	}
	if batch.FanOutComplete {
		log.Printf("fan-out already complete batchId=%s eventId=%s", batch.BatchID, eventID)
		return nil
	}

	startKey := batch.LastEvaluatedKey
	for {
		orderIDs, lastKey, err := queryConfirmedPage(ctx, deps, eventID, startKey)
		if err != nil {
			return err
		}

		if err := enqueueOrders(ctx, deps.sqs, deps.queueURL, eventID, batch.BatchID, orderIDs); err != nil {
			return err
		}

		complete := len(lastKey) == 0
		if err := checkpointBatch(ctx, deps, batch.BatchID, len(orderIDs), lastKey, complete); err != nil {
			return err
		}

		log.Printf(
			"fan-out page batchId=%s eventId=%s enqueued=%d fanOutComplete=%v",
			batch.BatchID,
			eventID,
			len(orderIDs),
			complete,
		)

		if complete {
			return nil
		}
		startKey = lastKey
	}
}

func claimOrLoadBatch(ctx context.Context, deps orchestratorDeps, eventID string) (refundBatchState, error) {
	existingID, err := getEventRefundBatchID(ctx, deps, eventID)
	if err != nil {
		return refundBatchState{}, err
	}
	if existingID != "" {
		return getBatch(ctx, deps, existingID)
	}

	batchID, err := newBatchID()
	if err != nil {
		return refundBatchState{}, err
	}
	startedAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")

	_, err = deps.dynamo.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(deps.refundBatchesTbl),
		Item: map[string]types.AttributeValue{
			"batchId":   &types.AttributeValueMemberS{Value: batchID},
			"eventId":   &types.AttributeValueMemberS{Value: eventID},
			"status":    &types.AttributeValueMemberS{Value: "RUNNING"},
			"enqueued":  &types.AttributeValueMemberN{Value: "0"},
			"succeeded": &types.AttributeValueMemberN{Value: "0"},
			"failed":    &types.AttributeValueMemberN{Value: "0"},
			"startedAt": &types.AttributeValueMemberS{Value: startedAt},
		},
		ConditionExpression: aws.String("attribute_not_exists(batchId)"),
	})
	if err != nil {
		return refundBatchState{}, fmt.Errorf("put refund batch: %w", err)
	}

	_, err = deps.dynamo.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(deps.eventsTable),
		Key: map[string]types.AttributeValue{
			"eventId": &types.AttributeValueMemberS{Value: eventID},
		},
		UpdateExpression: aws.String("SET refundBatchId = :batchId"),
		ConditionExpression: aws.String(
			"attribute_exists(eventId) AND #status = :cancelling AND attribute_not_exists(refundBatchId)",
		),
		ExpressionAttributeNames: map[string]string{
			"#status": "status",
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":batchId":    &types.AttributeValueMemberS{Value: batchID},
			":cancelling": &types.AttributeValueMemberS{Value: "CANCELLING"},
		},
	})
	if err != nil {
		var condErr *types.ConditionalCheckFailedException
		if errors.As(err, &condErr) {
			// Another invoker attached first — use the winner's batch.
			winner, getErr := getEventRefundBatchID(ctx, deps, eventID)
			if getErr != nil {
				return refundBatchState{}, getErr
			}
			if winner == "" {
				return refundBatchState{}, fmt.Errorf(
					"attach refundBatchId raced but event has no refundBatchId eventId=%s",
					eventID,
				)
			}
			log.Printf(
				"refundBatchId attach lost race eventId=%s orphanBatchId=%s winnerBatchId=%s",
				eventID,
				batchID,
				winner,
			)
			return getBatch(ctx, deps, winner)
		}
		return refundBatchState{}, fmt.Errorf("attach refundBatchId: %w", err)
	}

	return refundBatchState{
		BatchID: batchID,
		EventID: eventID,
		Status:  "RUNNING",
	}, nil
}

func getEventRefundBatchID(ctx context.Context, deps orchestratorDeps, eventID string) (string, error) {
	out, err := deps.dynamo.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(deps.eventsTable),
		Key: map[string]types.AttributeValue{
			"eventId": &types.AttributeValueMemberS{Value: eventID},
		},
		ProjectionExpression: aws.String("refundBatchId"),
	})
	if err != nil {
		return "", fmt.Errorf("get event: %w", err)
	}
	if out.Item == nil {
		return "", fmt.Errorf("event not found: %s", eventID)
	}
	return attrS(out.Item, "refundBatchId"), nil
}

func getBatch(ctx context.Context, deps orchestratorDeps, batchID string) (refundBatchState, error) {
	out, err := deps.dynamo.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(deps.refundBatchesTbl),
		Key: map[string]types.AttributeValue{
			"batchId": &types.AttributeValueMemberS{Value: batchID},
		},
	})
	if err != nil {
		return refundBatchState{}, fmt.Errorf("get refund batch: %w", err)
	}
	if out.Item == nil {
		return refundBatchState{}, fmt.Errorf("refund batch not found: %s", batchID)
	}

	state := refundBatchState{
		BatchID: batchID,
		EventID: attrS(out.Item, "eventId"),
		Status:  attrS(out.Item, "status"),
	}
	if b, ok := out.Item["fanOutComplete"].(*types.AttributeValueMemberBOOL); ok {
		state.FanOutComplete = b.Value
	}
	if m, ok := out.Item["lastEvaluatedKey"].(*types.AttributeValueMemberM); ok {
		state.LastEvaluatedKey = m.Value
	}
	return state, nil
}

func queryConfirmedPage(
	ctx context.Context,
	deps orchestratorDeps,
	eventID string,
	startKey map[string]types.AttributeValue,
) (orderIDs []string, lastKey map[string]types.AttributeValue, err error) {
	out, err := deps.dynamo.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(deps.ordersTable),
		IndexName:              aws.String(ordersEventStatusIndex),
		KeyConditionExpression: aws.String("eventId = :eventId AND #status = :confirmed"),
		ExpressionAttributeNames: map[string]string{
			"#status": "status",
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":eventId":   &types.AttributeValueMemberS{Value: eventID},
			":confirmed": &types.AttributeValueMemberS{Value: "CONFIRMED"},
		},
		ExclusiveStartKey: startKey,
		Limit:             aws.Int32(deps.pageSize),
	})
	if err != nil {
		return nil, nil, fmt.Errorf("query confirmed orders: %w", err)
	}

	orderIDs = make([]string, 0, len(out.Items))
	for _, item := range out.Items {
		if id := attrS(item, "orderId"); id != "" {
			orderIDs = append(orderIDs, id)
		}
	}
	return orderIDs, out.LastEvaluatedKey, nil
}

func checkpointBatch(
	ctx context.Context,
	deps orchestratorDeps,
	batchID string,
	enqueuedDelta int,
	lastKey map[string]types.AttributeValue,
	fanOutComplete bool,
) error {
	exprValues := map[string]types.AttributeValue{
		":enqueuedDelta": &types.AttributeValueMemberN{Value: strconv.Itoa(enqueuedDelta)},
		":running":       &types.AttributeValueMemberS{Value: "RUNNING"},
	}

	var updateExpr string
	if fanOutComplete {
		updateExpr = "ADD enqueued :enqueuedDelta SET fanOutComplete = :fanOutComplete REMOVE lastEvaluatedKey"
		exprValues[":fanOutComplete"] = &types.AttributeValueMemberBOOL{Value: true}
	} else {
		updateExpr = "ADD enqueued :enqueuedDelta SET lastEvaluatedKey = :lek, fanOutComplete = :fanOutComplete"
		exprValues[":lek"] = &types.AttributeValueMemberM{Value: lastKey}
		exprValues[":fanOutComplete"] = &types.AttributeValueMemberBOOL{Value: false}
	}

	_, err := deps.dynamo.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(deps.refundBatchesTbl),
		Key: map[string]types.AttributeValue{
			"batchId": &types.AttributeValueMemberS{Value: batchID},
		},
		UpdateExpression:    aws.String(updateExpr),
		ConditionExpression: aws.String("attribute_exists(batchId) AND #status = :running"),
		ExpressionAttributeNames: map[string]string{
			"#status": "status",
		},
		ExpressionAttributeValues: exprValues,
	})
	if err != nil {
		return fmt.Errorf("checkpoint batch: %w", err)
	}
	return nil
}

func attrS(item map[string]types.AttributeValue, key string) string {
	v, ok := item[key]
	if !ok {
		return ""
	}
	s, ok := v.(*types.AttributeValueMemberS)
	if !ok {
		return ""
	}
	return s.Value
}

func newBatchID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate batchId: %w", err)
	}
	return "rb_" + hex.EncodeToString(b[:]), nil
}
