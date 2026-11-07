package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"
)

const (
	emfNamespace             = "Gatehold"
	emfMetricInconsistencies = "ReconcilerInconsistencies"
	emfMetricOrdersChecked   = "ReconcilerOrdersChecked"
	emfDimensionStage        = "stage"
)

// emfPayload is CloudWatch Embedded Metric Format — one JSON log line
// that CloudWatch turns into custom metrics (no PutMetricData call).
type emfPayload struct {
	AWS                       emfAWS `json:"_aws"`
	Stage                     string `json:"stage"`
	ReconcilerInconsistencies int    `json:"ReconcilerInconsistencies"`
	ReconcilerOrdersChecked   int    `json:"ReconcilerOrdersChecked"`
}

type emfAWS struct {
	Timestamp         int64                `json:"Timestamp"`
	CloudWatchMetrics []emfMetricDirective `json:"CloudWatchMetrics"`
}

type emfMetricDirective struct {
	Namespace  string      `json:"Namespace"`
	Dimensions [][]string  `json:"Dimensions"`
	Metrics    []emfMetric `json:"Metrics"`
}

type emfMetric struct {
	Name string `json:"Name"`
	Unit string `json:"Unit"`
}

func stageDimension() string {
	if s := os.Getenv("STAGE"); s != "" {
		return s
	}
	return "local"
}

// emitEMF writes one EMF log line for the reconciler sweep totals.
func emitEMF(stats ReconcileStats) {
	payload := emfPayload{
		AWS: emfAWS{
			Timestamp: time.Now().UnixMilli(),
			CloudWatchMetrics: []emfMetricDirective{{
				Namespace:  emfNamespace,
				Dimensions: [][]string{{emfDimensionStage}},
				Metrics: []emfMetric{
					{Name: emfMetricInconsistencies, Unit: "Count"},
					{Name: emfMetricOrdersChecked, Unit: "Count"},
				},
			}},
		},
		Stage:                     stageDimension(),
		ReconcilerInconsistencies: stats.Inconsistencies,
		ReconcilerOrdersChecked:   stats.OrdersChecked,
	}

	b, err := json.Marshal(payload)
	if err != nil {
		log.Printf("emf marshal failed: %v", err)
		return
	}
	// Raw JSON on stdout (no log timestamp prefix) so CloudWatch parses EMF.
	fmt.Println(string(b))
}
