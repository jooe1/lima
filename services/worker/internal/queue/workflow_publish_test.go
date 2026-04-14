package queue

import (
	"context"
	"testing"
)

func TestPublishStepEvent_NilRdb(t *testing.T) {
	// Must not panic
	publishStepEvent(context.Background(), nil, workflowRunEvent{
		RunID:  "r1",
		AppID:  "a1",
		Status: "completed",
	})
}
