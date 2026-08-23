package plugins_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	informers "k8s.io/client-go/informers"
	"k8s.io/kubernetes/pkg/scheduler/framework"

	"github.com/greenpay/scheduler/pkg/hardware"
	"github.com/greenpay/scheduler/pkg/plugins"
)

type mockNodeInfoLister struct {
	nodes []*framework.NodeInfo
}

func (m *mockNodeInfoLister) List() ([]*framework.NodeInfo, error) {
	return m.nodes, nil
}
func (m *mockNodeInfoLister) HavePodsWithAffinityList() ([]*framework.NodeInfo, error) {
	return nil, nil
}
func (m *mockNodeInfoLister) HavePodsWithRequiredAntiAffinityList() ([]*framework.NodeInfo, error) {
	return nil, nil
}
func (m *mockNodeInfoLister) Get(nodeName string) (*framework.NodeInfo, error) {
	for _, n := range m.nodes {
		if n.Node() != nil && n.Node().Name == nodeName {
			return n, nil
		}
	}
	return nil, fmt.Errorf("node %s not found", nodeName)
}

type mockSharedLister struct {
	nodeLister framework.NodeInfoLister
}

func (m *mockSharedLister) NodeInfos() framework.NodeInfoLister {
	return m.nodeLister
}
func (m *mockSharedLister) StorageInfos() framework.StorageInfoLister {
	return nil
}

type mockHandle struct {
	framework.Handle
	sharedLister    framework.SharedLister
	informerFactory informers.SharedInformerFactory
}

func (m *mockHandle) SnapshotSharedLister() framework.SharedLister {
	return m.sharedLister
}

func (m *mockHandle) SharedInformerFactory() informers.SharedInformerFactory {
	return m.informerFactory
}

func newPreemptionPlugin(t *testing.T, nodes []*framework.NodeInfo) *plugins.MLWorkloadPreemption {
	t.Helper()
	h := &mockHandle{
		sharedLister: &mockSharedLister{
			nodeLister: &mockNodeInfoLister{nodes: nodes},
		},
	}
	p, err := plugins.NewMLWorkloadPreemption(context.Background(), nil, h)
	if err != nil {
		t.Fatalf("NewMLWorkloadPreemption: %v", err)
	}
	return p.(*plugins.MLWorkloadPreemption)
}

func makePodWithPriority(name string, priority int32, annots map[string]string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   "default",
			UID:         types.UID(name),
			Annotations: annots,
		},
		Spec: corev1.PodSpec{
			Priority: &priority,
		},
	}
}

func makeNodeInfoWithPods(node *corev1.Node, pods ...*corev1.Pod) *framework.NodeInfo {
	ni := framework.NewNodeInfo()
	ni.SetNode(node)
	for _, p := range pods {
		ni.AddPod(p)
	}
	return ni
}

// ── Tests ─────────────────────────────────────────────────────────────────────

func TestPreemption_Name(t *testing.T) {
	p := newPreemptionPlugin(t, nil)
	if p.Name() != plugins.MLWorkloadPreemptionName {
		t.Errorf("Name(): got %q, want %q", p.Name(), plugins.MLWorkloadPreemptionName)
	}
}

func TestPreemption_NoVictimsNeededOrAvailable(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
	})
	// Node has no running pods (no victims available)
	ni := makeNodeInfoWithPods(node)
	p := newPreemptionPlugin(t, []*framework.NodeInfo{ni})

	preemptor := makePodWithPriority("training-job", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if status.Code() != framework.Unschedulable {
		t.Errorf("expected Unschedulable when no victims available, got: %v", status.Code())
	}
	if result != nil {
		t.Errorf("expected nil result, got nominated node: %v", result.NominatedNodeName)
	}
}

