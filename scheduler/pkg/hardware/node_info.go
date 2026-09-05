package hardware

import (
	"sort"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/klog/v2"
)

// NodeHardware holds the parsed hardware profile for a single Kubernetes node,
// extracted from the node's labels.  All integer fields default to 0 when the
// corresponding label is absent or unparseable.
type NodeHardware struct {
	// GPUVendor is the GPU vendor string (e.g. "nvidia", "amd", "google", "none").
	GPUVendor string
	// GPUModel is the specific model string (e.g. "a100", "h100", "t4").
	GPUModel string
	// GPUCount is the number of physical GPUs on the node.
	GPUCount int64
	// GPUVRAMMiB is the per-GPU VRAM in MiB.
	GPUVRAMMiB int64
	// GPUInterconnect describes the GPU interconnect fabric ("nvlink", "pcie", "none").
	GPUInterconnect string
	// GPUMetadataDeclared reports whether the operator has characterised the
	// node's GPU situation at all, i.e. whether greenpay.io/gpu-vendor or
	// greenpay.io/gpu-count is present on the node.
	//
	// The parsed values alone cannot answer that: an absent gpu-vendor label
	// defaults to GPUVendorNone, so a node deliberately labelled CPU-only
	// (gpu-vendor=none, gpu-count=0) parses identically to a node nobody has
	// ever labelled.  Scoring has to tell the two apart — the first is a
	// declaration, the second is missing metadata.
	GPUMetadataDeclared bool
	// NUMANodes is the number of NUMA domains.
	NUMANodes int64
	// GPUNUMADistribution lists GPU counts by ascending NUMA domain ID.
	GPUNUMADistribution []int64
	// TopologyManagerPolicy is the operator-verified kubelet policy.
	TopologyManagerPolicy string
	// TopologyManagerScope is the operator-verified kubelet scope.
	TopologyManagerScope string
	// NetworkZone is the availability zone / rack label.
	NetworkZone string
	// NetworkBandwidthGbps is the uplink bandwidth in Gbps.
	NetworkBandwidthGbps int64
	// NodeTier is the operator-assigned tier string.
	NodeTier string
}

// ParseNodeHardware extracts the hardware profile from a node's label set.
// Unknown or missing labels are silently defaulted to zero values.
func ParseNodeHardware(node *corev1.Node) NodeHardware {
	labels := node.Labels
	if labels == nil {
		labels = map[string]string{}
	}

	return NodeHardware{
		GPUVendor:           labelStr(labels, LabelGPUVendor, GPUVendorNone),
		GPUModel:            labelStr(labels, LabelGPUModel, ""),
		GPUCount:            labelInt(labels, LabelGPUCount),
		GPUVRAMMiB:          labelInt(labels, LabelGPUVRAMMiB),
		GPUInterconnect:     labelStr(labels, LabelGPUInterconnect, "none"),
		GPUMetadataDeclared: labelPresent(labels, LabelGPUVendor) || labelPresent(labels, LabelGPUCount),
		NUMANodes:           labelInt(labels, LabelNUMANodes),
		GPUNUMADistribution: labelIntList(labels, LabelGPUNUMADistribution),
		TopologyManagerPolicy: labelStr(
			labels,
			LabelTopologyManagerPolicy,
			TopologyManagerPolicyNone,
		),
		TopologyManagerScope: labelStr(
			labels,
			LabelTopologyManagerScope,
			TopologyManagerScopeContainer,
		),
		NetworkZone:          labelStr(labels, LabelNetworkZone, ""),
		NetworkBandwidthGbps: labelInt(labels, LabelNetworkBandwidthGbps),
		NodeTier:             labelStr(labels, LabelNodeTier, NodeTierCPUStandard),
	}
}

// HasGPU returns true when the node has at least one GPU.
func (n NodeHardware) HasGPU() bool {
	return n.GPUCount > 0 && n.GPUVendor != GPUVendorNone && n.GPUVendor != ""
}

// DeclaresNoGPU returns true when the operator has explicitly characterised
// the node as having no GPU — the gpu-vendor/gpu-count labels are present and
// report no accelerator — as opposed to the node never having been labelled.
//
// Callers that treat a GPU dimension as not applying to a node must gate on
// this rather than on !HasGPU(), which is equally true of an unlabelled node
// the scheduler simply knows nothing about.
func (n NodeHardware) DeclaresNoGPU() bool {
	return n.GPUMetadataDeclared && !n.HasGPU()
}

