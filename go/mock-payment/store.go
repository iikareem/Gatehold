package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// Store holds payment intents in memory (Phase 5 — no DynamoDB).
type Store struct {
	mu       sync.Mutex
	byKey    map[string]*PaymentIntent // idempotency key → intent
	byAuthID map[string]*PaymentIntent // authorizationId → intent
}

// NewStore returns an empty in-memory payment store.
func NewStore() *Store {
	return &Store{
		byKey:    make(map[string]*PaymentIntent),
		byAuthID: make(map[string]*PaymentIntent),
	}
}

// Ping is used by health checks.
func (s *Store) Ping(ctx context.Context) error {
	_ = ctx
	return nil
}

// Authorize reserves funds. Idempotent on IdempotencyKey.
func (s *Store) Authorize(ctx context.Context, in AuthorizeInput) (PaymentResponse, error) {
	_ = ctx
	if err := validateAuthorize(in); err != nil {
		return PaymentResponse{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, ok := s.byKey[in.IdempotencyKey]; ok {
		if !existing.sameAuthorizePayload(in) {
			return PaymentResponse{}, fmt.Errorf("%w: idempotency key reused with different body", ErrConflict)
		}
		return existing.toResponse(in.IdempotencyKey), nil
	}

	intent := &PaymentIntent{
		IdempotencyKey:  in.IdempotencyKey,
		OrderID:         in.OrderID,
		AuthorizationID: newID("auth_"),
		PaymentID:       newID("pay_"),
		Status:          StatusAuthorized,
		Amount:          in.Amount,
		Currency:        in.Currency,
		CreatedAt:       time.Now().UTC(),
	}
	s.byKey[in.IdempotencyKey] = intent
	s.byAuthID[intent.AuthorizationID] = intent
	return intent.toResponse(in.IdempotencyKey), nil
}

// Capture takes authorized funds. Idempotent on IdempotencyKey.
func (s *Store) Capture(ctx context.Context, in FollowUpInput) (PaymentResponse, error) {
	return s.followUp(ctx, in, StatusCaptured, StatusAuthorized)
}

// Void cancels an authorization. Idempotent on IdempotencyKey.
func (s *Store) Void(ctx context.Context, in FollowUpInput) (PaymentResponse, error) {
	return s.followUp(ctx, in, StatusVoided, StatusAuthorized)
}

// Refund returns captured funds. Idempotent on IdempotencyKey.
func (s *Store) Refund(ctx context.Context, in FollowUpInput) (PaymentResponse, error) {
	return s.followUp(ctx, in, StatusRefunded, StatusCaptured)
}

// GetByKey returns the stored outcome for an idempotency key (status query).
func (s *Store) GetByKey(ctx context.Context, idempotencyKey string) (PaymentResponse, error) {
	_ = ctx
	if idempotencyKey == "" {
		return PaymentResponse{}, fmt.Errorf("%w: idempotencyKey required", ErrBadRequest)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	intent, ok := s.byKey[idempotencyKey]
	if !ok {
		return PaymentResponse{}, fmt.Errorf("%w: unknown idempotency key", ErrNotFound)
	}
	return intent.toResponse(idempotencyKey), nil
}

// followUp applies capture / void / refund with shared idempotency + transition rules.
func (s *Store) followUp(ctx context.Context, in FollowUpInput, nextStatus, requiredStatus string) (PaymentResponse, error) {
	_ = ctx
	if err := validateFollowUp(in); err != nil {
		return PaymentResponse{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, ok := s.byKey[in.IdempotencyKey]; ok {
		if !existing.sameFollowUpPayload(in) {
			return PaymentResponse{}, fmt.Errorf("%w: idempotency key reused with different body", ErrConflict)
		}
		if existing.Status != nextStatus {
			return PaymentResponse{}, fmt.Errorf("%w: key exists but status is %s, want %s", ErrConflict, existing.Status, nextStatus)
		}
		return existing.toResponse(in.IdempotencyKey), nil
	}

	intent, ok := s.byAuthID[in.AuthorizationID]
	if !ok {
		return PaymentResponse{}, fmt.Errorf("%w: unknown authorizationId", ErrNotFound)
	}
	if !intent.sameFollowUpPayload(in) {
		// Auth exists but order/amount/currency do not match the authorization.
		return PaymentResponse{}, fmt.Errorf("%w: body does not match authorization", ErrConflict)
	}
	if intent.Status != requiredStatus {
		return PaymentResponse{}, fmt.Errorf("%w: cannot move from %s to %s", ErrInvalidTransition, intent.Status, nextStatus)
	}

	intent.Status = nextStatus
	s.byKey[in.IdempotencyKey] = intent
	return intent.toResponse(in.IdempotencyKey), nil
}

func validateAuthorize(in AuthorizeInput) error {
	if in.IdempotencyKey == "" || in.OrderID == "" || in.Currency == "" {
		return fmt.Errorf("%w: idempotencyKey, orderId, and currency are required", ErrBadRequest)
	}
	if in.Amount <= 0 {
		return fmt.Errorf("%w: amount must be positive", ErrBadRequest)
	}
	return nil
}

func validateFollowUp(in FollowUpInput) error {
	if in.IdempotencyKey == "" || in.OrderID == "" || in.AuthorizationID == "" || in.Currency == "" {
		return fmt.Errorf("%w: idempotencyKey, orderId, authorizationId, and currency are required", ErrBadRequest)
	}
	if in.Amount <= 0 {
		return fmt.Errorf("%w: amount must be positive", ErrBadRequest)
	}
	return nil
}

func newID(prefix string) string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// Extremely unlikely; fall back so the mock still runs.
		return fmt.Sprintf("%s%d", prefix, time.Now().UnixNano())
	}
	return prefix + hex.EncodeToString(b)
}
