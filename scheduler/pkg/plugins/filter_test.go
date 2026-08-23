package plugins_test

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/kubernetes/pkg/scheduler/framework"

	"github.com/greenpay/scheduler/pkg/hardware"
	"github.com/greenpay/scheduler/pkg/plugins"
)

// ── helpers ───────────────────────────────────────────────────────────────────

func makeNode(labels map[string]string) *corev1.Node {
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name:   "test-node",
			Labels: labels,
		},
		Status: corev1.NodeStatus{
			Allocatable: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("32"),
				corev1.ResourceMemory: resource.MustParse("128Gi"),
			},
		},
	}
}

func makePod(annots map[string]string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "test-pod",
			Namespace:   "default",
			Annotations: annots,
		},
	}
}

func makeNodeInfo(node *corev1.Node) *framework.NodeInfo {
	ni := framework.NewNodeInfo()
	ni.SetNode(node)
	return ni
}

func newFilter(t *testing.T) *plugins.GPUHardwareFilter {
	t.Helper()
	p, err := plugins.NewGPUHardwareFilter(context.Background(), nil, nil)
	if err != nil {
		t.Fatalf("NewGPUHardwareFilter: %v", err)
	}
	return p.(*plugins.GPUHardwareFilter)
}

// ── Filter tests ──────────────────────────────────────────────────────────────

func TestFilter_NoRequirements_PassesAnyNode(t *testing.T) {
	f := newFilter(t)
	pod := makePod(nil)
	node := makeNode(map[string]string{hardware.LabelGPUVendor: "nvidia"})
	ni := makeNodeInfo(node)

	status := f.Filter(context.Background(), &framework.CycleState{}, pod, ni)
	if !status.IsSuccess() {
		t.Errorf("expected Success, got: %v", status.Message())
	}
}

func TestFilter_VendorMatch_Passes(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotGPUVendorReq: "nvidia"})
	node := makeNode(map[string]string{hardware.LabelGPUVendor: "nvidia", hardware.LabelGPUCount: "8"})
	status := f.Filter(context.Background(), &framework.CycleState{}, pod, makeNodeInfo(node))
	if !status.IsSuccess() {
		t.Errorf("vendor match: expected Success, got: %v", status.Message())
	}
}

func TestFilter_VendorMismatch_UnschedulableAndUnresolvable(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotGPUVendorReq: "amd"})
	node := makeNode(map[string]string{hardware.LabelGPUVendor: "nvidia"})
	status := f.Filter(context.Background(), &framework.CycleState{}, pod, makeNodeInfo(node))
	if status.Code() != framework.UnschedulableAndUnresolvable {
		t.Errorf("vendor mismatch: expected UnschedulableAndUnresolvable, got: %v", status.Code())
	}
}

func TestFilter_GPUModelMatch_Passes(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{
		hardware.AnnotGPUVendorReq: "nvidia",
		hardware.AnnotGPUModelReq:  "a100",
	})
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor: "nvidia",
		hardware.LabelGPUModel:  "a100",
		hardware.LabelGPUCount:  "8",
	})
	status := f.Filter(context.Background(), &framework.CycleState{}, pod, makeNodeInfo(node))
	if !status.IsSuccess() {
		t.Errorf("model match: expected Success, got: %v", status.Message())
	}
}

func TestFilter_GPUModelMismatch_UnschedulableAndUnresolvable(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{
		hardware.AnnotGPUModelReq: "h100",
	})
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor: "nvidia",
		hardware.LabelGPUModel:  "a100",
	})
	status := f.Filter(context.Background(), &framework.CycleState{}, pod, makeNodeInfo(node))
	if status.Code() != framework.UnschedulableAndUnresolvable {
		t.Errorf("model mismatch: expected UnschedulableAndUnresolvable, got: %v", status.Code())
	}
}

