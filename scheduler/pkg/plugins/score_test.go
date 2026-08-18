package plugins_test

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/kubernetes/pkg/scheduler/framework"

	"github.com/greenpay/scheduler/pkg/plugins"
)

func newScorePlugin(t *testing.T) *plugins.MLWorkloadScore {
	t.Helper()
	p, err := plugins.NewMLWorkloadScore(context.Background(), nil, nil)
	if err != nil {
		t.Fatalf("NewMLWorkloadScore: %v", err)
	}
	return p.(*plugins.MLWorkloadScore)
}

func TestNormalizeScore_PreservesAbsoluteMagnitude_MediocreCluster(t *testing.T) {
	plugin := newScorePlugin(t)
	pod := &corev1.Pod{}

	// Cluster of candidate nodes with mediocre scores (~40).
	// Under relative-max normalization, node-2 (42) would previously get stretched to 100.
	scores := framework.NodeScoreList{
		{Name: "node-1", Score: 38},
		{Name: "node-2", Score: 42},
		{Name: "node-3", Score: 40},
	}

	status := plugin.NormalizeScore(context.Background(), &framework.CycleState{}, pod, scores)
	if !status.IsSuccess() {
		t.Fatalf("NormalizeScore failed: %v", status.Message())
	}

	// Assert that no node was stretched to MaxNodeScore (100).
	for _, ns := range scores {
		if ns.Score == framework.MaxNodeScore {
			t.Errorf("node %s was incorrectly stretched to MaxNodeScore (100)", ns.Name)
		}
	}

	// Assert exact absolute score preservation.
	expected := map[string]int64{
		"node-1": 38,
		"node-2": 42,
		"node-3": 40,
	}

	for _, ns := range scores {
		exp, ok := expected[ns.Name]
		if !ok {
			t.Errorf("unexpected node: %s", ns.Name)
			continue
		}
		if ns.Score != exp {
			t.Errorf("node %s: expected score %d, got %d", ns.Name, exp, ns.Score)
		}
	}
}

func TestNormalizeScore_ClampsOutOfRangeScores(t *testing.T) {
	plugin := newScorePlugin(t)
	pod := &corev1.Pod{}

	scores := framework.NodeScoreList{
		{Name: "node-negative", Score: -10},
		{Name: "node-valid", Score: 50},
		{Name: "node-overflow", Score: 120},
	}

	status := plugin.NormalizeScore(context.Background(), &framework.CycleState{}, pod, scores)
	if !status.IsSuccess() {
		t.Fatalf("NormalizeScore failed: %v", status.Message())
	}

	expected := map[string]int64{
		"node-negative": framework.MinNodeScore, // 0
		"node-valid":    50,
		"node-overflow": framework.MaxNodeScore, // 100
	}

	for _, ns := range scores {
		exp := expected[ns.Name]
		if ns.Score != exp {
			t.Errorf("node %s: expected score %d, got %d", ns.Name, exp, ns.Score)
		}
	}
}

func TestNormalizeScore_HighScoreCluster_PreservesHighScores(t *testing.T) {
	plugin := newScorePlugin(t)
	pod := &corev1.Pod{}

	scores := framework.NodeScoreList{
		{Name: "node-optimal", Score: 95},
		{Name: "node-good", Score: 85},
		{Name: "node-fair", Score: 70},
	}

	status := plugin.NormalizeScore(context.Background(), &framework.CycleState{}, pod, scores)
	if !status.IsSuccess() {
		t.Fatalf("NormalizeScore failed: %v", status.Message())
	}

	expected := map[string]int64{
		"node-optimal": 95,
		"node-good":    85,
		"node-fair":    70,
	}

	for _, ns := range scores {
		exp := expected[ns.Name]
		if ns.Score != exp {
			t.Errorf("node %s: expected score %d, got %d", ns.Name, exp, ns.Score)
		}
	}
}

func TestScoreExtensions_ReturnsSelf(t *testing.T) {
	plugin := newScorePlugin(t)
	ext := plugin.ScoreExtensions()
	if ext == nil {
		t.Fatal("expected ScoreExtensions to return non-nil")
	}
	if ext != plugin {
		t.Fatal("expected ScoreExtensions to return the plugin itself")
	}
}

