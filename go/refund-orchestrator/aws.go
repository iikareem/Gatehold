package main

import (
	"context"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

func requireEnv(key string) (string, error) {
	v := os.Getenv(key)
	if v == "" {
		return "", fmt.Errorf("missing required env %s", key)
	}
	return v, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func loadAWSConfig(ctx context.Context) (aws.Config, error) {
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
		return aws.Config{}, fmt.Errorf("load AWS config: %w", err)
	}
	return cfg, nil
}

func newDynamoClient(ctx context.Context) (*dynamodb.Client, error) {
	cfg, err := loadAWSConfig(ctx)
	if err != nil {
		return nil, err
	}
	endpoint := os.Getenv("AWS_ENDPOINT_URL")
	if endpoint != "" {
		return dynamodb.NewFromConfig(cfg, func(o *dynamodb.Options) {
			o.BaseEndpoint = aws.String(endpoint)
		}), nil
	}
	return dynamodb.NewFromConfig(cfg), nil
}

func newSQSClient(ctx context.Context) (*sqs.Client, error) {
	cfg, err := loadAWSConfig(ctx)
	if err != nil {
		return nil, err
	}
	endpoint := os.Getenv("AWS_ENDPOINT_URL")
	if endpoint != "" {
		return sqs.NewFromConfig(cfg, func(o *sqs.Options) {
			o.BaseEndpoint = aws.String(endpoint)
		}), nil
	}
	return sqs.NewFromConfig(cfg), nil
}