// TotalVRAMMiB returns the total VRAM across all GPUs on the node.
func (n NodeHardware) TotalVRAMMiB() int64 {
	return n.GPUCount * n.GPUVRAMMiB
}

// IsHighBandwidth returns true when the network uplink is >= thresholdGbps.
func (n NodeHardware) IsHighBandwidth(thresholdGbps int64) bool {
	return n.NetworkBandwidthGbps >= thresholdGbps
}

// HasValidGPUNUMATopology reports whether the distribution agrees with the
// node's declared NUMA-domain and physical-GPU counts.
func (n NodeHardware) HasValidGPUNUMATopology() bool {
	if n.NUMANodes <= 0 ||
		n.GPUCount <= 0 ||
		int64(len(n.GPUNUMADistribution)) != n.NUMANodes {
		return false
	}

	var total int64
	for _, count := range n.GPUNUMADistribution {
		if count < 0 || count > n.GPUCount-total {
			return false
		}
		total += count
	}
	return total == n.GPUCount
}

// EnforcesPodNUMAAlignment reports whether the operator-declared kubelet
// configuration guarantees pod-scope topology admission.
func (n NodeHardware) EnforcesPodNUMAAlignment() bool {
	if n.TopologyManagerScope != TopologyManagerScopePod {
		return false
	}

	return n.TopologyManagerPolicy == TopologyManagerPolicyRestricted ||
		n.TopologyManagerPolicy == TopologyManagerPolicySingleNUMANode
}

// MinimumNUMADomainsForGPUs returns the fewest NUMA domains that can supply
// the requested physical GPU count using the declared distribution.
func (n NodeHardware) MinimumNUMADomainsForGPUs(requested int64) (int64, bool) {
	if requested <= 0 || !n.HasValidGPUNUMATopology() {
		return 0, false
	}

	counts := append([]int64(nil), n.GPUNUMADistribution...)
	sort.Slice(counts, func(i, j int) bool {
		return counts[i] > counts[j]
	})

	var available int64
	for i, count := range counts {
		available += count
		if available >= requested {
			return int64(i + 1), true
		}
	}
	return 0, false
}

// ── Pod requirement parsing ──────────────────────────────────────────────────

// PodHardwareReqs holds the parsed hardware requirements extracted from a
// pod's annotations.
type PodHardwareReqs struct {
	// WorkloadType is the classified workload category.
	WorkloadType string
	// GPUVendorReq is the required GPU vendor ("any" = no preference).
	GPUVendorReq string
	// GPUModelReq is the required GPU model ("any" = no preference).
	GPUModelReq string
	// GPUVRAMMinMiB is the minimum per-GPU VRAM required.  0 = no requirement.
	GPUVRAMMinMiB int64
	// GPUCountReq is the effective physical GPU request from pod resources.
	GPUCountReq int64
	// NetworkZoneReq pins to a specific zone ("" = no preference).
	NetworkZoneReq string
	// NetworkBWMinGbps is the minimum required network bandwidth.  0 = any.
	NetworkBWMinGbps int64
	// BinPackWeight is the bin-packing score weight multiplier.  Defaults to 1.0.
	BinPackWeight float64
}

// ParsePodHardwareReqs extracts hardware requirements from pod annotations.
func ParsePodHardwareReqs(pod *corev1.Pod) PodHardwareReqs {
	annots := pod.Annotations
	if annots == nil {
		annots = map[string]string{}
	}

	weight := 1.0
	if s, ok := annots[AnnotBinPackWeight]; ok {
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			if f < 0 {
				klog.Warningf("Pod %s/%s requested BinPackWeight %v, clamping to minimum 0", pod.Namespace, pod.Name, f)
				weight = 0
			} else if f > 2 {
				klog.Warningf("Pod %s/%s requested BinPackWeight %v, clamping to maximum 2", pod.Namespace, pod.Name, f)
				weight = 2.0
			} else {
				weight = f
			}
		}
	}

	return PodHardwareReqs{
		WorkloadType:     annotStr(annots, AnnotWorkloadType, WorkloadAPI),
		GPUVendorReq:     annotStr(annots, AnnotGPUVendorReq, GPUVendorAny),
		GPUModelReq:      annotStr(annots, AnnotGPUModelReq, GPUVendorAny),
		GPUVRAMMinMiB:    annotInt(annots, AnnotGPUVRAMMinMiB),
		GPUCountReq:      podGPURequest(pod),
		NetworkZoneReq:   annotStr(annots, AnnotNetworkZoneReq, ""),
		NetworkBWMinGbps: annotInt(annots, AnnotNetworkBWMinGbps),
		BinPackWeight:    weight,
	}
}

