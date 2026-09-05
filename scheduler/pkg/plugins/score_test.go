package plugins_test

import (
	"context"
	"math"
	"strconv"
	"sync"
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

// ── Missing-metadata policy (issue #335) ─────────────────────────────────────

// unlabelledGPUNode builds a node carrying no greenpay.io labels at all whose
// accelerators are visible only the way a device plugin makes them visible:
// as an extended resource on node.status.allocatable.
func unlabelledGPUNode(nodeName string, totalGPUs, requestedGPUs int64) *framework.NodeInfo {
	node := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: nodeName},
		Status: corev1.NodeStatus{
			Capacity: corev1.ResourceList{
				"nvidia.com/gpu": *resource.NewQuantity(totalGPUs, resource.DecimalSI),
			},
			Allocatable: corev1.ResourceList{
				"nvidia.com/gpu": *resource.NewQuantity(totalGPUs, resource.DecimalSI),
			},
		},
	}

	ni := framework.NewNodeInfo()
	ni.SetNode(node)
	ni.Requested = &framework.Resource{
		ScalarResources: map[corev1.ResourceName]int64{"nvidia.com/gpu": requestedGPUs},
	}
	return ni
}

// labelledGPUNode builds the same node fully characterised by the operator.
func labelledGPUNode(nodeName string, totalGPUs, requestedGPUs int64) *framework.NodeInfo {
	node := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: nodeName,
			Labels: map[string]string{
				hardware.LabelGPUVendor: hardware.GPUVendorNvidia,
				hardware.LabelGPUCount:  strconv.FormatInt(totalGPUs, 10),
			},
		},
	}

	ni := framework.NewNodeInfo()
	ni.SetNode(node)
	ni.Requested = &framework.Resource{
		ScalarResources: map[corev1.ResourceName]int64{"nvidia.com/gpu": requestedGPUs},
	}
	return ni
}

// Acceptance criterion: an unlabelled node with 8/8 GPUs allocated (via
// allocatable resources, no greenpay.io labels) does NOT score 100 for
// fragmentation.
//
// Before the fix this node took the !HasGPU() short-circuit and was handed the
// maximum score without its allocation ever being looked at. It now reaches the
// V-curve, and because its GPU total comes from an advertised extended resource
// rather than an operator attestation it is scored at inferred confidence: the
// top of the range stays reserved for a node whose capacity is actually known.
//
// That distinction is not academic. kubelet removes unhealthy devices from
// allocatable, so "every advertised GPU is busy" can equally mean "the only two
// GPUs still working are busy" on an eight-GPU node — and awarding a perfect
// score to that is the same class of error as the bug being fixed.
func TestFragmentationScore_UnlabelledFullyAllocatedNodeIsNotPerfect(t *testing.T) {
	plugin := newScorePlugin(t)

	unlabelled := plugin.FragmentationScoreForTest(unlabelledGPUNode("unlabelled-full", 8, 8))
	if unlabelled == 100.0 {
		t.Fatalf("unlabelled 8/8 node scored a perfect %.1f for fragmentation", unlabelled)
	}

	// V-curve peak (100.0) discounted for an inferred GPU total.
	const wantUnlabelled = 75.0
	if math.Abs(unlabelled-wantUnlabelled) > 0.001 {
		t.Errorf("unlabelled 8/8 fragmentation score = %.3f, want %.3f", unlabelled, wantUnlabelled)
	}

	// The same node, correctly labelled, keeps the full V-curve score: the fix
	// changes what an uncharacterised node earns, not what a characterised one
	// earns, so labelling a node is always at least as good as not labelling it.
	labelled := plugin.FragmentationScoreForTest(labelledGPUNode("labelled-full", 8, 8))
	if math.Abs(labelled-100.0) > 0.001 {
		t.Errorf("labelled 8/8 fragmentation score = %.3f, want 100.000 (unchanged)", labelled)
	}
	if unlabelled >= labelled {
		t.Errorf("unlabelled node (%.3f) did not rank below its labelled equivalent (%.3f)", unlabelled, labelled)
	}
}

