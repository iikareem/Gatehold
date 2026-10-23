package main

import (
	"context"
	"sync"
)

// Store holds payment intents in memory (Phase 5 — no DynamoDB).
// Authorize / capture / void / refund land in later steps.
type Store struct {
	mu       sync.Mutex
	byKey    map[string]*PaymentIntent
	byAuthID map[string]*PaymentIntent
}

// NewStore returns an empty in-memory payment store.
func NewStore() *Store {
	return &Store{
		byKey:    make(map[string]*PaymentIntent),
		byAuthID: make(map[string]*PaymentIntent),
	}
}

// Ping is a no-op used by health until real store methods exist.
func (s *Store) Ping(ctx context.Context) error {
	_ = ctx
	return nil
}
