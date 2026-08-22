// Package plugins implements the GreenPay ML-aware Kubernetes scheduler
// plugins.  Each plugin registers itself into the Kubernetes Scheduling
// Framework via the plugin factory pattern.
//
// Filter plugin: GPUHardwareFilter
// ─────────────────────────────────
// Hard-constraint stage.  A node fails the filter if ANY of the following is
// true:
//
//  1. Pod requires a specific GPU vendor and the node's vendor does not match.
//  2. Pod requires a specific GPU model and the node's model does not match.
//  3. Pod requires a minimum per-GPU VRAM and the node has less.
//  4. Pod requires a specific network zone and the node is in a different zone.
//  5. Pod requires a minimum network bandwidth and the node provides less.
//
// Nodes that pass all five checks advance to the scoring stage.
package plugins

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/klog/v2"
	"k8s.io/kubernetes/pkg/scheduler/framework"

	"github.com/greenpay/scheduler/pkg/hardware"
)

// GPUHardwareFilterName is the unique name registered in the scheduler
// framework.  Must match the name used in KubeSchedulerProfile.
const GPUHardwareFilterName = "GPUHardwareFilter"

// GPUHardwareFilter implements framework.FilterPlugin.
type GPUHardwareFilter struct{}

// Compile-time interface assertion.
var _ framework.FilterPlugin = &GPUHardwareFilter{}

// Name returns the plugin name.
func (f *GPUHardwareFilter) Name() string { return GPUHardwareFilterName }

// NewGPUHardwareFilter is the plugin factory registered with the scheduler.
func NewGPUHardwareFilter(_ context.Context, _ runtime.Object, _ framework.Handle) (framework.Plugin, error) {
	return &GPUHardwareFilter{}, nil
}

// Filter is called once per candidate node during the filtering phase.
// It returns framework.NewStatus(framework.Unschedulable, reason) when the
// node does not meet the pod's hardware requirements.
func (f *GPUHardwareFilter) Filter(
	ctx context.Context,
	state *framework.CycleState,
	pod *corev1.Pod,
	nodeInfo *framework.NodeInfo,
) *framework.Status {
	node := nodeInfo.Node()
	if node == nil {
		return framework.NewStatus(framework.Error, "node info missing node object")
	}

	reqs := hardware.ParsePodHardwareReqs(pod)
	hw := hardware.ParseNodeHardware(node)

	logger := klog.FromContext(ctx)

	// ── 1. GPU vendor check ──────────────────────────────────────────────────
	if reqs.GPUVendorReq != "" &&
		reqs.GPUVendorReq != hardware.GPUVendorAny &&
		reqs.GPUVendorReq != hardware.GPUVendorNone {
		if hw.GPUVendor != reqs.GPUVendorReq {
			reason := fmt.Sprintf(
				"node %s has GPU vendor %q; pod requires %q",
				node.Name, hw.GPUVendor, reqs.GPUVendorReq,
			)
			logger.V(4).Info("FilterPlugin: vendor mismatch", "pod", klog.KObj(pod), "node", node.Name, "reason", reason)
			return framework.NewStatus(framework.Unschedulable, reason)
		}
	}

	// ── 2. GPU model check ───────────────────────────────────────────────────
	if reqs.GPUModelReq != "" && reqs.GPUModelReq != hardware.GPUVendorAny {
		if hw.GPUModel != reqs.GPUModelReq {
			reason := fmt.Sprintf(
				"node %s has GPU model %q; pod requires %q",
				node.Name, hw.GPUModel, reqs.GPUModelReq,
			)
			logger.V(4).Info("FilterPlugin: model mismatch", "pod", klog.KObj(pod), "node", node.Name, "reason", reason)
			return framework.NewStatus(framework.Unschedulable, reason)
		}
	}

	// ── 3. VRAM floor check ──────────────────────────────────────────────────
	if reqs.GPUVRAMMinMiB > 0 {
		if hw.GPUVRAMMiB < reqs.GPUVRAMMinMiB {
			reason := fmt.Sprintf(
				"node %s has %d MiB VRAM per GPU; pod requires at least %d MiB",
				node.Name, hw.GPUVRAMMiB, reqs.GPUVRAMMinMiB,
			)
			logger.V(4).Info("FilterPlugin: VRAM too low", "pod", klog.KObj(pod), "node", node.Name, "reason", reason)
			return framework.NewStatus(framework.Unschedulable, reason)
		}
		// Also ensure the node actually HAS a GPU when VRAM is required
		if !hw.HasGPU() {
			reason := fmt.Sprintf("node %s has no GPU but pod requires %d MiB VRAM", node.Name, reqs.GPUVRAMMinMiB)
			logger.V(4).Info("FilterPlugin: no GPU on node", "pod", klog.KObj(pod), "node", node.Name)
			return framework.NewStatus(framework.Unschedulable, reason)
		}
	}

	// ── 4. Network zone check ────────────────────────────────────────────────
	if reqs.NetworkZoneReq != "" && hw.NetworkZone != "" {
		if hw.NetworkZone != reqs.NetworkZoneReq {
			reason := fmt.Sprintf(
				"node %s is in network zone %q; pod requires zone %q",
				node.Name, hw.NetworkZone, reqs.NetworkZoneReq,
			)
			logger.V(4).Info("FilterPlugin: zone mismatch", "pod", klog.KObj(pod), "node", node.Name, "reason", reason)
			return framework.NewStatus(framework.Unschedulable, reason)
		}
	}

	// ── 5. Network bandwidth floor check ────────────────────────────────────
	if reqs.NetworkBWMinGbps > 0 && hw.NetworkBandwidthGbps > 0 {
		if hw.NetworkBandwidthGbps < reqs.NetworkBWMinGbps {
			reason := fmt.Sprintf(
				"node %s has %d Gbps network; pod requires at least %d Gbps",
				node.Name, hw.NetworkBandwidthGbps, reqs.NetworkBWMinGbps,
			)
			logger.V(4).Info("FilterPlugin: bandwidth too low", "pod", klog.KObj(pod), "node", node.Name, "reason", reason)
			return framework.NewStatus(framework.Unschedulable, reason)
		}
	}

	// ── 6. GPU capacity check ────────────────────────────────────────────────
	if podRequiresGPU(pod, reqs) {
		totalGPUs, _, freeGPUs := computeGPUCapacity(nodeInfo, hw)
		if totalGPUs > 0 && freeGPUs <= 0 {
			reason := fmt.Sprintf("node %s has 0 of %d GPUs free", node.Name, totalGPUs)
			logger.V(4).Info("FilterPlugin: no free GPUs", "pod", klog.KObj(pod), "node", node.Name, "reason", reason)
			return framework.NewStatus(framework.Unschedulable, reason)
		}
	}

	logger.V(5).Info("FilterPlugin: node passes all hardware checks", "pod", klog.KObj(pod), "node", node.Name)
	return framework.NewStatus(framework.Success)
}