// Acceptance criterion: an unlabelled node cannot outrank an equivalent
// labelled node purely by lacking labels.
//
// Each case pairs a node that honestly reports genuinely poor characteristics
// against a node that reports nothing at all, and asserts the second does not
// score better. This is the property the whole policy exists to hold, so it is
// asserted on every sub-score — the issue calls out binPacking and bandwidth as
// carrying the mirror image of the fragmentation bug, and NUMA carried it too.
func TestMissingMetadataCannotOutrankHonestlyPoorMetadata(t *testing.T) {
	plugin := newScorePlugin(t)

	mlPodReqs := hardware.PodHardwareReqs{
		WorkloadType: hardware.WorkloadMLTraining,
		GPUCountReq:  4,
	}

	// A node reporting nothing: no greenpay.io labels, no advertised
	// accelerators, no observable utilisation.
	uninformative := framework.NewNodeInfo()
	uninformative.SetNode(&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "no-information"}})

	cases := []struct {
		name string
		// honest scores a node that reports poor-but-true characteristics.
		honest func() float64
		// unknown scores the node that reports nothing on that dimension.
		unknown func() float64
	}{
		{
			// Bin packing: an almost-empty node is the worst honest report,
			// because this dimension rewards density.
			name: "binPacking",
			honest: func() float64 {
				node := &corev1.Node{
					ObjectMeta: metav1.ObjectMeta{Name: "barely-used"},
					Status: corev1.NodeStatus{
						Allocatable: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("10")},
					},
				}
				ni := framework.NewNodeInfo()
				ni.SetNode(node)
				ni.Requested = &framework.Resource{MilliCPU: 1000}
				return plugin.BinPackingScoreForTest(ni)
			},
			unknown: func() float64 { return plugin.BinPackingScoreForTest(uninformative) },
		},
		{
			// Fragmentation: 6 of 8 GPUs allocated sits on the way down into
			// the V-curve trough — an honestly unattractive node.
			name: "fragmentation",
			honest: func() float64 {
				return plugin.FragmentationScoreForTest(labelledGPUNode("honestly-fragmented", 8, 6))
			},
			unknown: func() float64 { return plugin.FragmentationScoreForTest(uninformative) },
		},
		{
			// NUMA: four GPUs spread one per domain is the worst usable
			// distribution for a four-GPU request.
			name: "numa",
			honest: func() float64 {
				node := &corev1.Node{
					ObjectMeta: metav1.ObjectMeta{
						Name: "worst-spread",
						Labels: map[string]string{
							hardware.LabelGPUVendor:             hardware.GPUVendorNvidia,
							hardware.LabelGPUCount:              "4",
							hardware.LabelNUMANodes:             "4",
							hardware.LabelGPUNUMADistribution:   "1.1.1.1",
							hardware.LabelTopologyManagerPolicy: hardware.TopologyManagerPolicyRestricted,
							hardware.LabelTopologyManagerScope:  hardware.TopologyManagerScopePod,
						},
					},
				}
				ni := framework.NewNodeInfo()
				ni.SetNode(node)
				return plugin.NUMAScoreForTest(mlPodReqs, ni)
			},
			unknown: func() float64 { return plugin.NUMAScoreForTest(mlPodReqs, uninformative) },
		},
		{
			// Bandwidth: 1 Gbps against a 100 Gbps cluster maximum is the
			// weakest uplink a node can honestly declare.
			name: "bandwidth",
			honest: func() float64 {
				node := &corev1.Node{
					ObjectMeta: metav1.ObjectMeta{
						Name:   "slow-uplink",
						Labels: map[string]string{hardware.LabelNetworkBandwidthGbps: "1"},
					},
				}
				ni := framework.NewNodeInfo()
				ni.SetNode(node)
				return plugin.BandwidthScoreForTest(ni, 100)
			},
			unknown: func() float64 { return plugin.BandwidthScoreForTest(uninformative, 100) },
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			honest := tc.honest()
			unknown := tc.unknown()

			if unknown >= honest {
				t.Errorf(
					"node with no metadata scored %.3f against an honestly-poor node's %.3f: "+
						"withholding information must not be rewarded",
					unknown, honest,
				)
			}
			if unknown != 0.0 {
				t.Errorf("node with no metadata scored %.3f, want the unknown-metadata score 0.000", unknown)
			}
		})
	}
}

// The extended-resource fallback was unreachable: fragmentationScore returned
// early unless HasGPU() was true, which required a non-zero greenpay.io/gpu-count,
// which is exactly the condition the fallback tested for. This asserts it now
// executes and computes a real fraction from the advertised resource, rather
// than the node being written off as having no GPUs.
func TestFragmentationScore_ExtendedResourceFallbackIsReachable(t *testing.T) {
	plugin := newScorePlugin(t)

	// 2 of 8 advertised GPUs allocated: 0.25 is on the left arm of the V-curve,
	// so 100 × (0.85 − 0.25) / 0.85 = 70.588, discounted to 52.941 for an
	// inferred total. A score of 0 would mean the fallback is still dead and
	// the node was treated as having no GPUs; 100 would mean the old
	// short-circuit is still in place.
	got := plugin.FragmentationScoreForTest(unlabelledGPUNode("unlabelled-quarter", 8, 2))

	const want = 52.941
	if math.Abs(got-want) > 0.001 {
		t.Errorf("unlabelled 2/8 fragmentation score = %.3f, want %.3f", got, want)
	}

	// The fraction has to track the advertised total, not just be non-zero.
	fuller := plugin.FragmentationScoreForTest(unlabelledGPUNode("unlabelled-heavier", 8, 7))
	if fuller >= got {
		t.Errorf(
			"7/8 allocated scored %.3f and 2/8 scored %.3f: the V-curve trough is not being tracked "+
				"from the advertised GPU total",
			fuller, got,
		)
	}
}

