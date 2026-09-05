package hardware_test

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/greenpay/scheduler/pkg/hardware"
)

// ── NodeHardware parsing tests ────────────────────────────────────────────────

func TestParseNodeHardware_FullLabels(t *testing.T) {
	node := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "gpu-node-1",
			Labels: map[string]string{
				hardware.LabelGPUVendor:             "nvidia",
				hardware.LabelGPUModel:              "a100",
				hardware.LabelGPUCount:              "8",
				hardware.LabelGPUVRAMMiB:            "81920",
				hardware.LabelGPUInterconnect:       "nvlink",
				hardware.LabelNUMANodes:             "2",
				hardware.LabelGPUNUMADistribution:   "4.4",
				hardware.LabelTopologyManagerPolicy: "restricted",
				hardware.LabelTopologyManagerScope:  "pod",
				hardware.LabelNetworkZone:           "zone-a",
				hardware.LabelNetworkBandwidthGbps:  "100",
				hardware.LabelNodeTier:              "gpu-high",
			},
		},
	}

	hw := hardware.ParseNodeHardware(node)

	if hw.GPUVendor != "nvidia" {
		t.Errorf("GPUVendor: got %q, want %q", hw.GPUVendor, "nvidia")
	}
	if hw.GPUModel != "a100" {
		t.Errorf("GPUModel: got %q, want %q", hw.GPUModel, "a100")
	}
	if hw.GPUCount != 8 {
		t.Errorf("GPUCount: got %d, want 8", hw.GPUCount)
	}
	if hw.GPUVRAMMiB != 81920 {
		t.Errorf("GPUVRAMMiB: got %d, want 81920", hw.GPUVRAMMiB)
	}
	if hw.GPUInterconnect != "nvlink" {
		t.Errorf("GPUInterconnect: got %q, want %q", hw.GPUInterconnect, "nvlink")
	}
	if hw.NUMANodes != 2 {
		t.Errorf("NUMANodes: got %d, want 2", hw.NUMANodes)
	}
	if len(hw.GPUNUMADistribution) != 2 ||
		hw.GPUNUMADistribution[0] != 4 ||
		hw.GPUNUMADistribution[1] != 4 {
		t.Errorf("GPUNUMADistribution: got %v, want [4 4]", hw.GPUNUMADistribution)
	}
	if hw.TopologyManagerPolicy != hardware.TopologyManagerPolicyRestricted {
		t.Errorf(
			"TopologyManagerPolicy: got %q, want %q",
			hw.TopologyManagerPolicy,
			hardware.TopologyManagerPolicyRestricted,
		)
	}
	if hw.TopologyManagerScope != hardware.TopologyManagerScopePod {
		t.Errorf(
			"TopologyManagerScope: got %q, want %q",
			hw.TopologyManagerScope,
			hardware.TopologyManagerScopePod,
		)
	}
	if hw.NetworkZone != "zone-a" {
		t.Errorf("NetworkZone: got %q, want %q", hw.NetworkZone, "zone-a")
	}
	if hw.NetworkBandwidthGbps != 100 {
		t.Errorf("NetworkBandwidthGbps: got %d, want 100", hw.NetworkBandwidthGbps)
	}
	if hw.NodeTier != "gpu-high" {
		t.Errorf("NodeTier: got %q, want %q", hw.NodeTier, "gpu-high")
	}
}

func TestParseNodeHardware_NoLabels_Defaults(t *testing.T) {
	node := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: "plain-node"},
	}

	hw := hardware.ParseNodeHardware(node)

	if hw.GPUVendor != hardware.GPUVendorNone {
		t.Errorf("GPUVendor default: got %q, want %q", hw.GPUVendor, hardware.GPUVendorNone)
	}
	if hw.GPUCount != 0 {
		t.Errorf("GPUCount default: got %d, want 0", hw.GPUCount)
	}
	if hw.NodeTier != hardware.NodeTierCPUStandard {
		t.Errorf("NodeTier default: got %q, want %q", hw.NodeTier, hardware.NodeTierCPUStandard)
	}
}

func TestNodeHardware_HasGPU(t *testing.T) {
	cases := []struct {
		name    string
		hw      hardware.NodeHardware
		wantGPU bool
	}{
		{"nvidia 8x A100", hardware.NodeHardware{GPUVendor: "nvidia", GPUCount: 8}, true},
		{"vendor none", hardware.NodeHardware{GPUVendor: "none", GPUCount: 0}, false},
		{"empty vendor", hardware.NodeHardware{GPUVendor: "", GPUCount: 0}, false},
		{"count 0 with vendor", hardware.NodeHardware{GPUVendor: "nvidia", GPUCount: 0}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.hw.HasGPU()
			if got != tc.wantGPU {
				t.Errorf("HasGPU() = %v, want %v", got, tc.wantGPU)
			}
		})
	}
}

