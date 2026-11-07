package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
)

func TestEmitEMF_producesValidCloudWatchLine(t *testing.T) {
	t.Setenv("STAGE", "dev")

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	prev := os.Stdout
	os.Stdout = w
	emitEMF(ReconcileStats{OrdersChecked: 3, Inconsistencies: 2})
	_ = w.Close()
	os.Stdout = prev

	var buf bytes.Buffer
	if _, err := io.Copy(&buf, r); err != nil {
		t.Fatal(err)
	}
	_ = r.Close()

	line := strings.TrimSpace(buf.String())
	if line == "" {
		t.Fatal("expected EMF log line")
	}
	if !strings.HasPrefix(line, "{") {
		t.Fatalf("EMF must be raw JSON (no log prefix), got %q", line)
	}

	var payload emfPayload
	if err := json.Unmarshal([]byte(line), &payload); err != nil {
		t.Fatalf("EMF JSON: %v\nline=%s", err, line)
	}

	if payload.Stage != "dev" {
		t.Errorf("stage=%q want dev", payload.Stage)
	}
	if payload.ReconcilerInconsistencies != 2 {
		t.Errorf("inconsistencies=%d want 2", payload.ReconcilerInconsistencies)
	}
	if payload.ReconcilerOrdersChecked != 3 {
		t.Errorf("ordersChecked=%d want 3", payload.ReconcilerOrdersChecked)
	}
	if payload.AWS.Timestamp == 0 {
		t.Error("expected non-zero Timestamp")
	}
	if len(payload.AWS.CloudWatchMetrics) != 1 {
		t.Fatalf("CloudWatchMetrics len=%d", len(payload.AWS.CloudWatchMetrics))
	}
	dir := payload.AWS.CloudWatchMetrics[0]
	if dir.Namespace != emfNamespace {
		t.Errorf("namespace=%q", dir.Namespace)
	}
	if len(dir.Dimensions) != 1 || len(dir.Dimensions[0]) != 1 || dir.Dimensions[0][0] != emfDimensionStage {
		t.Errorf("dimensions=%v", dir.Dimensions)
	}
	if len(dir.Metrics) != 2 {
		t.Fatalf("metrics=%v", dir.Metrics)
	}
	names := map[string]bool{}
	for _, m := range dir.Metrics {
		names[m.Name] = true
		if m.Unit != "Count" {
			t.Errorf("unit=%q for %s", m.Unit, m.Name)
		}
	}
	if !names[emfMetricInconsistencies] || !names[emfMetricOrdersChecked] {
		t.Errorf("metric names=%v", names)
	}
}

func TestStageDimension_fallback(t *testing.T) {
	os.Unsetenv("STAGE")
	if got := stageDimension(); got != "local" {
		t.Errorf("got %q want local", got)
	}
}