// The boundary between "the operator says this node has no GPUs" and "nobody
// has told us anything about this node". Both parse to HasGPU() == false, which
// is why the old code conflated them and handed the maximum score to each.
func TestFragmentationScore_DeclaredNoGPUIsNotTheSameAsUnknown(t *testing.T) {
	plugin := newScorePlugin(t)

	nodeInfoWithLabels := func(nodeName string, labels map[string]string) *framework.NodeInfo {
		ni := framework.NewNodeInfo()
		ni.SetNode(&corev1.Node{
			ObjectMeta: metav1.ObjectMeta{Name: nodeName, Labels: labels},
		})
		return ni
	}

	// The runbook's CPU-node labelling (k8s/ml-workloads/node-labels.yaml).
	// There is no GPU capacity to fragment, so the dimension does not apply and
	// must not count against a node the operator has fully characterised.
	declaredCPU := plugin.FragmentationScoreForTest(nodeInfoWithLabels("cpu-node-01", map[string]string{
		hardware.LabelGPUVendor: hardware.GPUVendorNone,
		hardware.LabelGPUCount:  "0",
	}))
	if math.Abs(declaredCPU-100.0) > 0.001 {
		t.Errorf("declared CPU-only node scored %.3f, want 100.000 (dimension does not apply)", declaredCPU)
	}

	// A node carrying an unrelated label but nothing about its GPUs has not
	// been characterised at all.
	unlabelled := plugin.FragmentationScoreForTest(nodeInfoWithLabels("unknown-node", map[string]string{
		hardware.LabelNetworkZone: "zone-a",
	}))
	if unlabelled != 0.0 {
		t.Errorf("uncharacterised node scored %.3f, want the unknown-metadata score 0.000", unlabelled)
	}
}

// The device-plugin registration window found while tracing the scheduler's
// startup sequence: the greenpay.io labels are applied by hand, and accelerator
// extended resources appear only once a device plugin has registered with
// kubelet, so a node can be Ready and schedulable with neither signal present.
//
// The policy has to have defined behaviour there rather than guessing, and it
// has to recover on its own once a signal turns up — nothing re-scores a node
// on its behalf.
func TestFragmentationScore_DevicePluginRegistrationWindow(t *testing.T) {
	plugin := newScorePlugin(t)

	node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "fresh-node"}}

	// Stage 1: the Node object exists but kubelet has not posted a status yet.
	justRegistered := framework.NewNodeInfo()
	justRegistered.SetNode(node)
	if got := plugin.FragmentationScoreForTest(justRegistered); got != 0.0 {
		t.Errorf("node with no status scored %.3f, want the conservative 0.000", got)
	}

	// Stage 2: Ready, core resources reported, device plugin not yet
	// registered. Indistinguishable from a genuine CPU node, so it stays
	// conservative rather than assuming either way.
	node.Status.Allocatable = corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("64"),
		corev1.ResourceMemory: resource.MustParse("256Gi"),
	}
	ready := framework.NewNodeInfo()
	ready.SetNode(node)
	if got := plugin.FragmentationScoreForTest(ready); got != 0.0 {
		t.Errorf("Ready node with no accelerators advertised scored %.3f, want the conservative 0.000", got)
	}

	// Stage 3: the device plugin registers. The node is now scored on its real
	// allocation with no operator action: 3 of 4 GPUs allocated is 0.75, giving
	// 100 × (0.85 − 0.75) / 0.85 = 11.765, discounted to 8.824.
	node.Status.Allocatable["nvidia.com/gpu"] = *resource.NewQuantity(4, resource.DecimalSI)
	registered := framework.NewNodeInfo()
	registered.SetNode(node)
	registered.Requested = &framework.Resource{
		ScalarResources: map[corev1.ResourceName]int64{"nvidia.com/gpu": 3},
	}

	got := plugin.FragmentationScoreForTest(registered)
	const want = 8.824
	if math.Abs(got-want) > 0.001 {
		t.Errorf("node scored %.3f once its device plugin registered, want %.3f", got, want)
	}
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

// foreignState implements framework.StateData to simulate another plugin or collision.
type foreignState struct {
	data string
}

func (f *foreignState) Clone() framework.StateData {
	return &foreignState{data: f.data}
}

