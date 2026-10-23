package main

import "net/http"

// Chaos applies optional failure injection (latency, 429, errors, timeout).
// Behavior is wired in Step 8; skeleton only holds config.
type Chaos struct {
	cfg Config
}

func NewChaos(cfg Config) *Chaos {
	return &Chaos{cfg: cfg}
}

// MaybeInject runs before a handler response. No-op until Step 8.
// Returns true if the response was already written (caller should return).
func (c *Chaos) MaybeInject(w http.ResponseWriter, r *http.Request) (done bool) {
	_ = w
	_ = r
	return false
}