func TestPreemption_SingleVictimSuccess(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node.Name = "gpu-node-1"

	// Running victim with lower priority (100) and 40GiB VRAM request
	victim := makePodWithPriority("batch-job", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	ni := makeNodeInfoWithPods(node, victim)
	p := newPreemptionPlugin(t, []*framework.NodeInfo{ni})

	// Preemptor with high priority (1000) requiring 40GiB VRAM
	preemptor := makePodWithPriority("training-job", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if !status.IsSuccess() {
		t.Fatalf("expected Success status, got: %v", status.Message())
	}
	if result == nil || result.NominatedNodeName != "gpu-node-1" {
		t.Errorf("expected nominated node gpu-node-1, got: %v", result)
	}
}

func TestPreemption_InsufficientCapacityEvenAfterPreemption(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "t4",
		hardware.LabelGPUVRAMMiB: "16384",
		hardware.LabelGPUCount:   "1",
	})
	node.Name = "gpu-node-small"

	// Victim only provides 16GiB VRAM
	victim := makePodWithPriority("inference-job", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLInference,
		hardware.AnnotGPUVRAMMinMiB: "16384",
	})

	ni := makeNodeInfoWithPods(node, victim)
	p := newPreemptionPlugin(t, []*framework.NodeInfo{ni})

	// Preemptor requires 80GiB VRAM (much larger than what preemption can free)
	preemptor := makePodWithPriority("large-training-job", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "81920",
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if status.Code() != framework.Unschedulable {
		t.Errorf("expected Unschedulable when preemption freed insufficient capacity, got: %v", status.Code())
	}
	if result != nil {
		t.Errorf("expected nil result, got: %v", result)
	}
}