func TestMLWorkloadScore_ConfigurableFragThreshold(t *testing.T) {
	// Default fragThreshold is 0.85.
	pluginDefault := newScorePlugin(t)
	if pluginDefault.FragThreshold() != 0.85 {
		t.Errorf("expected default fragThreshold 0.85, got %f", pluginDefault.FragThreshold())
	}

	// Configured via args.
	p, err := plugins.NewMLWorkloadScore(context.Background(), &plugins.MLWorkloadScoreArgs{FragThreshold: 0.60}, nil)
	if err != nil {
		t.Fatalf("NewMLWorkloadScore: %v", err)
	}
	pluginArgs := p.(*plugins.MLWorkloadScore)
	if pluginArgs.FragThreshold() != 0.60 {
		t.Errorf("expected fragThreshold 0.60, got %f", pluginArgs.FragThreshold())
	}

	// Configured via setter.
	pluginDefault.SetFragThreshold(0.75)
	if pluginDefault.FragThreshold() != 0.75 {
		t.Errorf("expected fragThreshold 0.75 after SetFragThreshold, got %f", pluginDefault.FragThreshold())
	}
}

func TestFragmentationScore_VCurve(t *testing.T) {
	ctx := context.Background()

	lister := &mockNodeInfoLister{}
	handle := &mockHandle{
		sharedLister: &mockSharedLister{
			nodeLister: lister,
		},
	}

	// Helper to create a NodeInfo snapshot with given requested and allocatable GPUs
	makeNodeInfoSnapshot := func(nodeName string, totalGPUs, requestedGPUs int64) (*framework.CycleState, *corev1.Node) {
		node := &corev1.Node{
			ObjectMeta: metav1.ObjectMeta{
				Name: nodeName,
				Labels: map[string]string{
					"greenpay.io/gpu-vendor": "nvidia",
					"greenpay.io/gpu-count":  "8",
				},
			},
		}

		ni := framework.NewNodeInfo()
		ni.SetNode(node)
		if ni.Allocatable == nil {
			ni.Allocatable = &framework.Resource{}
		}
		if ni.Allocatable.ScalarResources == nil {
			ni.Allocatable.ScalarResources = make(map[corev1.ResourceName]int64)
		}
		ni.Allocatable.ScalarResources["nvidia.com/gpu"] = totalGPUs

		if ni.Requested == nil {
			ni.Requested = &framework.Resource{}
		}
		if ni.Requested.ScalarResources == nil {
			ni.Requested.ScalarResources = make(map[corev1.ResourceName]int64)
		}
		ni.Requested.ScalarResources["nvidia.com/gpu"] = requestedGPUs

		lister.nodes = append(lister.nodes, ni)
		state := framework.NewCycleState()
		return state, node
	}

	pod := &corev1.Pod{}
	p, err := plugins.NewMLWorkloadScore(ctx, nil, handle)
	if err != nil {
		t.Fatalf("NewMLWorkloadScore: %v", err)
	}
	plugin := p.(*plugins.MLWorkloadScore)

	// 0% allocation (0 of 8 GPUs): score near 0% should be high
	state0, _ := makeNodeInfoSnapshot("node-0", 8, 0)
	score0, status := plugin.Score(ctx, state0, pod, "node-0")
	if !status.IsSuccess() {
		t.Fatalf("Score failed: %v", status.Message())
	}

	// 100% allocation (8 of 8 GPUs): score near 100% should be high
	state100, _ := makeNodeInfoSnapshot("node-100", 8, 8)
	score100, status := plugin.Score(ctx, state100, pod, "node-100")
	if !status.IsSuccess() {
		t.Fatalf("Score failed: %v", status.Message())
	}

	// 87.5% allocation (7 of 8 GPUs, close to 85% threshold): score should be low
	state85, _ := makeNodeInfoSnapshot("node-85", 8, 7)
	score85, status := plugin.Score(ctx, state85, pod, "node-85")
	if !status.IsSuccess() {
		t.Fatalf("Score failed: %v", status.Message())
	}

	// Scores near 0% and 100% allocation score high, near fragThreshold scores low.
	if score0 <= score85 {
		t.Errorf("expected 0%% allocation score (%d) to be higher than near-fragThreshold score (%d)", score0, score85)
	}
	if score100 <= score85 {
		t.Errorf("expected 100%% allocation score (%d) to be higher than near-fragThreshold score (%d)", score100, score85)
	}

	// Verify custom fragThreshold shift (e.g. fragThreshold = 0.50)
	plugin.SetFragThreshold(0.50)

	// 50% allocation (4 of 8 GPUs): should score low under threshold 0.50
	state50, _ := makeNodeInfoSnapshot("node-50", 8, 4)
	score50, status := plugin.Score(ctx, state50, pod, "node-50")
	if !status.IsSuccess() {
		t.Fatalf("Score failed: %v", status.Message())
	}

	if score0 <= score50 {
		t.Errorf("with fragThreshold=0.50, expected 0%% allocation score (%d) > 50%% allocation score (%d)", score0, score50)
	}
}