func isGPUResource(name string) bool {
	switch corev1.ResourceName(name) {
	case "nvidia.com/gpu", "amd.com/gpu", "google.com/tpu", "intel.com/gpu", "gpu":
		return true
	}
	return false
}

func computeGPUCapacity(nodeInfo *framework.NodeInfo, hw hardware.NodeHardware) (totalGPUs int64, allocatedGPUs int64, freeGPUs int64) {
	totalGPUs = hw.GPUCount

	if node := nodeInfo.Node(); node != nil && totalGPUs == 0 {
		for resName, quant := range node.Status.Allocatable {
			if isGPUResource(string(resName)) {
				totalGPUs += quant.Value()
			}
		}
	}

	if nodeInfo.Allocatable != nil {
		var scalarTotal int64
		for resName, val := range nodeInfo.Allocatable.ScalarResources {
			if isGPUResource(string(resName)) {
				scalarTotal += val
			}
		}
		if scalarTotal > 0 && (totalGPUs == 0 || scalarTotal > totalGPUs) {
			totalGPUs = scalarTotal
		}
	}

	if nodeInfo.Requested != nil {
		for resName, val := range nodeInfo.Requested.ScalarResources {
			if isGPUResource(string(resName)) {
				allocatedGPUs += val
			}
		}
	}

	freeGPUs = totalGPUs - allocatedGPUs
	if freeGPUs < 0 {
		freeGPUs = 0
	}
	return totalGPUs, allocatedGPUs, freeGPUs
}

func podRequiresGPU(pod *corev1.Pod, reqs hardware.PodHardwareReqs) bool {
	annots := pod.Annotations
	if annots != nil {
		if vendor, ok := annots[hardware.AnnotGPUVendorReq]; ok && vendor != "" && vendor != hardware.GPUVendorNone {
			return true
		}
		if model, ok := annots[hardware.AnnotGPUModelReq]; ok && model != "" {
			return true
		}
		if vram, ok := annots[hardware.AnnotGPUVRAMMinMiB]; ok && vram != "" && reqs.GPUVRAMMinMiB > 0 {
			return true
		}
	}
	for _, c := range pod.Spec.Containers {
		for resName, quant := range c.Resources.Requests {
			if isGPUResource(string(resName)) && quant.Value() > 0 {
				return true
			}
		}
	}
	for _, c := range pod.Spec.InitContainers {
		for resName, quant := range c.Resources.Requests {
			if isGPUResource(string(resName)) && quant.Value() > 0 {
				return true
			}
		}
	}
	return false
}
