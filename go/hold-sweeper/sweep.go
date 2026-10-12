package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Seat is the DynamoDB seats-table shape used by the sweeper.
type Seat struct {
	EventID   string  `dynamodbav:"eventId"`
	SeatID    string  `dynamodbav:"seatId"`
	Status    string  `dynamodbav:"status"`
	ExpiresAt *string `dynamodbav:"expiresAt,omitempty"`
}

// SweepStats counts Scan / Update outcomes for one run.
type SweepStats struct {
	Scanned  int
	Released int
	Skipped  int
}

// shouldRelease reports whether a HELD seat's expiresAt is strictly before now.
// Missing or unparseable expiresAt → false (skip safely).
func shouldRelease(seat Seat, now time.Time) bool {
	if seat.Status != "HELD" {
		return false
	}
	if seat.ExpiresAt == nil || *seat.ExpiresAt == "" {
		return false
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, *seat.ExpiresAt)
	if err != nil {
		expiresAt, err = time.Parse(time.RFC3339, *seat.ExpiresAt)
		if err != nil {
			return false
		}
	}
	return expiresAt.Before(now)
}

func requireEnv(key string) (string, error) {
	v := os.Getenv(key)
	if v == "" {
		return "", fmt.Errorf("missing required env %s", key)
	}
	return v, nil
}

// Run performs one sweep: load env, scan HELD seats, release expired ones.
// Shared by CLI (go run) and the Lambda handler.
func Run(ctx context.Context) error {
	tableName, err := requireEnv("SEATS_TABLE_NAME")
	if err != nil {
		return err
	}

	client, err := newDynamoClient(ctx)
	if err != nil {
		return err
	}

	stats, err := sweep(ctx, client, tableName, time.Now().UTC())
	if err != nil {
		return err
	}

	log.Printf(
		"hold-sweeper done: scanned=%d released=%d skipped=%d",
		stats.Scanned, stats.Released, stats.Skipped,
	)
	return nil
}

// newDynamoClient mirrors services/shared createDynamoDBClient:
// honor AWS_ENDPOINT_URL for MiniStack; use default creds on real AWS.
func newDynamoClient(ctx context.Context) (*dynamodb.Client, error) {
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = os.Getenv("AWS_DEFAULT_REGION")
	}
	if region == "" {
		region = "us-east-1"
	}

	endpoint := os.Getenv("AWS_ENDPOINT_URL")

	var opts []func(*config.LoadOptions) error
	opts = append(opts, config.WithRegion(region))

	if endpoint != "" {
		accessKey := os.Getenv("AWS_ACCESS_KEY_ID")
		if accessKey == "" {
			accessKey = "test"
		}
		secretKey := os.Getenv("AWS_SECRET_ACCESS_KEY")
		if secretKey == "" {
			secretKey = "test"
		}
		opts = append(opts, config.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
		))
	}

	cfg, err := config.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}

	if endpoint != "" {
		return dynamodb.NewFromConfig(cfg, func(o *dynamodb.Options) {
			o.BaseEndpoint = aws.String(endpoint)
		}), nil
	}
	return dynamodb.NewFromConfig(cfg), nil
}

func sweep(ctx context.Context, client *dynamodb.Client, tableName string, now time.Time) (SweepStats, error) {
	var stats SweepStats
	// Millisecond ISO to match JS Date.toISOString() (lexicographic < in DynamoDB).
	nowISO := now.UTC().Format("2006-01-02T15:04:05.000Z")

	var startKey map[string]types.AttributeValue
	for {
		out, err := client.Scan(ctx, &dynamodb.ScanInput{
			TableName:        aws.String(tableName),
			FilterExpression: aws.String("#status = :held"),
			ExpressionAttributeNames: map[string]string{
				"#status": "status",
			},
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":held": &types.AttributeValueMemberS{Value: "HELD"},
			},
			ExclusiveStartKey: startKey,
		})
		if err != nil {
			return stats, fmt.Errorf("scan: %w", err)
		}

		for _, item := range out.Items {
			stats.Scanned++

			var seat Seat
			if err := attributevalue.UnmarshalMap(item, &seat); err != nil {
				log.Printf("skip unmarshal: %v", err)
				stats.Skipped++
				continue
			}

			if !shouldRelease(seat, now) {
				stats.Skipped++
				continue
			}

			released, err := tryRelease(ctx, client, tableName, seat, nowISO)
			if err != nil {
				return stats, err
			}
			if released {
				stats.Released++
			} else {
				stats.Skipped++
			}
		}

		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		startKey = out.LastEvaluatedKey
	}

	return stats, nil
}

// tryRelease conditionally flips an expired HELD seat to AVAILABLE.
// Returns false (no error) when the condition fails — idempotent / race-safe.
func tryRelease(ctx context.Context, client *dynamodb.Client, tableName string, seat Seat, nowISO string) (bool, error) {
	_, err := client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]types.AttributeValue{
			"eventId": &types.AttributeValueMemberS{Value: seat.EventID},
			"seatId":  &types.AttributeValueMemberS{Value: seat.SeatID},
		},
		UpdateExpression: aws.String(
			"SET #status = :available REMOVE holdId, holdOwner, expiresAt",
		),
		ConditionExpression: aws.String("#status = :held AND expiresAt < :now"),
		ExpressionAttributeNames: map[string]string{
			"#status": "status",
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":available": &types.AttributeValueMemberS{Value: "AVAILABLE"},
			":held":      &types.AttributeValueMemberS{Value: "HELD"},
			":now":       &types.AttributeValueMemberS{Value: nowISO},
		},
	})
	if err != nil {
		var condErr *types.ConditionalCheckFailedException
		if errors.As(err, &condErr) {
			return false, nil
		}
		return false, fmt.Errorf("update %s/%s: %w", seat.EventID, seat.SeatID, err)
	}
	return true, nil
}
