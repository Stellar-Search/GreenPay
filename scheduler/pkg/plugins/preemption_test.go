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
	"k8s.io/client-go/kubernetes/fake"
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

func newPreemptionPluginWithPDBs(t *testing.T, nodes []*framework.NodeInfo, pdbs ...*policyv1.PodDisruptionBudget) *plugins.MLWorkloadPreemption {
	t.Helper()
	client := fake.NewSimpleClientset()
	informerFactory := informers.NewSharedInformerFactory(client, 0)
	pdbInformer := informerFactory.Policy().V1().PodDisruptionBudgets().Informer()
	for _, pdb := range pdbs {
		if pdb != nil {
			_ = pdbInformer.GetStore().Add(pdb)
		}
	}
	h := &mockHandle{
		sharedLister: &mockSharedLister{
			nodeLister: &mockNodeInfoLister{nodes: nodes},
		},
		informerFactory: informerFactory,
	}
	p, err := plugins.NewMLWorkloadPreemption(context.Background(), nil, h)
	if err != nil {
		t.Fatalf("NewMLWorkloadPreemption: %v", err)
	}
	return p.(*plugins.MLWorkloadPreemption)
}

func newPreemptionPlugin(t *testing.T, nodes []*framework.NodeInfo) *plugins.MLWorkloadPreemption {
	return newPreemptionPluginWithPDBs(t, nodes)
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

func TestPreemption_PDB_BudgetOfOneWithTwoCandidates(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node.Name = "gpu-node-pdb-budget"

	// 2 candidate victims, each 20GiB VRAM, both in app: batch-job
	v1 := makePodWithPriority("batch-job-1", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "20480",
	})
	v1.Labels = map[string]string{"app": "batch-job"}

	v2 := makePodWithPriority("batch-job-2", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "20480",
	})
	v2.Labels = map[string]string{"app": "batch-job"}

	ni := makeNodeInfoWithPods(node, v1, v2)

	// Case 1: Preemptor needs 40GiB (requires both victims).
	// PDB has DisruptionsAllowed: 1.
	// First victim consumes budget -> 0. Second victim cannot be evicted.
	// Preemption fails because only 20GiB freed < 40GiB needed.
	pdbBudget1 := makePDB("default", "batch-pdb", map[string]string{"app": "batch-job"}, 1)
	p1 := newPreemptionPluginWithPDBs(t, []*framework.NodeInfo{ni}, pdbBudget1)

	preemptor40 := makePodWithPriority("training-job-40", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	result1, status1 := p1.PostFilter(context.Background(), &framework.CycleState{}, preemptor40, framework.NodeToStatusMap{})
	if status1.Code() != framework.Unschedulable {
		t.Errorf("expected Unschedulable when PDB budget of 1 is exceeded by 2 required victims, got: %v", status1.Code())
	}
	if result1 != nil {
		t.Errorf("expected nil result when PDB budget exceeded, got nominated node: %v", result1.NominatedNodeName)
	}

	// Case 2: Preemptor needs only 20GiB (requires 1 victim).
	// PDB has DisruptionsAllowed: 1.
	// First victim consumes 1 budget and satisfies capacity.
	// Preemption succeeds.
	preemptor20 := makePodWithPriority("training-job-20", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "20480",
	})

	result2, status2 := p1.PostFilter(context.Background(), &framework.CycleState{}, preemptor20, framework.NodeToStatusMap{})
	if !status2.IsSuccess() {
		t.Fatalf("expected Success status when 1 victim satisfies requirement within budget, got: %v", status2.Message())
	}
	if result2 == nil || result2.NominatedNodeName != "gpu-node-pdb-budget" {
		t.Errorf("expected nominated node gpu-node-pdb-budget, got: %v", result2)
	}

	// Case 3: Preemptor needs 40GiB (requires both victims).
	// PDB has DisruptionsAllowed: 2.
	// Both victims can be evicted.
	// Preemption succeeds.
	pdbBudget2 := makePDB("default", "batch-pdb", map[string]string{"app": "batch-job"}, 2)
	p2 := newPreemptionPluginWithPDBs(t, []*framework.NodeInfo{ni}, pdbBudget2)

	result3, status3 := p2.PostFilter(context.Background(), &framework.CycleState{}, preemptor40, framework.NodeToStatusMap{})
	if !status3.IsSuccess() {
		t.Fatalf("expected Success status when PDB budget of 2 permits 2 victims, got: %v", status3.Message())
	}
	if result3 == nil || result3.NominatedNodeName != "gpu-node-pdb-budget" {
		t.Errorf("expected nominated node gpu-node-pdb-budget, got: %v", result3)
	}
}

