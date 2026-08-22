package plugins_test

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/kubernetes/pkg/scheduler/framework"

	"github.com/greenpay/scheduler/pkg/hardware"
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
	plugin := newScorePlugin(t)

	// The V-curve is a property of the fragmentation heuristic alone, so it is
	// asserted directly rather than through Score(). The composite mixes in the
	// bin-packing term, which rises monotonically with GPU allocation and
	// carries a larger weight — it would mask the curve entirely.
	nodeInfoWithGPUs := func(nodeName string, totalGPUs, requestedGPUs int64) *framework.NodeInfo {
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
		// Deliberately do NOT set ni.Allocatable.ScalarResources["nvidia.com/gpu"]:
		// fragmentationScore already gets totalGPUs from the greenpay.io/gpu-count
		// label above. Setting it here would also feed binPackingScore's GPU
		// fraction (same underlying allocated/allocatable ratio), letting its
		// monotonically-increasing signal swamp fragmentationScore's V-shaped
		// one in the composite Score() this test asserts on.

		if ni.Requested == nil {
			ni.Requested = &framework.Resource{}
		}
		if ni.Requested.ScalarResources == nil {
			ni.Requested.ScalarResources = make(map[corev1.ResourceName]int64)
		}
		ni.Requested.ScalarResources["nvidia.com/gpu"] = requestedGPUs

		return ni
	}

	// Default threshold is 0.85, so ~87.5% allocation sits in the trough while
	// the empty and full ends of the curve score high.
	score0 := plugin.FragmentationScoreForTest(nodeInfoWithGPUs("node-0", 8, 0))
	score100 := plugin.FragmentationScoreForTest(nodeInfoWithGPUs("node-100", 8, 8))
	score85 := plugin.FragmentationScoreForTest(nodeInfoWithGPUs("node-85", 8, 7))

	if score0 <= score85 {
		t.Errorf("expected 0%% allocation score (%.2f) to be higher than near-fragThreshold score (%.2f)", score0, score85)
	}
	if score100 <= score85 {
		t.Errorf("expected 100%% allocation score (%.2f) to be higher than near-fragThreshold score (%.2f)", score100, score85)
	}

	// Shifting the threshold moves the trough with it.
	plugin.SetFragThreshold(0.50)

	score0Shifted := plugin.FragmentationScoreForTest(nodeInfoWithGPUs("node-0-shifted", 8, 0))
	score50Shifted := plugin.FragmentationScoreForTest(nodeInfoWithGPUs("node-50-shifted", 8, 4))

	if score0Shifted <= score50Shifted {
		t.Errorf("with fragThreshold=0.50, expected 0%% allocation score (%.2f) > 50%% allocation score (%.2f)", score0Shifted, score50Shifted)
	}

	_ = ctx
}

func TestPreScore_ComputesMaxBandwidth(t *testing.T) {
	ctx := context.Background()
	plugin := newScorePlugin(t)

	node1 := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "node-10gbps",
			Labels: map[string]string{
				hardware.LabelNetworkBandwidthGbps: "10",
			},
		},
	}
	node2 := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "node-100gbps",
			Labels: map[string]string{
				hardware.LabelNetworkBandwidthGbps: "100",
			},
		},
	}
	node3 := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "node-25gbps",
			Labels: map[string]string{
				hardware.LabelNetworkBandwidthGbps: "25",
			},
		},
	}

	ni1 := framework.NewNodeInfo()
	ni1.SetNode(node1)
	ni2 := framework.NewNodeInfo()
	ni2.SetNode(node2)
	ni3 := framework.NewNodeInfo()
	ni3.SetNode(node3)

	nodes := []*framework.NodeInfo{ni1, ni2, ni3}
	state := framework.NewCycleState()
	pod := &corev1.Pod{}

	status := plugin.PreScore(ctx, state, pod, nodes)
	if !status.IsSuccess() {
		t.Fatalf("PreScore failed: %v", status.Message())
	}

	raw, err := state.Read("greenpay/bandwidthState")
	if err != nil {
		t.Fatalf("state.Read failed: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil bandwidth state in CycleState")
	}
}

