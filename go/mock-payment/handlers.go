package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const maxBodyBytes = 1 << 20 // 1 MiB

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if s.chaos.Before(w, r) {
		return
	}
	if err := s.store.Ping(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_UNAVAILABLE", err.Error())
		return
	}
	if s.chaos.After(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	if s.chaos.Before(w, r) {
		return
	}

	var in AuthorizeInput
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	setLogKey(w, in.IdempotencyKey)

	out, err := s.store.Authorize(r.Context(), in)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if s.chaos.After(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCapture(w http.ResponseWriter, r *http.Request) {
	s.handleFollowUp(w, r, s.store.Capture)
}

func (s *Server) handleVoid(w http.ResponseWriter, r *http.Request) {
	s.handleFollowUp(w, r, s.store.Void)
}

func (s *Server) handleRefund(w http.ResponseWriter, r *http.Request) {
	s.handleFollowUp(w, r, s.store.Refund)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if s.chaos.Before(w, r) {
		return
	}

	key := r.URL.Query().Get("idempotencyKey")
	setLogKey(w, key)
	out, err := s.store.GetByKey(r.Context(), key)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if s.chaos.After(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleFollowUp(
	w http.ResponseWriter,
	r *http.Request,
	fn func(ctx context.Context, in FollowUpInput) (PaymentResponse, error),
) {
	if s.chaos.Before(w, r) {
		return
	}

	var in FollowUpInput
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	setLogKey(w, in.IdempotencyKey)

	out, err := fn(r.Context(), in)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if s.chaos.After(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func decodeJSON(r *http.Request, dst any) error {
	if err := requireJSONContentType(r); err != nil {
		return err
	}
	defer r.Body.Close()
	r.Body = http.MaxBytesReader(nil, r.Body, maxBodyBytes)

	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return fmt.Errorf("body too large (max %d bytes)", maxBodyBytes)
		}
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("empty body")
		}
		return err
	}
	return nil
}

func requireJSONContentType(r *http.Request) error {
	ct := r.Header.Get("Content-Type")
	if ct == "" {
		return fmt.Errorf("Content-Type application/json required")
	}
	// Loose match: application/json or application/json; charset=utf-8
	media := strings.TrimSpace(strings.Split(ct, ";")[0])
	if !strings.EqualFold(media, "application/json") {
		return fmt.Errorf("Content-Type must be application/json")
	}
	return nil
}

func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrBadRequest):
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
	case errors.Is(err, ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
	case errors.Is(err, ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
	case errors.Is(err, ErrInvalidTransition):
		writeError(w, http.StatusConflict, "INVALID_TRANSITION", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, ErrorBody{Error: message, Code: code})
}