func TestFilter_VRAMSufficient_Passes(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotGPUVRAMMinMiB: "40960"})
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUCount:   "8",
		hardware.LabelGPUVRAMMiB: "81920", // 80 GiB > 40 GiB required
	})
	status := f.Filter(context.Background(), &framework.CycleState{}, pod, makeNodeInfo(node))
	if !status.IsSuccess() {
		t.Errorf("VRAM sufficient: expected Success, got: %v", status.Message())
	}
}

func TestFilter_VRAMInsufficient_UnschedulableAndUnresolvable(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotGPUVRAMMinMiB: "81920"})
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor:  "nvidia",
		hardware.LabelGPUCount:   "4",
		hardware.LabelGPUVRAMMiB: "16384", // 16 GiB T4 — not enough for 80 GiB requirement
	})
	status := f.Filter(context.Background(), &framework.CycleState{}, pod, makeNodeInfo(node))
	if status.Code() != framework.UnschedulableAndUnresolvable {
		t.Errorf("VRAM insufficient: expected UnschedulableAndUnresolvable, got: %v", status.Code())
	}
}

func TestFilter_VRAMRequired_NoGPUNode_UnschedulableAndUnresolvable(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotGPUVRAMMinMiB: "40960"})
	node := makeNode(map[string]string{
		hardware.LabelGPUVendor: "none",
		hardware.LabelGPUCount:  "0",
	})
	status := f.Filter(context.Background(), &framework.CycleState{}, pod, makeNodeInfo(node))
	if status.Code() != framework.UnschedulableAndUnresolvable {
		t.Errorf("VRAM req but no GPU: expected UnschedulableAndUnresolvable, got: %v", status.Code())
	}
}

func TestFilter_NetworkZoneMatch_Passes(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotNetworkZoneReq: "zone-a"})
	node := makeNode(map[string]string{hardware.LabelNetworkZone: "zone-a"})
	status := f.Filter(context.Background(), &framework.CycleState{}, pod, makeNodeInfo(node))
	if !status.IsSuccess() {
		t.Errorf("zone match: expected Success, got: %v", status.Message())
	}
}

func TestFilter_NetworkZoneMismatch_UnschedulableAndUnresolvable(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotNetworkZoneReq: "zone-a"})
	node := makeNode(map[string]string{hardware.LabelNetworkZone: "zone-b"})
	status := f.Filter(context.Background(), &framework.CycleState{}, pod, makeNodeInfo(node))
	if status.Code() != framework.UnschedulableAndUnresolvable {
		t.Errorf("zone mismatch: expected UnschedulableAndUnresolvable, got: %v", status.Code())
	}
}

func TestFilter_BandwidthSufficient_Passes(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotNetworkBWMinGbps: "25"})
	node := makeNode(map[string]string{hardware.LabelNetworkBandwidthGbps: "100"})
	status := f.Filter(context.Background(), &framework.CycleState{}, pod, makeNodeInfo(node))
	if !status.IsSuccess() {
		t.Errorf("bw sufficient: expected Success, got: %v", status.Message())
	}
}

func TestFilter_BandwidthInsufficient_UnschedulableAndUnresolvable(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotNetworkBWMinGbps: "100"})
	node := makeNode(map[string]string{hardware.LabelNetworkBandwidthGbps: "10"})
	status := f.Filter(context.Background(), &framework.CycleState{}, pod, makeNodeInfo(node))
	if status.Code() != framework.UnschedulableAndUnresolvable {
		t.Errorf("bw insufficient: expected UnschedulableAndUnresolvable, got: %v", status.Code())
	}
}

func TestFilter_VendorAny_SkipsVendorCheck(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotGPUVendorReq: hardware.GPUVendorAny})
	// Node has AMD GPU — should still pass because pod says "any"
	node := makeNode(map[string]string{hardware.LabelGPUVendor: "amd", hardware.LabelGPUCount: "4"})
	status := f.Filter(context.Background(), &framework.CycleState{}, pod, makeNodeInfo(node))
	if !status.IsSuccess() {
		t.Errorf("vendor any: expected Success, got: %v", status.Message())
	}
}

