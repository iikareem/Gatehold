package main

import "errors"

// Sentinel errors from the store. Handlers map these to HTTP status codes.
var (
	ErrNotFound          = errors.New("not found")
	ErrConflict          = errors.New("conflict")
	ErrInvalidTransition = errors.New("invalid transition")
	ErrBadRequest        = errors.New("bad request")
)