func TestPreemption_PDB_VictimWithNoPDB(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node.Name = "gpu-node-unbudgeted"

	v1 := makePodWithPriority("unbudgeted-job-1", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "20480",
	})
	v1.Labels = map[string]string{"app": "unbudgeted"}

	v2 := makePodWithPriority("unbudgeted-job-2", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "20480",
	})
	v2.Labels = map[string]string{"app": "unbudgeted"}

	ni := makeNodeInfoWithPods(node, v1, v2)

	// Informer contains a PDB for a different app with 0 disruptions allowed
	otherPDB := makePDB("default", "other-app-pdb", map[string]string{"app": "other-app"}, 0)
	p := newPreemptionPluginWithPDBs(t, []*framework.NodeInfo{ni}, otherPDB)

	preemptor := makePodWithPriority("training-job", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if !status.IsSuccess() {
		t.Fatalf("expected Success status for unbudgeted victims, got: %v", status.Message())
	}
	if result == nil || result.NominatedNodeName != "gpu-node-unbudgeted" {
		t.Errorf("expected nominated node gpu-node-unbudgeted, got: %v", result)
	}
}

func TestPreemption_PDB_InvalidSelector(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node.Name = "gpu-node-invalid-pdb"

	victim := makePodWithPriority("batch-job", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})
	victim.Labels = map[string]string{"app": "batch-job"}

	ni := makeNodeInfoWithPods(node, victim)

	// PDB with invalid selector expression
	invalidPDB := &policyv1.PodDisruptionBudget{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: "default",
			Name:      "invalid-pdb",
		},
		Spec: policyv1.PodDisruptionBudgetSpec{
			Selector: &metav1.LabelSelector{
				MatchExpressions: []metav1.LabelSelectorRequirement{
					{
						Key:      "invalid key with spaces and !@#$%",
						Operator: metav1.LabelSelectorOpIn,
						Values:   []string{"val"},
					},
				},
			},
		},
		Status: policyv1.PodDisruptionBudgetStatus{
			DisruptionsAllowed: 0,
		},
	}

	p := newPreemptionPluginWithPDBs(t, []*framework.NodeInfo{ni}, invalidPDB)

	preemptor := makePodWithPriority("training-job", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if !status.IsSuccess() {
		t.Fatalf("expected Success status when PDB has invalid selector (should be ignored safely), got: %v", status.Message())
	}
	if result == nil || result.NominatedNodeName != "gpu-node-invalid-pdb" {
		t.Errorf("expected nominated node gpu-node-invalid-pdb, got: %v", result)
	}
}