func TestMLWorkloadScore_Workflow_PreScoreToNormalizeScore(t *testing.T) {
	ctx := context.Background()

	lister := &mockNodeInfoLister{}
	handle := &mockHandle{
		sharedLister: &mockSharedLister{
			nodeLister: lister,
		},
	}

	nodeOptimal := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "node-optimal",
			Labels: map[string]string{
				hardware.LabelGPUVendor:             "nvidia",
				hardware.LabelGPUCount:              "8",
				hardware.LabelNUMANodes:             "2",
				hardware.LabelGPUNUMADistribution:   "4.4",
				hardware.LabelNetworkBandwidthGbps:  "100",
				hardware.LabelTopologyManagerPolicy: hardware.TopologyManagerPolicyRestricted,
				hardware.LabelTopologyManagerScope:  hardware.TopologyManagerScopePod,
			},
		},
		Status: corev1.NodeStatus{
			Capacity: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("10"),
			},
			Allocatable: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("2"),
			},
		},
	}
	niOptimal := framework.NewNodeInfo()
	niOptimal.SetNode(nodeOptimal)

	nodeMediocre := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "node-mediocre",
			Labels: map[string]string{
				hardware.LabelGPUVendor:            "nvidia",
				hardware.LabelGPUCount:             "8",
				hardware.LabelNetworkBandwidthGbps: "25",
			},
		},
		Status: corev1.NodeStatus{
			Capacity: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("10"),
			},
			Allocatable: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("4"),
			},
		},
	}
	niMediocre := framework.NewNodeInfo()
	niMediocre.SetNode(nodeMediocre)
	niMediocre.Allocatable = &framework.Resource{
		ScalarResources: map[corev1.ResourceName]int64{"nvidia.com/gpu": 8},
	}
	niMediocre.Requested = &framework.Resource{
		ScalarResources: map[corev1.ResourceName]int64{"nvidia.com/gpu": 0},
	}

	nodeBasic := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "node-basic",
			Labels: map[string]string{
				hardware.LabelNetworkBandwidthGbps: "10",
			},
		},
		Status: corev1.NodeStatus{
			Capacity: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("4"),
			},
			Allocatable: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("4"),
			},
		},
	}
	niBasic := framework.NewNodeInfo()
	niBasic.SetNode(nodeBasic)

	lister.nodes = []*framework.NodeInfo{niOptimal, niMediocre, niBasic}

	p, err := plugins.NewMLWorkloadScore(ctx, nil, handle)
	if err != nil {
		t.Fatalf("NewMLWorkloadScore: %v", err)
	}
	plugin := p.(*plugins.MLWorkloadScore)

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "ml-training-pod",
			Annotations: map[string]string{
				hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
				hardware.AnnotBinPackWeight: "1.0",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name: "trainer",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							"nvidia.com/gpu": resource.MustParse("4"),
						},
					},
				},
			},
		},
	}

	cycleState := framework.NewCycleState()
	nodes := []*framework.NodeInfo{niOptimal, niMediocre, niBasic}
	preStatus := plugin.PreScore(ctx, cycleState, pod, nodes)
	if !preStatus.IsSuccess() {
		t.Fatalf("PreScore failed: %v", preStatus.Message())
	}

	scoreOptimal, status := plugin.Score(ctx, cycleState, pod, "node-optimal")
	if !status.IsSuccess() {
		t.Fatalf("Score node-optimal failed: %v", status.Message())
	}

	scoreMediocre, status := plugin.Score(ctx, cycleState, pod, "node-mediocre")
	if !status.IsSuccess() {
		t.Fatalf("Score node-mediocre failed: %v", status.Message())
	}

	scoreBasic, status := plugin.Score(ctx, cycleState, pod, "node-basic")
	if !status.IsSuccess() {
		t.Fatalf("Score node-basic failed: %v", status.Message())
	}

	if scoreOptimal <= scoreMediocre {
		t.Errorf("expected scoreOptimal (%d) > scoreMediocre (%d)", scoreOptimal, scoreMediocre)
	}
	if scoreMediocre <= scoreBasic {
		t.Errorf("expected scoreMediocre (%d) > scoreBasic (%d)", scoreMediocre, scoreBasic)
	}

	scores := framework.NodeScoreList{
		{Name: "node-optimal", Score: scoreOptimal},
		{Name: "node-mediocre", Score: scoreMediocre},
		{Name: "node-basic", Score: scoreBasic},
	}
	normStatus := plugin.NormalizeScore(ctx, cycleState, pod, scores)
	if !normStatus.IsSuccess() {
		t.Fatalf("NormalizeScore failed: %v", normStatus.Message())
	}

	for _, ns := range scores {
		if ns.Score < framework.MinNodeScore || ns.Score > framework.MaxNodeScore {
			t.Errorf("node %s score out of bounds: %d", ns.Name, ns.Score)
		}
	}
}

