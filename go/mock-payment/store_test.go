package main

import (
	"context"
	"errors"
	"testing"
)

func TestStoreAuthorizeCapture(t *testing.T) {
	s := NewStore()
	ctx := context.Background()

	auth, err := s.Authorize(ctx, AuthorizeInput{
		IdempotencyKey: "pay:auth:ord_1",
		OrderID:        "ord_1",
		Amount:         5000,
		Currency:       "USD",
	})
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if auth.Status != StatusAuthorized || auth.AuthorizationID == "" {
		t.Fatalf("unexpected auth: %+v", auth)
	}

	cap, err := s.Capture(ctx, FollowUpInput{
		IdempotencyKey:  "pay:capture:ord_1",
		OrderID:         "ord_1",
		AuthorizationID: auth.AuthorizationID,
		Amount:          5000,
		Currency:        "USD",
	})
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if cap.Status != StatusCaptured {
		t.Fatalf("want CAPTURED, got %s", cap.Status)
	}
}

func TestStoreAuthorizeVoid(t *testing.T) {
	s := NewStore()
	ctx := context.Background()

	auth, err := s.Authorize(ctx, AuthorizeInput{
		IdempotencyKey: "pay:auth:ord_2",
		OrderID:        "ord_2",
		Amount:         1000,
		Currency:       "USD",
	})
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}

	voided, err := s.Void(ctx, FollowUpInput{
		IdempotencyKey:  "pay:void:ord_2",
		OrderID:         "ord_2",
		AuthorizationID: auth.AuthorizationID,
		Amount:          1000,
		Currency:        "USD",
	})
	if err != nil {
		t.Fatalf("void: %v", err)
	}
	if voided.Status != StatusVoided {
		t.Fatalf("want VOIDED, got %s", voided.Status)
	}
}

func TestStoreAuthorizeIdempotent(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	in := AuthorizeInput{
		IdempotencyKey: "pay:auth:ord_3",
		OrderID:        "ord_3",
		Amount:         2000,
		Currency:       "USD",
	}

	first, err := s.Authorize(ctx, in)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := s.Authorize(ctx, in)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if first.AuthorizationID != second.AuthorizationID {
		t.Fatalf("idempotent authorize must return same authorizationId")
	}
}

func TestStoreAuthorizeConflictDifferentBody(t *testing.T) {
	s := NewStore()
	ctx := context.Background()

	_, err := s.Authorize(ctx, AuthorizeInput{
		IdempotencyKey: "pay:auth:ord_4",
		OrderID:        "ord_4",
		Amount:         2000,
		Currency:       "USD",
	})
	if err != nil {
		t.Fatalf("first: %v", err)
	}

	_, err = s.Authorize(ctx, AuthorizeInput{
		IdempotencyKey: "pay:auth:ord_4",
		OrderID:        "ord_4",
		Amount:         9999, // different
		Currency:       "USD",
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
}

func TestStoreInvalidTransition(t *testing.T) {
	s := NewStore()
	ctx := context.Background()

	auth, err := s.Authorize(ctx, AuthorizeInput{
		IdempotencyKey: "pay:auth:ord_5",
		OrderID:        "ord_5",
		Amount:         500,
		Currency:       "USD",
	})
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}

	_, err = s.Refund(ctx, FollowUpInput{
		IdempotencyKey:  "pay:refund:ord_5",
		OrderID:         "ord_5",
		AuthorizationID: auth.AuthorizationID,
		Amount:          500,
		Currency:        "USD",
	})
	if !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("want ErrInvalidTransition, got %v", err)
	}
}

func TestStoreGetByKey(t *testing.T) {
	s := NewStore()
	ctx := context.Background()

	auth, err := s.Authorize(ctx, AuthorizeInput{
		IdempotencyKey: "pay:auth:ord_6",
		OrderID:        "ord_6",
		Amount:         300,
		Currency:       "USD",
	})
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}

	got, err := s.GetByKey(ctx, "pay:auth:ord_6")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.AuthorizationID != auth.AuthorizationID || got.Status != StatusAuthorized {
		t.Fatalf("unexpected status result: %+v", got)
	}

	_, err = s.GetByKey(ctx, "pay:auth:missing")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}