func TestPreemption_ImmutableHardwareMismatch_SkipsNode(t *testing.T) {
	// Node has AMD GPUs
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "amd",
		hardware.LabelGPUModel:   "mi250",
		hardware.LabelGPUVRAMMiB: "65536",
	})
	node.Name = "amd-node"

	victim := makePodWithPriority("batch-job", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	ni := makeNodeInfoWithPods(node, victim)
	p := newPreemptionPlugin(t, []*framework.NodeInfo{ni})

	// Preemptor requires NVIDIA vendor specifically
	preemptor := makePodWithPriority("nvidia-training-job", 1000, map[string]string{
		hardware.AnnotGPUVendorReq:  hardware.GPUVendorNvidia,
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if status.Code() != framework.Unschedulable {
		t.Errorf("expected Unschedulable due to vendor mismatch, got: %v", status.Code())
	}
	if result != nil {
		t.Errorf("expected nil result on hardware mismatch, got: %v", result)
	}
}

func TestPreemption_HigherPriorityVictimCannotBePreempted(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
	})
	node.Name = "gpu-node-high"

	// Running pod has priority 2000 (higher than preemptor priority 1000)
	criticalPod := makePodWithPriority("critical-job", 2000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	ni := makeNodeInfoWithPods(node, criticalPod)
	p := newPreemptionPlugin(t, []*framework.NodeInfo{ni})

	preemptor := makePodWithPriority("training-job", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if status.Code() != framework.Unschedulable {
		t.Errorf("expected Unschedulable when victim priority >= preemptor priority, got: %v", status.Code())
	}
	if result != nil {
		t.Errorf("expected nil result, got: %v", result)
	}
}

func TestPreemption_PreemptorWithoutGPUorVRAM_DoesNotTriggerPreemption(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node.Name = "gpu-node-1"

	// Running lower-priority victim
	victim := makePodWithPriority("batch-job", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	ni := makeNodeInfoWithPods(node, victim)
	p := newPreemptionPlugin(t, []*framework.NodeInfo{ni})

	// Preemptor has high priority (1000) but requires NO GPU and NO VRAM (e.g. CPU-only API pod)
	preemptor := makePodWithPriority("cpu-api-job", 1000, map[string]string{
		hardware.AnnotWorkloadType: hardware.WorkloadAPI,
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if status.Code() != framework.Unschedulable {
		t.Errorf("expected Unschedulable when preemptor requires no GPU/VRAM, got: %v", status.Code())
	}
	if result != nil {
		t.Errorf("expected nil result for non-GPU preemptor, got: %v", result.NominatedNodeName)
	}
}

func TestPreemption_PreemptionPolicyNever_DoesNotPreempt(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node.Name = "gpu-node-1"

	victim := makePodWithPriority("batch-job", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	ni := makeNodeInfoWithPods(node, victim)
	p := newPreemptionPlugin(t, []*framework.NodeInfo{ni})

	// Preemptor with high priority (1000) requiring 40GiB VRAM, but PreemptionPolicy: Never
	neverPolicy := corev1.PreemptNever
	preemptor := makePodWithPriority("training-job", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})
	preemptor.Spec.PreemptionPolicy = &neverPolicy

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if status.Code() != framework.Unschedulable {
		t.Errorf("expected Unschedulable when PreemptionPolicy is Never, got: %v", status.Code())
	}
	if result != nil {
		t.Errorf("expected nil result for PreemptionPolicy Never, got: %v", result.NominatedNodeName)
	}
}

func TestPreemption_NonEvictablePods_DaemonSetMirrorTerminating_Excluded(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node.Name = "gpu-node-1"

	// 1. DaemonSet pod
	dsPod := makePodWithPriority("ds-pod", 100, map[string]string{
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})
	dsPod.OwnerReferences = []metav1.OwnerReference{
		{Kind: "DaemonSet", Name: "gpu-ds"},
	}

	// 2. Mirror pod
	mirrorPod := makePodWithPriority("mirror-pod", 100, map[string]string{
		corev1.MirrorPodAnnotationKey: "hash-mirror",
		hardware.AnnotGPUVRAMMinMiB:   "40960",
	})

	// 3. Terminating pod
	now := metav1.NewTime(time.Now())
	terminatingPod := makePodWithPriority("terminating-pod", 100, map[string]string{
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})
	terminatingPod.DeletionTimestamp = &now

	ni := makeNodeInfoWithPods(node, dsPod, mirrorPod, terminatingPod)
	p := newPreemptionPlugin(t, []*framework.NodeInfo{ni})

	preemptor := makePodWithPriority("training-job", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if status.Code() != framework.Unschedulable {
		t.Errorf("expected Unschedulable when all candidates are non-evictable, got: %v", status.Code())
	}
	if result != nil {
		t.Errorf("expected nil result when only non-evictable candidates exist, got: %v", result.NominatedNodeName)
	}
}

func TestPreemption_VictimFreeingZeroNeededResources_NeverSelected(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node.Name = "gpu-node-1"

	// Non-GPU pod freeing 0 GPU/VRAM
	nonGPUPod := makePodWithPriority("api-pod", 50, map[string]string{
		hardware.AnnotWorkloadType: hardware.WorkloadAPI,
	})

	// GPU pod freeing 40GiB VRAM
	gpuPod := makePodWithPriority("batch-job", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	ni := makeNodeInfoWithPods(node, nonGPUPod, gpuPod)
	p := newPreemptionPlugin(t, []*framework.NodeInfo{ni})

	preemptor := makePodWithPriority("training-job", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if !status.IsSuccess() {
		t.Fatalf("expected Success status, got: %v", status.Message())
	}
	if result == nil || result.NominatedNodeName != "gpu-node-1" {
		t.Fatalf("expected nominated node gpu-node-1, got: %v", result)
	}

	// Test when ONLY the non-GPU pod exists: preemption should fail (Unschedulable)
	niOnlyNonGPU := makeNodeInfoWithPods(node, nonGPUPod)
	pOnlyNonGPU := newPreemptionPlugin(t, []*framework.NodeInfo{niOnlyNonGPU})
	result2, status2 := pOnlyNonGPU.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if status2.Code() != framework.Unschedulable {
		t.Errorf("expected Unschedulable when candidate frees 0 required resources, got: %v", status2.Code())
	}
	if result2 != nil {
		t.Errorf("expected nil result when candidate frees 0 required resources, got: %v", result2.NominatedNodeName)
	}
}

func TestPreemption_DeterministicCost_TieOnCountDifferOnPriority(t *testing.T) {
	node1 := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node1.Name = "gpu-node-higher-victim-priority"

	node2 := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node2.Name = "gpu-node-lower-victim-priority"

	// Node 1 has 1 victim with priority 200
	victimNode1 := makePodWithPriority("victim-200", 200, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})
	ni1 := makeNodeInfoWithPods(node1, victimNode1)

	// Node 2 has 1 victim with priority 100
	victimNode2 := makePodWithPriority("victim-100", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})
	ni2 := makeNodeInfoWithPods(node2, victimNode2)

	p := newPreemptionPlugin(t, []*framework.NodeInfo{ni1, ni2})

	preemptor := makePodWithPriority("training-job", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if !status.IsSuccess() {
		t.Fatalf("expected Success status, got: %v", status.Message())
	}
	// Both nodes tie on victim count (1 victim each), but node2 has lower victim priority (100 < 200)
	if result == nil || result.NominatedNodeName != "gpu-node-lower-victim-priority" {
		t.Errorf("expected nominated node %q (lower victim priority), got: %v", "gpu-node-lower-victim-priority", result)
	}
}

func TestPreemption_DeterministicCost_TieOnCountAndMaxPriorityDifferOnSum(t *testing.T) {
	node1 := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node1.Name = "gpu-node-1"

	node2 := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node2.Name = "gpu-node-2"

	// Node 1: victims [100, 80] -> max 100, sum 180, count 2
	v1a := makePodWithPriority("v1a", 100, map[string]string{hardware.AnnotGPUVRAMMinMiB: "20480"})
	v1b := makePodWithPriority("v1b", 80, map[string]string{hardware.AnnotGPUVRAMMinMiB: "20480"})
	ni1 := makeNodeInfoWithPods(node1, v1a, v1b)

	// Node 2: victims [100, 20] -> max 100, sum 120, count 2
	v2a := makePodWithPriority("v2a", 100, map[string]string{hardware.AnnotGPUVRAMMinMiB: "20480"})
	v2b := makePodWithPriority("v2b", 20, map[string]string{hardware.AnnotGPUVRAMMinMiB: "20480"})
	ni2 := makeNodeInfoWithPods(node2, v2a, v2b)

	p := newPreemptionPlugin(t, []*framework.NodeInfo{ni1, ni2})

	preemptor := makePodWithPriority("training-job", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if !status.IsSuccess() {
		t.Fatalf("expected Success status, got: %v", status.Message())
	}
	// Node 2 has lower sum of priorities (120 < 180)
	if result == nil || result.NominatedNodeName != "gpu-node-2" {
		t.Errorf("expected nominated node %q (lower sum of victim priorities), got: %v", "gpu-node-2", result)
	}
}

func TestPreemption_GetPodPriority_NilPriorityReturnsZero(t *testing.T) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "nil-priority-pod",
			Annotations: map[string]string{
				hardware.AnnotWorkloadType: hardware.WorkloadMLTraining,
			},
		},
		Spec: corev1.PodSpec{
			Priority: nil,
		},
	}

	priority := plugins.GetPodPriority(pod)
	if priority != 0 {
		t.Errorf("GetPodPriority for pod with nil priority: got %d, want 0", priority)
	}
}

func TestPreemption_PDBProtection(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
	})
	node.Name = "gpu-node-pdb"

	victim := makePodWithPriority("protected-batch-job", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})
	victim.Labels = map[string]string{"app": "protected"}

	pdb := makePDB("default", "protected-pdb", map[string]string{"app": "protected"}, 0)

	// Verify PDB protection directly
	if !plugins.IsPDBViolated(victim, []*policyv1.PodDisruptionBudget{pdb}) {
		t.Errorf("expected victim with 0 allowed disruptions to be PDB protected")
	}
}

// Helper to make PDB object for unit tests
func makePDB(namespace, name string, matchLabels map[string]string, disruptionsAllowed int32) *policyv1.PodDisruptionBudget {
	return &policyv1.PodDisruptionBudget{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: namespace,
			Name:      name,
		},
		Spec: policyv1.PodDisruptionBudgetSpec{
			Selector: &metav1.LabelSelector{
				MatchLabels: matchLabels,
			},
		},
		Status: policyv1.PodDisruptionBudgetStatus{
			DisruptionsAllowed: disruptionsAllowed,
		},
	}
}

func parseResourceQuantity(val string) resource.Quantity {
	return resource.MustParse(val)
}
