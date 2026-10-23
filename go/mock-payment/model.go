package main

import "time"

// Provider payment statuses (see docs/contracts.md Phase 5).
const (
	StatusAuthorized = "AUTHORIZED"
	StatusCaptured   = "CAPTURED"
	StatusVoided     = "VOIDED"
	StatusRefunded   = "REFUNDED"
	StatusFailed     = "FAILED"
)

// PaymentIntent is the in-memory record for one authorization and its
// later capture / void / refund outcome.
type PaymentIntent struct {
	IdempotencyKey  string // authorize key that created this intent
	OrderID         string
	AuthorizationID string
	PaymentID       string
	Status          string
	Amount          int64
	Currency        string
	CreatedAt       time.Time
}

// AuthorizeInput is the store/HTTP input for authorize.
type AuthorizeInput struct {
	IdempotencyKey string `json:"idempotencyKey"`
	OrderID        string `json:"orderId"`
	Amount         int64  `json:"amount"`
	Currency       string `json:"currency"`
}

// FollowUpInput is the store/HTTP input for capture, void, or refund.
type FollowUpInput struct {
	IdempotencyKey  string `json:"idempotencyKey"`
	OrderID         string `json:"orderId"`
	AuthorizationID string `json:"authorizationId"`
	Amount          int64  `json:"amount"`
	Currency        string `json:"currency"`
}

// PaymentResponse is the JSON body returned by payment endpoints.
type PaymentResponse struct {
	IdempotencyKey  string `json:"idempotencyKey"`
	OrderID         string `json:"orderId"`
	AuthorizationID string `json:"authorizationId,omitempty"`
	PaymentID       string `json:"paymentId,omitempty"`
	Status          string `json:"status"`
	Amount          int64  `json:"amount"`
	Currency        string `json:"currency"`
	FailReason      string `json:"failReason,omitempty"`
}

// ErrorBody is the JSON error shape from contracts.md.
type ErrorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func (p PaymentIntent) toResponse(idempotencyKey string) PaymentResponse {
	return PaymentResponse{
		IdempotencyKey:  idempotencyKey,
		OrderID:         p.OrderID,
		AuthorizationID: p.AuthorizationID,
		PaymentID:       p.PaymentID,
		Status:          p.Status,
		Amount:          p.Amount,
		Currency:        p.Currency,
	}
}

func (p *PaymentIntent) sameAuthorizePayload(in AuthorizeInput) bool {
	return p.OrderID == in.OrderID && p.Amount == in.Amount && p.Currency == in.Currency
}

func (p *PaymentIntent) sameFollowUpPayload(in FollowUpInput) bool {
	return p.OrderID == in.OrderID &&
		p.AuthorizationID == in.AuthorizationID &&
		p.Amount == in.Amount &&
		p.Currency == in.Currency
}