func TestFilter_FullyAllocatedGPU_Unschedulable(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotGPUVendorReq: "nvidia"})

	node := makeNode(map[string]string{
		hardware.LabelGPUVendor: "nvidia",
		hardware.LabelGPUCount:  "8",
	})
	node.Status.Allocatable[corev1.ResourceName("nvidia.com/gpu")] = resource.MustParse("8")

	ni := makeNodeInfo(node)

	// Simulate existing scheduled pods consuming all 8 GPUs
	existingPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "existing-gpu-pod",
			Namespace: "default",
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name: "worker",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceName("nvidia.com/gpu"): resource.MustParse("8"),
						},
					},
				},
			},
		},
	}
	ni.AddPod(existingPod)

	status := f.Filter(context.Background(), &framework.CycleState{}, pod, ni)
	if status.Code() != framework.Unschedulable {
		t.Fatalf("expected Unschedulable, got: %v", status.Code())
	}

	expectedReason := "0 of 8 GPUs free"
	if !strings.Contains(status.Message(), expectedReason) {
		t.Errorf("expected reason to contain %q, got %q", expectedReason, status.Message())
	}
}

func TestFilter_PartiallyAllocatedGPU_Passes(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotGPUVendorReq: "nvidia"})

	node := makeNode(map[string]string{
		hardware.LabelGPUVendor: "nvidia",
		hardware.LabelGPUCount:  "8",
	})
	node.Status.Allocatable[corev1.ResourceName("nvidia.com/gpu")] = resource.MustParse("8")

	ni := makeNodeInfo(node)

	// Simulate existing scheduled pod consuming 4 GPUs (4 remain free)
	existingPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "existing-gpu-pod",
			Namespace: "default",
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name: "worker",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceName("nvidia.com/gpu"): resource.MustParse("4"),
						},
					},
				},
			},
		},
	}
	ni.AddPod(existingPod)

	status := f.Filter(context.Background(), &framework.CycleState{}, pod, ni)
	if !status.IsSuccess() {
		t.Errorf("partially allocated GPU: expected Success, got: %v", status.Message())
	}
}

func TestFilter_FullyAllocatedGPU_NonGPUPod_Passes(t *testing.T) {
	f := newFilter(t)
	pod := makePod(map[string]string{hardware.AnnotGPUVendorReq: hardware.GPUVendorNone})

	node := makeNode(map[string]string{
		hardware.LabelGPUVendor: "nvidia",
		hardware.LabelGPUCount:  "8",
	})
	node.Status.Allocatable[corev1.ResourceName("nvidia.com/gpu")] = resource.MustParse("8")

	ni := makeNodeInfo(node)

	existingPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "existing-gpu-pod",
			Namespace: "default",
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name: "worker",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceName("nvidia.com/gpu"): resource.MustParse("8"),
						},
					},
				},
			},
		},
	}
	ni.AddPod(existingPod)

	status := f.Filter(context.Background(), &framework.CycleState{}, pod, ni)
	if !status.IsSuccess() {
		t.Errorf("non-GPU pod on fully allocated GPU node: expected Success, got: %v", status.Message())
	}
}

func TestFilter_NilNode_ReturnsError(t *testing.T) {
	f := newFilter(t)
	ni := framework.NewNodeInfo()
	// no node set — ni.Node() returns nil
	status := f.Filter(context.Background(), &framework.CycleState{}, makePod(nil), ni)
	if status.Code() != framework.Error {
		t.Errorf("nil node: expected Error, got: %v", status.Code())
	}
}

// TestFilter_Name ensures the plugin name constant is correct.
func TestFilter_Name(t *testing.T) {
	f := newFilter(t)
	if f.Name() != plugins.GPUHardwareFilterName {
		t.Errorf("Name(): got %q, want %q", f.Name(), plugins.GPUHardwareFilterName)
	}
}
