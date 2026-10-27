package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/eventbridge"
	"github.com/aws/aws-sdk-go-v2/service/eventbridge/types"
)

const (
	detailTypeOrderConfirmed = "OrderConfirmed"
	defaultEventSource       = "gatehold.orders"
)

// OrderConfirmedDetail is the EventBridge detail JSON (docs/contracts.md).
type OrderConfirmedDetail struct {
	OrderID     string   `json:"orderId"`
	EventID     string   `json:"eventId"`
	UserID      string   `json:"userId"`
	SeatIDs     []string `json:"seatIds"`
	ConfirmedAt string   `json:"confirmedAt"`
}

type eventPublisher interface {
	PutEvents(ctx context.Context, params *eventbridge.PutEventsInput, optFns ...func(*eventbridge.Options)) (*eventbridge.PutEventsOutput, error)
}

func newEventBridgeClient(ctx context.Context) (*eventbridge.Client, error) {
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
		return eventbridge.NewFromConfig(cfg, func(o *eventbridge.Options) {
			o.BaseEndpoint = aws.String(endpoint)
		}), nil
	}
	return eventbridge.NewFromConfig(cfg), nil
}

func publishOrderConfirmed(
	ctx context.Context,
	client eventPublisher,
	busName string,
	source string,
	c ConfirmedCandidate,
	now time.Time,
) error {
	if busName == "" {
		return fmt.Errorf("missing EVENT_BUS_NAME")
	}
	if source == "" {
		source = defaultEventSource
	}
	if c.SeatIDs == nil {
		c.SeatIDs = []string{}
	}

	detail, err := json.Marshal(OrderConfirmedDetail{
		OrderID:     c.OrderID,
		EventID:     c.EventID,
		UserID:      c.UserID,
		SeatIDs:     c.SeatIDs,
		ConfirmedAt: now.UTC().Format("2006-01-02T15:04:05.000Z"),
	})
	if err != nil {
		return fmt.Errorf("marshal OrderConfirmed detail: %w", err)
	}

	out, err := client.PutEvents(ctx, &eventbridge.PutEventsInput{
		Entries: []types.PutEventsRequestEntry{
			{
				EventBusName: aws.String(busName),
				Source:       aws.String(source),
				DetailType:   aws.String(detailTypeOrderConfirmed),
				Detail:       aws.String(string(detail)),
			},
		},
	})
	if err != nil {
		return fmt.Errorf("PutEvents OrderConfirmed: %w", err)
	}
	if out.FailedEntryCount > 0 && len(out.Entries) > 0 {
		e := out.Entries[0]
		return fmt.Errorf(
			"PutEvents OrderConfirmed failed: code=%s message=%s",
			aws.ToString(e.ErrorCode),
			aws.ToString(e.ErrorMessage),
		)
	}
	return nil
}
