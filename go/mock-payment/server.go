package main

import "net/http"

// Server is the HTTP facade around the payment store.
type Server struct {
	store *Store
	chaos *Chaos
	mux   *http.ServeMux
}

// NewServer wires routes. Payment endpoints are added in later steps.
func NewServer(cfg Config, store *Store) *Server {
	s := &Server{
		store: store,
		chaos: NewChaos(cfg),
		mux:   http.NewServeMux(),
	}
	s.routes()
	return s
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /health", s.handleHealth)
	// Later:
	// POST /v1/payments/authorize
	// POST /v1/payments/capture
	// POST /v1/payments/void
	// POST /v1/payments/refund
	// GET  /v1/payments/status
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}
