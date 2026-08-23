package plugins

import (
	"context"
	"math"
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

// GetPodPriority returns the integer priority for a pod. If Priority is unset, defaults to 0.
func GetPodPriority(pod *corev1.Pod) int32 {
	if pod != nil && pod.Spec.Priority != nil {
		return *pod.Spec.Priority
	}
	return 0
}

// GetPodRequestedVRAM returns the per-pod required VRAM in MiB.
func GetPodRequestedVRAM(pod *corev1.Pod) int64 {
	if pod == nil {
		return 0
	}
	reqs := hardware.ParsePodHardwareReqs(pod)
	return reqs.GPUVRAMMinMiB
}

// GetPodRequestedGPUCount returns the number of GPUs requested by a pod.
func GetPodRequestedGPUCount(pod *corev1.Pod) int64 {
	if pod == nil {
		return 0
	}
	reqs := hardware.ParsePodHardwareReqs(pod)
	if reqs.GPUCountReq > 0 {
		return reqs.GPUCountReq
	}
	if reqs.NeedsGPU() {
		return 1
	}
	return 0
}

// isPodEvictable checks whether a pod is eligible for preemption eviction.
// DaemonSet pods, mirror pods, and terminating pods are non-evictable.
func isPodEvictable(pod *corev1.Pod) bool {
	if pod == nil {
		return false
	}
	if pod.DeletionTimestamp != nil {
		return false
	}
	if pod.Annotations != nil && pod.Annotations[corev1.MirrorPodAnnotationKey] != "" {
		return false
	}
	for _, ref := range pod.OwnerReferences {
		if ref.Kind == "DaemonSet" {
			return false
		}
	}
	return true
}

// nodePreemptionCost models the disruption cost of preemption on a candidate node.
// Cost evaluation order:
// 1. HighestPriority: minimize the maximum victim priority disrupted.
// 2. SumPriorities: minimize the total sum of victim priorities disrupted.
// 3. VictimCount: minimize the number of victims disrupted.
// 4. NodeName: deterministic lexicographical tie-break.
type nodePreemptionCost struct {
	nodeName        string
	victims         []*corev1.Pod
	highestPriority int32
	sumPriorities   int64
	victimCount     int
}

func computeNodePreemptionCost(nodeName string, victims []*corev1.Pod) nodePreemptionCost {
	var highestPriority int32 = math.MinInt32
	var sumPriorities int64
	for _, v := range victims {
		p := GetPodPriority(v)
		if p > highestPriority {
			highestPriority = p
		}
		sumPriorities += int64(p)
	}
	if len(victims) == 0 {
		highestPriority = 0
	}
	return nodePreemptionCost{
		nodeName:        nodeName,
		victims:         victims,
		highestPriority: highestPriority,
		sumPriorities:   sumPriorities,
		victimCount:     len(victims),
	}
}

func (c nodePreemptionCost) betterThan(other nodePreemptionCost) bool {
	if c.highestPriority != other.highestPriority {
		return c.highestPriority < other.highestPriority
	}
	if c.sumPriorities != other.sumPriorities {
		return c.sumPriorities < other.sumPriorities
	}
	if c.victimCount != other.victimCount {
		return c.victimCount < other.victimCount
	}
	return c.nodeName < other.nodeName
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

	// 1. Pods with PreemptionPolicy: Never must not preempt
	if pod.Spec.PreemptionPolicy != nil && *pod.Spec.PreemptionPolicy == corev1.PreemptNever {
		logger.V(4).Info("MLWorkloadPreemption: pod has PreemptionPolicy Never", "pod", klog.KObj(pod))
		return nil, framework.NewStatus(framework.Unschedulable, "pod has PreemptionPolicy Never")
	}

	// 2. Preemptors requesting no GPU or VRAM do not trigger preemption on GPU grounds
	reqs := hardware.ParsePodHardwareReqs(pod)
	targetVRAM := reqs.GPUVRAMMinMiB
	targetGPUs := GetPodRequestedGPUCount(pod)

	if targetVRAM == 0 && targetGPUs == 0 {
		logger.V(4).Info("MLWorkloadPreemption: pod requires no GPU/VRAM resources; skipping preemption", "pod", klog.KObj(pod))
		return nil, framework.NewStatus(framework.Unschedulable, "pod does not require GPU resources for ML preemption")
	}

	nodeInfos, err := p.handle.SnapshotSharedLister().NodeInfos().List()
	if err != nil || len(nodeInfos) == 0 {
		return nil, framework.NewStatus(framework.Unschedulable, "no nodes available in snapshot")
	}

	preemptorPriority := GetPodPriority(pod)

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

	var bestCost *nodePreemptionCost
	filterPlugin := &GPUHardwareFilter{}

	for _, nodeInfo := range nodeInfos {
		node := nodeInfo.Node()
		if node == nil {
			continue
		}

		// Check if node passes basic hardware constraints
		filterStatus := filterPlugin.Filter(ctx, state, pod, nodeInfo)
		if filterStatus != nil && filterStatus.Code() == framework.Unschedulable {
			if isImmutableHardwareMismatch(filterStatus.Message()) {
				logger.V(4).Info("MLWorkloadPreemption: node immutable hardware mismatch", "node", node.Name, "reason", filterStatus.Message())
				continue
			}
		}

		// Find lower-priority, evictable victim candidates that free needed resources
		var candidateVictims []*framework.PodInfo
		for _, pInfo := range nodeInfo.Pods {
			if pInfo == nil || pInfo.Pod == nil {
				continue
			}
			victimPod := pInfo.Pod
			if !isPodEvictable(victimPod) {
				continue
			}
			if GetPodPriority(victimPod) >= preemptorPriority {
				continue
			}

			vFreedVRAM := GetPodRequestedVRAM(victimPod)
			vFreedGPUs := GetPodRequestedGPUCount(victimPod)
			// A victim that frees none of the needed resources is never selected
			if (targetGPUs > 0 && vFreedGPUs > 0) || (targetVRAM > 0 && vFreedVRAM > 0) {
				candidateVictims = append(candidateVictims, pInfo)
			}
		}

		if len(candidateVictims) == 0 {
			continue
		}

		// Sort candidate victims: lowest priority first, tie-break by name for determinism
		sort.Slice(candidateVictims, func(i, j int) bool {
			pi := GetPodPriority(candidateVictims[i].Pod)
			pj := GetPodPriority(candidateVictims[j].Pod)
			if pi != pj {
				return pi < pj
			}
			return candidateVictims[i].Pod.Name < candidateVictims[j].Pod.Name
		})

		// Select victims required to meet GPU/VRAM demands
		var selectedVictims []*corev1.Pod
		var freedVRAM int64
		var freedGPUs int64

		for _, vInfo := range candidateVictims {
			vPod := vInfo.Pod

			if IsPDBViolated(vPod, pdbs) {
				logger.V(4).Info("MLWorkloadPreemption: skipping victim due to PDB protection", "victim", klog.KObj(vPod), "node", node.Name)
				continue
			}

			vFreedVRAM := GetPodRequestedVRAM(vPod)
			vFreedGPUs := GetPodRequestedGPUCount(vPod)
			if (targetGPUs > 0 && vFreedGPUs == 0) && (targetVRAM > 0 && vFreedVRAM == 0) {
				continue
			}

			selectedVictims = append(selectedVictims, vPod)
			freedVRAM += vFreedVRAM
			freedGPUs += vFreedGPUs

			if (targetVRAM == 0 || freedVRAM >= targetVRAM) && (targetGPUs == 0 || freedGPUs >= targetGPUs) {
				break
			}
		}

		// Verify sufficient capacity freed
		if (targetVRAM > 0 && freedVRAM < targetVRAM) || (targetGPUs > 0 && freedGPUs < targetGPUs) || len(selectedVictims) == 0 {
			logger.V(4).Info("MLWorkloadPreemption: insufficient freed resources on node even after victim selection", "node", node.Name, "freedVRAM", freedVRAM, "targetVRAM", targetVRAM, "freedGPUs", freedGPUs, "targetGPUs", targetGPUs)
			continue
		}

		cost := computeNodePreemptionCost(node.Name, selectedVictims)
		if bestCost == nil || cost.betterThan(*bestCost) {
			bestCost = &cost
		}
	}

	if bestCost != nil {
		logger.V(3).Info("MLWorkloadPreemption: found node for preemption", "pod", klog.KObj(pod), "nominatedNode", bestCost.nodeName, "victims", bestCost.victimCount, "highestPriority", bestCost.highestPriority, "sumPriorities", bestCost.sumPriorities)
		return framework.NewPostFilterResultWithNominatedNode(bestCost.nodeName), framework.NewStatus(framework.Success)
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
