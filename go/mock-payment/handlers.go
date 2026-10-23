package main

import (
	"encoding/json"
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

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, ErrorBody{Error: message, Code: code})
}