// An absent gpu-vendor label parses to GPUVendorNone, the same value the
// operator writes to declare a CPU-only node, so the parsed fields alone cannot
// tell "this node has no GPUs" from "nobody has labelled this node". Scoring
// depends on that distinction (issue #335), so presence is captured separately.
func TestParseNodeHardware_GPUMetadataDeclaration(t *testing.T) {
	cases := []struct {
		name         string
		labels       map[string]string
		wantDeclared bool
		wantNoGPU    bool
		wantHasGPU   bool
	}{
		{
			name:         "no labels at all",
			labels:       nil,
			wantDeclared: false,
			wantNoGPU:    false,
			wantHasGPU:   false,
		},
		{
			name:         "labelled but nothing about GPUs",
			labels:       map[string]string{hardware.LabelNetworkZone: "zone-a"},
			wantDeclared: false,
			wantNoGPU:    false,
			wantHasGPU:   false,
		},
		{
			// The CPU-node labelling from k8s/ml-workloads/node-labels.yaml.
			name: "declared CPU-only",
			labels: map[string]string{
				hardware.LabelGPUVendor: hardware.GPUVendorNone,
				hardware.LabelGPUCount:  "0",
			},
			wantDeclared: true,
			wantNoGPU:    true,
			wantHasGPU:   false,
		},
		{
			name: "declared GPU node",
			labels: map[string]string{
				hardware.LabelGPUVendor: hardware.GPUVendorNvidia,
				hardware.LabelGPUCount:  "8",
			},
			wantDeclared: true,
			wantNoGPU:    false,
			wantHasGPU:   true,
		},
		{
			// A partial labelling still counts as the operator having said
			// something about this node's GPUs.
			name:         "gpu-count only",
			labels:       map[string]string{hardware.LabelGPUCount: "4"},
			wantDeclared: true,
			wantNoGPU:    true, // vendor still defaults to none, so not HasGPU
			wantHasGPU:   false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hw := hardware.ParseNodeHardware(&corev1.Node{
				ObjectMeta: metav1.ObjectMeta{Name: "node", Labels: tc.labels},
			})

			if hw.GPUMetadataDeclared != tc.wantDeclared {
				t.Errorf("GPUMetadataDeclared = %v, want %v", hw.GPUMetadataDeclared, tc.wantDeclared)
			}
			if got := hw.DeclaresNoGPU(); got != tc.wantNoGPU {
				t.Errorf("DeclaresNoGPU() = %v, want %v", got, tc.wantNoGPU)
			}
			if got := hw.HasGPU(); got != tc.wantHasGPU {
				t.Errorf("HasGPU() = %v, want %v", got, tc.wantHasGPU)
			}
		})
	}
}

func TestNodeHardware_TotalVRAMMiB(t *testing.T) {
	hw := hardware.NodeHardware{GPUCount: 8, GPUVRAMMiB: 81920}
	if hw.TotalVRAMMiB() != 655360 {
		t.Errorf("TotalVRAMMiB: got %d, want 655360", hw.TotalVRAMMiB())
	}
}

func TestNodeHardware_IsHighBandwidth(t *testing.T) {
	hw := hardware.NodeHardware{NetworkBandwidthGbps: 100}
	if !hw.IsHighBandwidth(100) {
		t.Error("IsHighBandwidth(100): expected true for 100 Gbps node")
	}
	if hw.IsHighBandwidth(101) {
		t.Error("IsHighBandwidth(101): expected false for 100 Gbps node")
	}
}

func TestNodeHardware_GPUNUMATopology(t *testing.T) {
	hw := hardware.NodeHardware{
		GPUCount:              8,
		NUMANodes:             4,
		GPUNUMADistribution:   []int64{4, 2, 2, 0},
		TopologyManagerPolicy: hardware.TopologyManagerPolicyRestricted,
		TopologyManagerScope:  hardware.TopologyManagerScopePod,
	}

	if !hw.HasValidGPUNUMATopology() {
		t.Fatal("expected GPU NUMA topology to be valid")
	}
	if !hw.EnforcesPodNUMAAlignment() {
		t.Fatal("expected restricted pod-scope policy to enforce alignment")
	}

	domains, fits := hw.MinimumNUMADomainsForGPUs(6)
	if !fits || domains != 2 {
		t.Errorf("MinimumNUMADomainsForGPUs(6) = (%d, %v), want (2, true)", domains, fits)
	}
	if _, fits := hw.MinimumNUMADomainsForGPUs(9); fits {
		t.Fatal("expected nine requested GPUs not to fit an eight-GPU topology")
	}
}

