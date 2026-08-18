package plugins_test

import (
	"context"
	"fmt"
	"testing"

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
