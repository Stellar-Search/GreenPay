package plugins

import (
	"context"
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/klog/v2"
	"k8s.io/kubernetes/pkg/scheduler/framework"

	"github.com/greenpay/scheduler/pkg/hardware"
)

// MLWorkloadPreemptionName is the unique plugin name.
const MLWorkloadPreemptionName = "MLWorkloadPreemption"

// MLWorkloadPreemption implements framework.PostFilterPlugin.
type MLWorkloadPreemption struct {
	handle framework.Handle
}

// Compile-time interface assertion.
var _ framework.PostFilterPlugin = &MLWorkloadPreemption{}

// Name returns the plugin name.
func (p *MLWorkloadPreemption) Name() string { return MLWorkloadPreemptionName }

// NewMLWorkloadPreemption is the plugin factory.
func NewMLWorkloadPreemption(_ context.Context, _ runtime.Object, handle framework.Handle) (framework.Plugin, error) {
	return &MLWorkloadPreemption{handle: handle}, nil
}

// GetPodPriority returns the integer priority for a pod.
func GetPodPriority(pod *corev1.Pod) int32 {
	if pod.Spec.Priority != nil {
		return *pod.Spec.Priority
	}
	reqs := hardware.ParsePodHardwareReqs(pod)
	switch reqs.WorkloadType {
	case hardware.WorkloadMLTraining:
		return 1000
	case hardware.WorkloadMLInference:
		return 500
	case hardware.WorkloadMLBatch:
		return 300
	case hardware.WorkloadAPI, hardware.WorkloadDB:
		return 100
	default:
		return 0
	}
}

// GetPodRequestedVRAM returns the per-pod required VRAM in MiB.
func GetPodRequestedVRAM(pod *corev1.Pod) int64 {
	reqs := hardware.ParsePodHardwareReqs(pod)
	return reqs.GPUVRAMMinMiB
}

// GetPodRequestedGPUCount returns the number of GPUs requested by a pod.
func GetPodRequestedGPUCount(pod *corev1.Pod) int64 {
	if pod.Annotations != nil {
		if val, ok := pod.Annotations[hardware.LabelGPUCount]; ok {
			var count int64
			if _, err := fmt.Sscanf(val, "%d", &count); err == nil && count > 0 {
				return count
			}
		}
	}
	reqs := hardware.ParsePodHardwareReqs(pod)
	if reqs.NeedsGPU() {
		return 1
	}
	return 0
}