func TestNodeHardware_InvalidGPUNUMATopologyIsRejected(t *testing.T) {
	cases := []struct {
		name string
		node *corev1.Node
	}{
		{
			name: "malformed distribution",
			node: &corev1.Node{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{
				hardware.LabelGPUCount:            "8",
				hardware.LabelNUMANodes:           "2",
				hardware.LabelGPUNUMADistribution: "four.four",
			}}},
		},
		{
			name: "domain count mismatch",
			node: &corev1.Node{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{
				hardware.LabelGPUCount:            "8",
				hardware.LabelNUMANodes:           "4",
				hardware.LabelGPUNUMADistribution: "4.4",
			}}},
		},
		{
			name: "gpu total mismatch",
			node: &corev1.Node{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{
				hardware.LabelGPUCount:            "8",
				hardware.LabelNUMANodes:           "2",
				hardware.LabelGPUNUMADistribution: "4.2",
			}}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if hw := hardware.ParseNodeHardware(tc.node); hw.HasValidGPUNUMATopology() {
				t.Errorf("expected invalid topology, got %v", hw.GPUNUMADistribution)
			}
		})
	}
}

// ── PodHardwareReqs parsing tests ────────────────────────────────────────────

func TestParsePodHardwareReqs_FullAnnotations(t *testing.T) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Annotations: map[string]string{
				hardware.AnnotWorkloadType:     "ml-training",
				hardware.AnnotGPUVendorReq:     "nvidia",
				hardware.AnnotGPUModelReq:      "a100",
				hardware.AnnotGPUVRAMMinMiB:    "40960",
				hardware.AnnotNetworkZoneReq:   "zone-a",
				hardware.AnnotNetworkBWMinGbps: "25",
				hardware.AnnotBinPackWeight:    "1.5",
			},
		},
	}

	reqs := hardware.ParsePodHardwareReqs(pod)

	if reqs.WorkloadType != "ml-training" {
		t.Errorf("WorkloadType: got %q, want ml-training", reqs.WorkloadType)
	}
	if reqs.GPUVendorReq != "nvidia" {
		t.Errorf("GPUVendorReq: got %q, want nvidia", reqs.GPUVendorReq)
	}
	if reqs.GPUVRAMMinMiB != 40960 {
		t.Errorf("GPUVRAMMinMiB: got %d, want 40960", reqs.GPUVRAMMinMiB)
	}
	if reqs.NetworkZoneReq != "zone-a" {
		t.Errorf("NetworkZoneReq: got %q, want zone-a", reqs.NetworkZoneReq)
	}
	if reqs.NetworkBWMinGbps != 25 {
		t.Errorf("NetworkBWMinGbps: got %d, want 25", reqs.NetworkBWMinGbps)
	}
	if reqs.BinPackWeight != 1.5 {
		t.Errorf("BinPackWeight: got %f, want 1.5", reqs.BinPackWeight)
	}
}

func TestParsePodHardwareReqs_Defaults(t *testing.T) {
	pod := &corev1.Pod{}
	reqs := hardware.ParsePodHardwareReqs(pod)

	if reqs.WorkloadType != hardware.WorkloadAPI {
		t.Errorf("WorkloadType default: got %q, want api", reqs.WorkloadType)
	}
	if reqs.BinPackWeight != 1.0 {
		t.Errorf("BinPackWeight default: got %f, want 1.0", reqs.BinPackWeight)
	}
}

func TestParsePodHardwareReqs_BinPackWeightClamping(t *testing.T) {
	cases := []struct {
		name       string
		annotation string
		want       float64
	}{
		{"within range", "1.5", 1.5},
		{"below minimum clamped to 0", "-1", 0.0},
		{"above maximum clamped to 2", "5", 2.0},
		{"zero", "0.0", 0.0},
		{"maximum", "2.0", 2.0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Annotations: map[string]string{
						hardware.AnnotBinPackWeight: tc.annotation,
					},
				},
			}
			reqs := hardware.ParsePodHardwareReqs(pod)
			if reqs.BinPackWeight != tc.want {
				t.Errorf("BinPackWeight for annotation %q: got %f, want %f", tc.annotation, reqs.BinPackWeight, tc.want)
			}
		})
	}
}

func TestParsePodHardwareReqs_GPUCountFromResources(t *testing.T) {
	pod := &corev1.Pod{
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceName("nvidia.com/gpu"): resource.MustParse("1"),
						},
					},
				},
				{
					Resources: corev1.ResourceRequirements{
						Limits: corev1.ResourceList{
							corev1.ResourceName("amd.com/gpu"):      resource.MustParse("2"),
							corev1.ResourceName("example.com/fpga"): resource.MustParse("8"),
						},
					},
				},
			},
			InitContainers: []corev1.Container{
				{
					Resources: corev1.ResourceRequirements{
						Limits: corev1.ResourceList{
							corev1.ResourceName("nvidia.com/gpu"): resource.MustParse("4"),
						},
					},
				},
			},
		},
	}

	reqs := hardware.ParsePodHardwareReqs(pod)
	if reqs.GPUCountReq != 4 {
		t.Errorf("GPUCountReq: got %d, want 4", reqs.GPUCountReq)
	}
	if !reqs.NeedsGPU() {
		t.Fatal("expected GPU resource request to require a GPU")
	}
}

