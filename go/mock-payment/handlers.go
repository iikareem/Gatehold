package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if s.chaos.MaybeInject(w, r) {
		return
	}
	if err := s.store.Ping(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_UNAVAILABLE", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	if s.chaos.MaybeInject(w, r) {
		return
	}

	var in AuthorizeInput
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}

	out, err := s.store.Authorize(r.Context(), in)
	if err != nil {
		writeStoreError(w, err)
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

func (s *Server) handleFollowUp(
	w http.ResponseWriter,
	r *http.Request,
	fn func(ctx context.Context, in FollowUpInput) (PaymentResponse, error),
) {
	if s.chaos.MaybeInject(w, r) {
		return
	}

	var in FollowUpInput
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}

	out, err := fn(r.Context(), in)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func decodeJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
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
