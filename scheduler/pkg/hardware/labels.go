// Package hardware defines the canonical node and pod label/annotation keys
// used by the GreenPay ML scheduler plugin to communicate hardware topology
// and workload requirements between the cluster operator and the scheduler.
//
// Label taxonomy
// ──────────────
// Node labels (applied by the cluster operator or node-feature-discovery):
//
//	greenpay.io/gpu-vendor          = nvidia | amd | google (TPU) | none
//	greenpay.io/gpu-model           = a100 | h100 | v100 | t4 | l4 | tpu-v4 | ...
//	greenpay.io/gpu-count           = "8"         (integer string)
//	greenpay.io/gpu-vram-mib        = "81920"     (MiB per GPU)
//	greenpay.io/gpu-interconnect    = nvlink | pcie | none
//	greenpay.io/numa-nodes          = "2"         (NUMA domains on the node)
//	greenpay.io/network-zone        = zone-a | zone-b | ...
//	greenpay.io/network-bandwidth   = "100"       (Gbps)
//	greenpay.io/node-tier           = gpu-high | gpu-low | cpu-high | cpu-standard
//
// Pod annotations (set by workload authors):
//
//	greenpay.io/workload-type       = ml-training | ml-inference | ml-batch | api | db
//	greenpay.io/gpu-vendor-req      = nvidia | amd | google | any
//	greenpay.io/gpu-model-req       = a100 | h100 | any
//	greenpay.io/gpu-vram-min-mib    = "40960"     (minimum VRAM required, MiB)
//	greenpay.io/network-zone-req    = zone-a       (empty = no preference)
//	greenpay.io/network-bw-min-gbps = "25"         (minimum network bandwidth)
//	greenpay.io/bin-pack-weight     = "1.0"        (score weight multiplier 0–2)
package hardware

// ── Node label keys ──────────────────────────────────────────────────────────

const (
	// LabelGPUVendor identifies the GPU vendor on a node.
	// Values: "nvidia", "amd", "google", "none"
	LabelGPUVendor = "greenpay.io/gpu-vendor"

	// LabelGPUModel identifies the specific GPU model.
	// Values: "a100", "h100", "v100", "t4", "l4", "tpu-v4", etc.
	LabelGPUModel = "greenpay.io/gpu-model"

	// LabelGPUCount is the number of GPUs on the node (string-encoded integer).
	LabelGPUCount = "greenpay.io/gpu-count"

	// LabelGPUVRAMMiB is the per-GPU VRAM in MiB (string-encoded integer).
	LabelGPUVRAMMiB = "greenpay.io/gpu-vram-mib"

	// LabelGPUInterconnect describes how GPUs are connected.
	// Values: "nvlink", "pcie", "none"
	LabelGPUInterconnect = "greenpay.io/gpu-interconnect"

	// LabelNUMANodes is the number of NUMA domains on the node.
	LabelNUMANodes = "greenpay.io/numa-nodes"

	// LabelGPUNUMADistribution is a dot-separated GPU count for each NUMA
	// domain in ascending domain-ID order. Example: "4.4" means four GPUs on
	// NUMA domain 0 and four on NUMA domain 1.
	LabelGPUNUMADistribution = "greenpay.io/gpu-numa-distribution"

	// LabelTopologyManagerPolicy mirrors the kubelet Topology Manager policy
	// verified by the cluster operator.
	LabelTopologyManagerPolicy = "greenpay.io/topology-manager-policy"

	// LabelTopologyManagerScope mirrors the kubelet Topology Manager scope
	// verified by the cluster operator.
	LabelTopologyManagerScope = "greenpay.io/topology-manager-scope"

	// LabelNetworkZone is the availability zone / rack for topology-aware scheduling.
	LabelNetworkZone = "greenpay.io/network-zone"

	// LabelNetworkBandwidthGbps is the node's uplink bandwidth in Gbps.
	LabelNetworkBandwidthGbps = "greenpay.io/network-bandwidth"

	// LabelNodeTier is a human-readable tier for operator convenience.
	// Values: "gpu-high", "gpu-low", "cpu-high", "cpu-standard"
	LabelNodeTier = "greenpay.io/node-tier"
)

// ── Pod annotation keys ──────────────────────────────────────────────────────

const (
	// AnnotWorkloadType classifies the pod for routing to the right scoring path.
	// Values: "ml-training", "ml-inference", "ml-batch", "api", "db"
	AnnotWorkloadType = "greenpay.io/workload-type"

	// AnnotGPUVendorReq is the required GPU vendor.
	// "any" disables vendor filtering.
	AnnotGPUVendorReq = "greenpay.io/gpu-vendor-req"

	// AnnotGPUModelReq is the required GPU model.
	// "any" disables model filtering.
	AnnotGPUModelReq = "greenpay.io/gpu-model-req"

	// AnnotGPUVRAMMinMiB is the minimum per-GPU VRAM in MiB.
	// Pods with this annotation are hard-filtered off nodes with less VRAM.
	AnnotGPUVRAMMinMiB = "greenpay.io/gpu-vram-min-mib"

	// AnnotNetworkZoneReq pins the pod to a specific network zone.
	// Empty string means no zone preference.
	AnnotNetworkZoneReq = "greenpay.io/network-zone-req"

	// AnnotNetworkBWMinGbps is the minimum required network bandwidth in Gbps.
	AnnotNetworkBWMinGbps = "greenpay.io/network-bw-min-gbps"

	// AnnotBinPackWeight is a multiplier (0–2) applied to the bin-packing score
	// for this pod.  Defaults to 1.0.  Use > 1 to aggressively consolidate,
	// < 1 to spread the workload.
	AnnotBinPackWeight = "greenpay.io/bin-pack-weight"
)

// ── Workload type constants ──────────────────────────────────────────────────

const (
	WorkloadMLTraining  = "ml-training"
	WorkloadMLInference = "ml-inference"
	WorkloadMLBatch     = "ml-batch"
	WorkloadAPI         = "api"
	WorkloadDB          = "db"
)

// ── GPU vendor constants ─────────────────────────────────────────────────────

const (
	GPUVendorNvidia = "nvidia"
	GPUVendorAMD    = "amd"
	GPUVendorGoogle = "google"
	GPUVendorNone   = "none"
	GPUVendorAny    = "any"
)

// ── Topology Manager constants ──────────────────────────────────────────────

const (
	TopologyManagerPolicyNone           = "none"
	TopologyManagerPolicyBestEffort     = "best-effort"
	TopologyManagerPolicyRestricted     = "restricted"
	TopologyManagerPolicySingleNUMANode = "single-numa-node"

	TopologyManagerScopeContainer = "container"
	TopologyManagerScopePod       = "pod"
)

// ── Node tier constants ──────────────────────────────────────────────────────

const (
	NodeTierGPUHigh     = "gpu-high"
	NodeTierGPULow      = "gpu-low"
	NodeTierCPUHigh     = "cpu-high"
	NodeTierCPUStandard = "cpu-standard"
)
