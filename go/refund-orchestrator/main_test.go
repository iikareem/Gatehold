package main

import (
	"encoding/json"
	"testing"
)

func TestHandlerProbe_StreamHasRecords(t *testing.T) {
	raw := []byte(`{"Records":[{"eventID":"1","eventName":"MODIFY"}]}`)
	var probe struct {
		Records json.RawMessage `json:"Records"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatal(err)
	}
	if len(probe.Records) == 0 {
		t.Fatal("expected Records present for stream path")
	}
}

func TestHandlerProbe_ScheduleHasNoRecords(t *testing.T) {
	raw := []byte(`{"version":"0","source":"aws.scheduler","detail-type":"Scheduled Event"}`)
	var probe struct {
		Records json.RawMessage `json:"Records"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatal(err)
	}
	if len(probe.Records) != 0 {
		t.Fatal("expected empty Records for schedule path")
	}
}