// IsMLWorkload returns true when the pod is any ML workload class.
func (r PodHardwareReqs) IsMLWorkload() bool {
	switch r.WorkloadType {
	case WorkloadMLTraining, WorkloadMLInference, WorkloadMLBatch:
		return true
	}
	return false
}

// NeedsGPU returns true when the pod requires a GPU through resources,
// annotations, or a minimum VRAM floor.
func (r PodHardwareReqs) NeedsGPU() bool {
	if r.GPUCountReq > 0 {
		return true
	}
	if r.GPUVendorReq != "" && r.GPUVendorReq != GPUVendorNone && r.GPUVendorReq != GPUVendorAny {
		return true
	}
	return r.GPUVRAMMinMiB > 0
}

// ── helpers ──────────────────────────────────────────────────────────────────

func labelStr(labels map[string]string, key, defaultVal string) string {
	if v, ok := labels[key]; ok && v != "" {
		return v
	}
	return defaultVal
}

// labelPresent reports whether a label carries a non-empty value.  Presence is
// distinct from the parsed value: labelStr substitutes a default for an absent
// label, which makes "operator declared this" and "nobody has labelled this"
// indistinguishable downstream unless presence is captured here.
func labelPresent(labels map[string]string, key string) bool {
	v, ok := labels[key]
	return ok && v != ""
}

func labelInt(labels map[string]string, key string) int64 {
	if v, ok := labels[key]; ok {
		if i, err := strconv.ParseInt(v, 10, 64); err == nil {
			return i
		}
	}
	return 0
}

func labelIntList(labels map[string]string, key string) []int64 {
	value, ok := labels[key]
	if !ok || value == "" {
		return nil
	}

	parts := strings.Split(value, ".")
	counts := make([]int64, len(parts))
	for i, part := range parts {
		count, err := strconv.ParseInt(part, 10, 64)
		if err != nil || count < 0 {
			return nil
		}
		counts[i] = count
	}
	return counts
}

func annotStr(annots map[string]string, key, defaultVal string) string {
	if v, ok := annots[key]; ok && v != "" {
		return v
	}
	return defaultVal
}

func annotInt(annots map[string]string, key string) int64 {
	if v, ok := annots[key]; ok {
		if i, err := strconv.ParseInt(v, 10, 64); err == nil {
			return i
		}
	}
	return 0
}

func podGPURequest(pod *corev1.Pod) int64 {
	var appContainers int64
	for _, container := range pod.Spec.Containers {
		appContainers += containerGPURequest(container)
	}

	var largestInitContainer int64
	for _, container := range pod.Spec.InitContainers {
		requested := containerGPURequest(container)
		if requested > largestInitContainer {
			largestInitContainer = requested
		}
	}

	if largestInitContainer > appContainers {
		return largestInitContainer
	}
	return appContainers
}

func containerGPURequest(container corev1.Container) int64 {
	counts := make(map[corev1.ResourceName]int64)

	for name, quantity := range container.Resources.Requests {
		if IsAcceleratorResource(name) {
			counts[name] = quantity.Value()
		}
	}
	for name, quantity := range container.Resources.Limits {
		if IsAcceleratorResource(name) && quantity.Value() > counts[name] {
			counts[name] = quantity.Value()
		}
	}

	// Sum across the accelerator resources requested by this container. A
	// real workload requests exactly one accelerator class (GPUs or TPUs),
	// so the sum equals that class's count; counting per-vendor classes
	// separately would be meaningless for the capacity checks that consume
	// GPUCountReq.
	var total int64
	for _, count := range counts {
		total += count
	}
	return total
}

// IsAcceleratorResource reports whether the resource name identifies a GPU
// or TPU accelerator that the scheduler accounts for when computing pod
// accelerator counts and node capacity.
//
// This is the single source of truth for accelerator resource names, shared
// by pkg/plugins and pkg/hardware. Keeping a single predicate prevents the
// two packages from drifting apart (the old duplicate in pkg/plugins matched
// `google.com/tpu` while this one did not, silently zeroing TPU pods'
// GPUCountReq and disabling NUMA locality scoring for exactly the workloads
// it exists for).
func IsAcceleratorResource(name corev1.ResourceName) bool {
	resourceName := strings.ToLower(string(name))
	return strings.HasSuffix(resourceName, "/gpu") ||
		strings.HasSuffix(resourceName, "/tpu") ||
		strings.HasPrefix(resourceName, "gpu.") ||
		resourceName == "gpu" ||
		resourceName == "tpu"
}
