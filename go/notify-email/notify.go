package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/ses"
	"github.com/aws/aws-sdk-go-v2/service/ses/types"
)

// OrderConfirmedDetail matches stream-relay / docs/contracts.md.
type OrderConfirmedDetail struct {
	OrderID     string   `json:"orderId"`
	EventID     string   `json:"eventId"`
	UserID      string   `json:"userId"`
	SeatIDs     []string `json:"seatIds"`
	ConfirmedAt string   `json:"confirmedAt"`
}

// snsEnvelope is the SQS body when SNS delivers to SQS (raw message delivery off).
type snsEnvelope struct {
	Type    string `json:"Type"`
	Message string `json:"Message"`
}

// eventBridgeEvent is the JSON inside SNS Message.
type eventBridgeEvent struct {
	Source     string          `json:"source"`
	DetailType string          `json:"detail-type"`
	Detail     json.RawMessage `json:"detail"`
}

type emailSender interface {
	SendEmail(ctx context.Context, params *ses.SendEmailInput, optFns ...func(*ses.Options)) (*ses.SendEmailOutput, error)
	VerifyEmailIdentity(ctx context.Context, params *ses.VerifyEmailIdentityInput, optFns ...func(*ses.Options)) (*ses.VerifyEmailIdentityOutput, error)
}

func HandleSQS(ctx context.Context, event events.SQSEvent) (events.SQSEventResponse, error) {
	client, err := newSESClient(ctx)
	if err != nil {
		return events.SQSEventResponse{}, fmt.Errorf("ses client: %w", err)
	}

	from := envOr("SES_FROM_EMAIL", "noreply@gatehold.local")
	var failures []events.SQSBatchItemFailure

	for _, record := range event.Records {
		if err := processRecord(ctx, client, from, record.Body); err != nil {
			log.Printf("notify-email failed messageId=%s: %v", record.MessageId, err)
			failures = append(failures, events.SQSBatchItemFailure{
				ItemIdentifier: record.MessageId,
			})
			continue
		}
	}

	return events.SQSEventResponse{BatchItemFailures: failures}, nil
}

func processRecord(ctx context.Context, client emailSender, from, body string) error {
	detail, err := parseOrderConfirmed(body)
	if err != nil {
		return err
	}

	to := notifyAddress(detail.UserID)
	subject := fmt.Sprintf("Order confirmed: %s", detail.OrderID)
	text := fmt.Sprintf(
		"Your order is confirmed.\n\norderId: %s\neventId: %s\nuserId: %s\nseatIds: %s\nconfirmedAt: %s\n",
		detail.OrderID,
		detail.EventID,
		detail.UserID,
		strings.Join(detail.SeatIDs, ", "),
		detail.ConfirmedAt,
	)

	// SES sandbox / MiniStack reject unverified From/To — verify is idempotent locally.
	if err := ensureVerified(ctx, client, from, to); err != nil {
		return err
	}

	out, err := client.SendEmail(ctx, &ses.SendEmailInput{
		Source: aws.String(from),
		Destination: &types.Destination{
			ToAddresses: []string{to},
		},
		Message: &types.Message{
			Subject: &types.Content{Data: aws.String(subject)},
			Body: &types.Body{
				Text: &types.Content{Data: aws.String(text)},
			},
		},
	})
	if err != nil {
		return fmt.Errorf("SendEmail: %w", err)
	}

	log.Printf(
		"OrderConfirmed email sent orderId=%s userId=%s to=%s messageId=%s",
		detail.OrderID,
		detail.UserID,
		to,
		aws.ToString(out.MessageId),
	)
	return nil
}

func parseOrderConfirmed(sqsBody string) (OrderConfirmedDetail, error) {
	var env snsEnvelope
	if err := json.Unmarshal([]byte(sqsBody), &env); err != nil {
		return OrderConfirmedDetail{}, fmt.Errorf("unmarshal SNS envelope: %w", err)
	}
	if env.Message == "" {
		return OrderConfirmedDetail{}, fmt.Errorf("SNS envelope missing Message")
	}

	var eb eventBridgeEvent
	if err := json.Unmarshal([]byte(env.Message), &eb); err != nil {
		return OrderConfirmedDetail{}, fmt.Errorf("unmarshal EventBridge message: %w", err)
	}
	if eb.DetailType != "" && eb.DetailType != "OrderConfirmed" {
		return OrderConfirmedDetail{}, fmt.Errorf("unexpected detail-type %q", eb.DetailType)
	}

	var detail OrderConfirmedDetail
	if err := json.Unmarshal(eb.Detail, &detail); err != nil {
		return OrderConfirmedDetail{}, fmt.Errorf("unmarshal OrderConfirmed detail: %w", err)
	}
	if detail.OrderID == "" {
		return OrderConfirmedDetail{}, fmt.Errorf("detail missing orderId")
	}
	return detail, nil
}

// notifyAddress: Phase 8 has no real fan email — synthesize for MiniStack inspect.
func notifyAddress(userID string) string {
	if override := os.Getenv("SES_TO_EMAIL"); override != "" {
		return override
	}
	if userID == "" {
		userID = "unknown"
	}
	return userID + "@fans.gatehold.local"
}

func ensureVerified(ctx context.Context, client emailSender, addresses ...string) error {
	seen := map[string]struct{}{}
	for _, addr := range addresses {
		if addr == "" {
			continue
		}
		if _, ok := seen[addr]; ok {
			continue
		}
		seen[addr] = struct{}{}
		if _, err := client.VerifyEmailIdentity(ctx, &ses.VerifyEmailIdentityInput{
			EmailAddress: aws.String(addr),
		}); err != nil {
			return fmt.Errorf("VerifyEmailIdentity %s: %w", addr, err)
		}
	}
	return nil
}

func newSESClient(ctx context.Context) (*ses.Client, error) {
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
		return ses.NewFromConfig(cfg, func(o *ses.Options) {
			o.BaseEndpoint = aws.String(endpoint)
		}), nil
	}
	return ses.NewFromConfig(cfg), nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