func TestScore_ForeignCycleStateValue_DegradesGracefully(t *testing.T) {
	ctx := context.Background()
	lister := &mockNodeInfoLister{}
	handle := &mockHandle{
		sharedLister: &mockSharedLister{nodeLister: lister},
	}

	node := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "node-test",
			Labels: map[string]string{
				hardware.LabelNetworkBandwidthGbps: "100",
			},
		},
	}
	ni := framework.NewNodeInfo()
	ni.SetNode(node)
	lister.nodes = []*framework.NodeInfo{ni}

	p, err := plugins.NewMLWorkloadScore(ctx, nil, handle)
	if err != nil {
		t.Fatalf("NewMLWorkloadScore: %v", err)
	}
	plugin := p.(*plugins.MLWorkloadScore)

	pod := &corev1.Pod{}
	cycleState := framework.NewCycleState()

	// Store a foreign value under the bandwidth key.
	cycleState.Write("greenpay/bandwidthState", &foreignState{data: "foreign-data"})

	// Score should degrade gracefully and not panic on type mismatch.
	score, status := plugin.Score(ctx, cycleState, pod, "node-test")
	if !status.IsSuccess() {
		t.Fatalf("Score failed with foreign cycle state: %v", status.Message())
	}
	if score < framework.MinNodeScore || score > framework.MaxNodeScore {
		t.Errorf("score %d out of bounds [0, 100]", score)
	}
}

func TestScore_MissingCycleStateValue_DegradesGracefully(t *testing.T) {
	ctx := context.Background()
	lister := &mockNodeInfoLister{}
	handle := &mockHandle{
		sharedLister: &mockSharedLister{nodeLister: lister},
	}

	node := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "node-test",
			Labels: map[string]string{
				hardware.LabelNetworkBandwidthGbps: "100",
			},
		},
	}
	ni := framework.NewNodeInfo()
	ni.SetNode(node)
	lister.nodes = []*framework.NodeInfo{ni}

	p, err := plugins.NewMLWorkloadScore(ctx, nil, handle)
	if err != nil {
		t.Fatalf("NewMLWorkloadScore: %v", err)
	}
	plugin := p.(*plugins.MLWorkloadScore)

	pod := &corev1.Pod{}
	cycleState := framework.NewCycleState()

	// Score without PreScore (empty CycleState) should degrade gracefully.
	score, status := plugin.Score(ctx, cycleState, pod, "node-test")
	if !status.IsSuccess() {
		t.Fatalf("Score failed with empty cycle state: %v", status.Message())
	}
	if score < framework.MinNodeScore || score > framework.MaxNodeScore {
		t.Errorf("score %d out of bounds [0, 100]", score)
	}
}

func TestScore_ConcurrentScoreAndClone_RaceFree(t *testing.T) {
	ctx := context.Background()
	lister := &mockNodeInfoLister{}
	handle := &mockHandle{
		sharedLister: &mockSharedLister{nodeLister: lister},
	}

	var nodes []*framework.NodeInfo
	for i := 0; i < 10; i++ {
		node := &corev1.Node{
			ObjectMeta: metav1.ObjectMeta{
				Name: "node-" + string(rune('a'+i)),
				Labels: map[string]string{
					hardware.LabelGPUVendor:            "nvidia",
					hardware.LabelGPUCount:             "8",
					hardware.LabelNetworkBandwidthGbps: "100",
				},
			},
		}
		ni := framework.NewNodeInfo()
		ni.SetNode(node)
		nodes = append(nodes, ni)
	}
	lister.nodes = nodes

	p, err := plugins.NewMLWorkloadScore(ctx, nil, handle)
	if err != nil {
		t.Fatalf("NewMLWorkloadScore: %v", err)
	}
	plugin := p.(*plugins.MLWorkloadScore)

	pod := &corev1.Pod{}
	cycleState := framework.NewCycleState()

	preStatus := plugin.PreScore(ctx, cycleState, pod, nodes)
	if !preStatus.IsSuccess() {
		t.Fatalf("PreScore failed: %v", preStatus.Message())
	}

	const workers = 30
	var wg sync.WaitGroup
	wg.Add(workers * 2)

	// Goroutines executing Score concurrently across nodes
	for i := 0; i < workers; i++ {
		nodeName := nodes[i%len(nodes)].Node().Name
		go func(name string) {
			defer wg.Done()
			for iter := 0; iter < 50; iter++ {
				score, status := plugin.Score(ctx, cycleState, pod, name)
				if !status.IsSuccess() {
					t.Errorf("Score failed: %v", status.Message())
				}
				if score < 0 || score > 100 {
					t.Errorf("score %d out of range", score)
				}
			}
		}(nodeName)
	}

	// Goroutines executing CycleState.Clone() concurrently
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for iter := 0; iter < 50; iter++ {
				cloned := cycleState.Clone()
				if cloned == nil {
					t.Errorf("expected non-nil cloned cycle state")
				}
			}
		}()
	}

	wg.Wait()
}