// PostFilter selects preemption victims on candidate nodes when a pod fails filtering.
func (p *MLWorkloadPreemption) PostFilter(
	ctx context.Context,
	state *framework.CycleState,
	pod *corev1.Pod,
	filteredNodeStatusMap framework.NodeToStatusMap,
) (*framework.PostFilterResult, *framework.Status) {
	logger := klog.FromContext(ctx)
	logger.V(4).Info("MLWorkloadPreemption: running PostFilter", "pod", klog.KObj(pod))

	if p.handle == nil || p.handle.SnapshotSharedLister() == nil {
		return nil, framework.NewStatus(framework.Unschedulable, "scheduler handle or snapshot unavailable")
	}

	nodeInfos, err := p.handle.SnapshotSharedLister().NodeInfos().List()
	if err != nil || len(nodeInfos) == 0 {
		return nil, framework.NewStatus(framework.Unschedulable, "no nodes available in snapshot")
	}

	preemptorPriority := GetPodPriority(pod)
	reqs := hardware.ParsePodHardwareReqs(pod)
	targetVRAM := reqs.GPUVRAMMinMiB
	targetGPUs := GetPodRequestedGPUCount(pod)

	var pdbs []*policyv1.PodDisruptionBudget
	if p.handle != nil && p.handle.SharedInformerFactory() != nil {
		factory := p.handle.SharedInformerFactory()
		if factory.Policy() != nil && factory.Policy().V1() != nil && factory.Policy().V1().PodDisruptionBudgets() != nil {
			pdbLister := factory.Policy().V1().PodDisruptionBudgets().Lister()
			if pdbLister != nil {
				if list, err := pdbLister.List(labels.Everything()); err == nil {
					pdbs = list
				}
			}
		}
	}

	var bestNode string
	minVictimCount := int(^uint(0) >> 1)

	filterPlugin := &GPUHardwareFilter{}

	for _, nodeInfo := range nodeInfos {
		node := nodeInfo.Node()
		if node == nil {
			continue
		}

		// 1. Check if node passes basic hardware constraints
		filterStatus := filterPlugin.Filter(ctx, state, pod, nodeInfo)
		if filterStatus != nil && filterStatus.Code() == framework.Unschedulable {
			if isImmutableHardwareMismatch(filterStatus.Message()) {
				logger.V(4).Info("MLWorkloadPreemption: node immutable hardware mismatch", "node", node.Name, "reason", filterStatus.Message())
				continue
			}
		}

		// 2. Find lower-priority victim pods on this node
		var candidateVictims []*framework.PodInfo
		for _, pInfo := range nodeInfo.Pods {
			if pInfo == nil || pInfo.Pod == nil {
				continue
			}
			victimPod := pInfo.Pod
			if GetPodPriority(victimPod) < preemptorPriority {
				candidateVictims = append(candidateVictims, pInfo)
			}
		}

		if len(candidateVictims) == 0 {
			continue
		}

		// Sort candidate victims: lowest priority first
		sort.Slice(candidateVictims, func(i, j int) bool {
			pi := GetPodPriority(candidateVictims[i].Pod)
			pj := GetPodPriority(candidateVictims[j].Pod)
			if pi != pj {
				return pi < pj
			}
			return candidateVictims[i].Pod.Name < candidateVictims[j].Pod.Name
		})

		// 3. Select victims required to meet GPU/VRAM demands
		var selectedVictims []*corev1.Pod
		var freedVRAM int64
		var freedGPUs int64

		for _, vInfo := range candidateVictims {
			vPod := vInfo.Pod

			if IsPDBViolated(vPod, pdbs) {
				logger.V(4).Info("MLWorkloadPreemption: skipping victim due to PDB protection", "victim", klog.KObj(vPod), "node", node.Name)
				continue
			}

			selectedVictims = append(selectedVictims, vPod)
			freedVRAM += GetPodRequestedVRAM(vPod)
			freedGPUs += GetPodRequestedGPUCount(vPod)

			if (targetVRAM == 0 || freedVRAM >= targetVRAM) && (targetGPUs == 0 || freedGPUs >= targetGPUs) {
				break
			}
		}

		// Verify sufficient capacity freed
		if (targetVRAM > 0 && freedVRAM < targetVRAM) || (targetGPUs > 0 && freedGPUs < targetGPUs) {
			logger.V(4).Info("MLWorkloadPreemption: insufficient freed resources on node even after victim selection", "node", node.Name, "freedVRAM", freedVRAM, "targetVRAM", targetVRAM, "freedGPUs", freedGPUs, "targetGPUs", targetGPUs)
			continue
		}

		if len(selectedVictims) > 0 && len(selectedVictims) < minVictimCount {
			minVictimCount = len(selectedVictims)
			bestNode = node.Name
		}
	}

	if bestNode != "" {
		logger.V(3).Info("MLWorkloadPreemption: found node for preemption", "pod", klog.KObj(pod), "nominatedNode", bestNode, "victims", minVictimCount)
		return framework.NewPostFilterResultWithNominatedNode(bestNode), framework.NewStatus(framework.Success)
	}

	return nil, framework.NewStatus(framework.Unschedulable, "insufficient capacity for preemption on any node")
}

func isImmutableHardwareMismatch(reason string) bool {
	msg := strings.ToLower(reason)
	return strings.Contains(msg, "vendor") ||
		strings.Contains(msg, "model") ||
		strings.Contains(msg, "zone") ||
		strings.Contains(msg, "bandwidth") ||
		strings.Contains(msg, "no gpu")
}

func IsPDBViolated(pod *corev1.Pod, pdbs []*policyv1.PodDisruptionBudget) bool {
	for _, pdb := range pdbs {
		if pdb == nil || pdb.Namespace != pod.Namespace {
			continue
		}
		selector, err := metav1.LabelSelectorAsSelector(pdb.Spec.Selector)
		if err != nil || selector == nil {
			continue
		}
		if selector.Matches(labels.Set(pod.Labels)) {
			if pdb.Status.DisruptionsAllowed <= 0 {
				return true
			}
		}
	}
	return false
}