func TestMLWorkloadScore_Score_NodeLookupCycleStateRegression(t *testing.T) {
	ctx := context.Background()

	lister := &mockNodeInfoLister{}
	handle := &mockHandle{
		sharedLister: &mockSharedLister{
			nodeLister: lister,
		},
	}

	nodeA := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "node-a",
			Labels: map[string]string{
				hardware.LabelGPUVendor:            "nvidia",
				hardware.LabelGPUCount:             "8",
				hardware.LabelNetworkBandwidthGbps: "100",
			},
		},
		Status: corev1.NodeStatus{
			Capacity: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("16"),
			},
			Allocatable: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("2"),
			},
		},
	}
	niA := framework.NewNodeInfo()
	niA.SetNode(nodeA)

	nodeB := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "node-b",
			Labels: map[string]string{
				hardware.LabelNetworkBandwidthGbps: "10",
			},
		},
		Status: corev1.NodeStatus{
			Capacity: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("4"),
			},
			Allocatable: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("4"),
			},
		},
	}
	niB := framework.NewNodeInfo()
	niB.SetNode(nodeB)

	lister.nodes = []*framework.NodeInfo{niA, niB}

	p, err := plugins.NewMLWorkloadScore(ctx, nil, handle)
	if err != nil {
		t.Fatalf("NewMLWorkloadScore: %v", err)
	}
	plugin := p.(*plugins.MLWorkloadScore)

	pod := &corev1.Pod{}
	cycleState := framework.NewCycleState()

	plugin.PreScore(ctx, cycleState, pod, lister.nodes)

	scoreA, statusA := plugin.Score(ctx, cycleState, pod, "node-a")
	if !statusA.IsSuccess() {
		t.Fatalf("Score node-a failed: %v", statusA.Message())
	}

	scoreB, statusB := plugin.Score(ctx, cycleState, pod, "node-b")
	if !statusB.IsSuccess() {
		t.Fatalf("Score node-b failed: %v", statusB.Message())
	}

	if scoreA == scoreB {
		t.Errorf("Score() returned identical score (%d) for node-a and node-b, indicating node-lookup or scoring no-op regression", scoreA)
	}
	if scoreA <= scoreB {
		t.Errorf("expected node-a score (%d) > node-b score (%d)", scoreA, scoreB)
	}

	scoreMissing, statusMissing := plugin.Score(ctx, cycleState, pod, "node-missing")
	if !statusMissing.IsSuccess() {
		t.Fatalf("Score node-missing failed: %v", statusMissing.Message())
	}
	if scoreMissing != framework.MaxNodeScore/2 {
		t.Errorf("expected missing node to receive neutral score %d, got %d", framework.MaxNodeScore/2, scoreMissing)
	}
}

func TestBinPackingScore_Isolation(t *testing.T) {
	ctx := context.Background()
	lister := &mockNodeInfoLister{}
	handle := &mockHandle{
		sharedLister: &mockSharedLister{nodeLister: lister},
	}
	p, err := plugins.NewMLWorkloadScore(ctx, nil, handle)
	if err != nil {
		t.Fatalf("NewMLWorkloadScore: %v", err)
	}
	plugin := p.(*plugins.MLWorkloadScore)

	// binPackingScore reads ni.Requested — the resources actual pods on the
	// node have asked for — not the node's static capacity/allocatable split
	// (that only reflects kubelet's fixed system reservation and is the same
	// for a node no matter what is scheduled on it; see the doc comment on
	// binPackingScore). Both nodes get identical allocatable CPU; only the
	// simulated already-running pod requests differ.
	nodeInfoWithUsage := func(nodeName string, allocatableCPU, requestedCPU int64) *framework.NodeInfo {
		node := &corev1.Node{
			ObjectMeta: metav1.ObjectMeta{Name: nodeName},
			Status: corev1.NodeStatus{
				Capacity:    corev1.ResourceList{corev1.ResourceCPU: *resource.NewMilliQuantity(allocatableCPU, resource.DecimalSI)},
				Allocatable: corev1.ResourceList{corev1.ResourceCPU: *resource.NewMilliQuantity(allocatableCPU, resource.DecimalSI)},
			},
		}

		ni := framework.NewNodeInfo()
		ni.SetNode(node)
		if ni.Allocatable == nil {
			ni.Allocatable = &framework.Resource{}
		}
		ni.Allocatable.MilliCPU = allocatableCPU
		if ni.Requested == nil {
			ni.Requested = &framework.Resource{}
		}
		ni.Requested.MilliCPU = requestedCPU

		return ni
	}

	// 8 of 10 CPU already requested — 80% packed — versus a completely empty node.
	score80 := plugin.BinPackingScoreForTest(nodeInfoWithUsage("node-80", 10000, 8000))
	score0 := plugin.BinPackingScoreForTest(nodeInfoWithUsage("node-0", 10000, 0))

	if score80 <= score0 {
		t.Errorf("expected 80%% utilized node score (%.2f) > 0%% utilized node score (%.2f)", score80, score0)
	}
}