func TestPodHardwareReqs_IsMLWorkload(t *testing.T) {
	cases := []struct {
		workload string
		want     bool
	}{
		{"ml-training", true},
		{"ml-inference", true},
		{"ml-batch", true},
		{"api", false},
		{"db", false},
		{"", false},
	}
	for _, tc := range cases {
		reqs := hardware.PodHardwareReqs{WorkloadType: tc.workload}
		if got := reqs.IsMLWorkload(); got != tc.want {
			t.Errorf("IsMLWorkload() for %q: got %v, want %v", tc.workload, got, tc.want)
		}
	}
}

func TestPodHardwareReqs_NeedsGPU(t *testing.T) {
	cases := []struct {
		name    string
		reqs    hardware.PodHardwareReqs
		wantGPU bool
	}{
		{"explicit nvidia req", hardware.PodHardwareReqs{GPUVendorReq: "nvidia"}, true},
		{"vram req", hardware.PodHardwareReqs{GPUVRAMMinMiB: 40960}, true},
		{"resource req", hardware.PodHardwareReqs{GPUCountReq: 2}, true},
		{"any vendor", hardware.PodHardwareReqs{GPUVendorReq: "any"}, false},
		{"no req", hardware.PodHardwareReqs{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.reqs.NeedsGPU(); got != tc.wantGPU {
				t.Errorf("NeedsGPU() = %v, want %v", got, tc.wantGPU)
			}
		})
	}
}

// ── Invalid label values ──────────────────────────────────────────────────────

func TestParseNodeHardware_InvalidIntLabel_DefaultsToZero(t *testing.T) {
	node := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Labels: map[string]string{
				hardware.LabelGPUCount: "not-a-number",
			},
		},
	}
	hw := hardware.ParseNodeHardware(node)
	if hw.GPUCount != 0 {
		t.Errorf("Invalid LabelGPUCount: got %d, want 0", hw.GPUCount)
	}
}

func TestParsePodHardwareReqs_InvalidBinPackWeight_DefaultsTo1(t *testing.T) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Annotations: map[string]string{
				hardware.AnnotBinPackWeight: "invalid",
			},
		},
	}
	reqs := hardware.ParsePodHardwareReqs(pod)
	if reqs.BinPackWeight != 1.0 {
		t.Errorf("Invalid BinPackWeight: got %f, want 1.0", reqs.BinPackWeight)
	}
}

// ── Accelerator resource predicate (Issue #331) ──────────────────────────────

func TestIsAcceleratorResource(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"nvidia.com/gpu", true},
		{"amd.com/gpu", true},
		{"intel.com/gpu", true},
		{"google.com/tpu", true},
		{"gpu", true},
		{"tpu", true},
		{"gpu.example.com", true},
		{"NVIDIA.COM/GPU", true}, // case-insensitive
		{"example.com/fpga", false},
		{"memory", false},
		{"cpu", false},
		{"ephemeral-storage", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := hardware.IsAcceleratorResource(corev1.ResourceName(tc.name)); got != tc.want {
			t.Errorf("IsAcceleratorResource(%q) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestParsePodHardwareReqs_TPUResourceRequestIsCounted(t *testing.T) {
	// google.com/tpu is an accelerator resource: a TPU pod must produce a
	// non-zero GPUCountReq so preemption and NUMA scoring treat it like any
	// other accelerator workload. This regressed when the accelerator
	// predicate only matched "*/gpu" resources.
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "tpu-job",
			Namespace: "default",
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name: "worker",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceName("google.com/tpu"): resource.MustParse("4"),
						},
					},
				},
			},
		},
	}

	reqs := hardware.ParsePodHardwareReqs(pod)
	if reqs.GPUCountReq != 4 {
		t.Errorf("TPU pod GPUCountReq: got %d, want 4", reqs.GPUCountReq)
	}
	if !reqs.NeedsGPU() {
		t.Fatal("expected TPU resource request to require an accelerator")
	}
}

func TestParsePodHardwareReqs_BareGPUResourceIsCounted(t *testing.T) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "gpu-job",
			Namespace: "default",
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name: "worker",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceName("gpu"): resource.MustParse("8"),
						},
					},
				},
			},
		},
	}

	reqs := hardware.ParsePodHardwareReqs(pod)
	if reqs.GPUCountReq != 8 {
		t.Errorf("bare gpu resource GPUCountReq: got %d, want 8", reqs.GPUCountReq)
	}
}