func TestPreemption_PDB_MultiplePDBs_ConsumesAllMatchingBudgets(t *testing.T) {
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUModel:   "a100",
		hardware.LabelGPUVRAMMiB: "81920",
		hardware.LabelGPUCount:   "8",
	})
	node.Name = "gpu-node-multi-pdb"

	// victim1 matches both app: backend and tier: api (20GiB)
	v1 := makePodWithPriority("backend-api-1", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "20480",
	})
	v1.Labels = map[string]string{"app": "backend", "tier": "api"}

	// victim2 matches app: backend and tier: worker (20GiB)
	v2 := makePodWithPriority("backend-worker-1", 100, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLBatch,
		hardware.AnnotGPUVRAMMinMiB: "20480",
	})
	v2.Labels = map[string]string{"app": "backend", "tier": "worker"}

	ni := makeNodeInfoWithPods(node, v1, v2)

	// PDB-A (app: backend) has DisruptionsAllowed: 1
	// PDB-B (tier: api) has DisruptionsAllowed: 1
	pdbA := makePDB("default", "backend-pdb", map[string]string{"app": "backend"}, 1)
	pdbB := makePDB("default", "api-pdb", map[string]string{"tier": "api"}, 1)

	p := newPreemptionPluginWithPDBs(t, []*framework.NodeInfo{ni}, pdbA, pdbB)

	// Preemptor needs 40GiB (requires both victims).
	// v1 consumes 1 from pdbA (0 left) and 1 from pdbB (0 left).
	// v2 needs pdbA, but pdbA has 0 left -> v2 blocked.
	// Preemption fails.
	preemptor := makePodWithPriority("training-job", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "40960",
	})

	result, status := p.PostFilter(context.Background(), &framework.CycleState{}, preemptor, framework.NodeToStatusMap{})
	if status.Code() != framework.Unschedulable {
		t.Errorf("expected Unschedulable when multiple PDB budget shared with second victim is exhausted, got: %v", status.Code())
	}
	if result != nil {
		t.Errorf("expected nil result when PDB budget exhausted, got: %v", result)
	}

	// Also verify: If pdbA has budget 1, but pdbB has budget 0, v1 cannot be disrupted from start.
	pdbBZero := makePDB("default", "api-pdb", map[string]string{"tier": "api"}, 0)
	pBlocked := newPreemptionPluginWithPDBs(t, []*framework.NodeInfo{ni}, pdbA, pdbBZero)
	preemptor20 := makePodWithPriority("training-job-20", 1000, map[string]string{
		hardware.AnnotWorkloadType:  hardware.WorkloadMLTraining,
		hardware.AnnotGPUVRAMMinMiB: "20480",
	})
	// v1 is evaluated first (priority tie break by name: backend-api-1 vs backend-worker-1).
	// v1 has pdbBZero -> blocked. v2 is evaluated -> pdbA has 1 budget -> v2 selected -> frees 20GiB -> succeeds.
	resultBlocked, statusBlocked := pBlocked.PostFilter(context.Background(), &framework.CycleState{}, preemptor20, framework.NodeToStatusMap{})
	if !statusBlocked.IsSuccess() {
		t.Fatalf("expected Success status when alternative candidate v2 is evictable, got: %v", statusBlocked.Message())
	}
	if resultBlocked == nil || resultBlocked.NominatedNodeName != "gpu-node-multi-pdb" {
		t.Errorf("expected nominated node gpu-node-multi-pdb, got: %v", resultBlocked)
	}
}

func TestPreemption_PDBTracker_Unit(t *testing.T) {
	pdb1 := makePDB("default", "pdb-1", map[string]string{"app": "app-1"}, 1)
	pdb2 := makePDB("default", "pdb-2", map[string]string{"env": "prod"}, 2)

	tracker := plugins.NewPDBTracker([]*policyv1.PodDisruptionBudget{pdb1, pdb2})

	podA := makePodWithPriority("pod-a", 100, nil)
	podA.Labels = map[string]string{"app": "app-1", "env": "prod"}

	podB := makePodWithPriority("pod-b", 100, nil)
	podB.Labels = map[string]string{"app": "app-1"}

	tracker.PrecomputePodMatches([]*corev1.Pod{podA, podB})

	budget := tracker.NewNodeBudget()

	// podA matches both pdb1 (budget 1) and pdb2 (budget 2)
	if !budget.CanDisrupt(podA) {
		t.Errorf("expected podA to be disruptable initially")
	}

	budget.ConsumeBudget(podA)

	// Now pdb1 has budget 0, pdb2 has budget 1
	// podB matches pdb1 (budget 0), so it should not be disruptable
	if budget.CanDisrupt(podB) {
		t.Errorf("expected podB to be protected after pdb1 budget exhausted")
	}

	// Check IsPDBViolated helper
	if plugins.IsPDBViolated(podA, []*policyv1.PodDisruptionBudget{pdb1, pdb2}) {
		t.Errorf("expected podA not to violate initial PDB budgets > 0")
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
