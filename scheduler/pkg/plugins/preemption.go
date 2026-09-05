package plugins

import (
	"context"
	"math"
	"sort"

	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
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

// GetPodRequestedGPUCount returns the number of accelerators (GPUs or TPUs)
// requested by a pod, derived from the container resource requests — never
// from a node-label key. Pods that only express an accelerator need through
// annotations (vendor/model/VRAM) with no explicit count report 1.
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

// freesNeededResources checks if candidate victim pod frees at least one resource required by preemptor.
func freesNeededResources(targetGPUs, vFreedGPUs, targetVRAM, vFreedVRAM int64) bool {
	return (targetGPUs > 0 && vFreedGPUs > 0) || (targetVRAM > 0 && vFreedVRAM > 0)
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

	pdbTracker := NewPDBTracker(pdbs)

	// Precompute selector matching for all pods across all candidate nodes once per PostFilter
	var allPods []*corev1.Pod
	for _, nodeInfo := range nodeInfos {
		for _, pInfo := range nodeInfo.Pods {
			if pInfo != nil && pInfo.Pod != nil {
				allPods = append(allPods, pInfo.Pod)
			}
		}
	}
	pdbTracker.PrecomputePodMatches(allPods)

	var bestCost *nodePreemptionCost

	for _, nodeInfo := range nodeInfos {
		node := nodeInfo.Node()
		if node == nil {
			continue
		}

		if len(filteredNodeStatusMap) > 0 {
			status, ok := filteredNodeStatusMap[node.Name]
			if !ok || status.Code() == framework.UnschedulableAndUnresolvable || status.Code() == framework.Error {
				logger.V(4).Info("MLWorkloadPreemption: skipping node due to unresolvable/error filter status", "node", node.Name)
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
			if freesNeededResources(targetGPUs, vFreedGPUs, targetVRAM, vFreedVRAM) {
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
		nodeBudget := pdbTracker.NewNodeBudget()
		var selectedVictims []*corev1.Pod
		var freedVRAM int64
		var freedGPUs int64

		for _, vInfo := range candidateVictims {
			vPod := vInfo.Pod

			if !nodeBudget.CanDisrupt(vPod) {
				logger.V(4).Info("MLWorkloadPreemption: skipping victim due to PDB protection", "victim", klog.KObj(vPod), "node", node.Name)
				continue
			}

			vFreedVRAM := GetPodRequestedVRAM(vPod)
			vFreedGPUs := GetPodRequestedGPUCount(vPod)
			if !freesNeededResources(targetGPUs, vFreedGPUs, targetVRAM, vFreedVRAM) {
				continue
			}

			nodeBudget.ConsumeBudget(vPod)
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

		// Re-validate the candidate node against the full filter chain with victims removed
		clonedNodeInfo := nodeInfo.Snapshot()
		for _, v := range selectedVictims {
			if err := clonedNodeInfo.RemovePod(logger, v); err != nil {
				logger.V(4).Info("MLWorkloadPreemption: failed to remove pod from cloned NodeInfo", "pod", klog.KObj(v), "err", err)
			}
		}

		if p.handle != nil {
			filterStatus := p.handle.RunFilterPluginsWithNominatedPods(ctx, state, pod, clonedNodeInfo)
			if !filterStatus.IsSuccess() {
				logger.V(4).Info("MLWorkloadPreemption: target node failed filter chain re-validation after victim removal", "node", node.Name, "status", filterStatus.Message())
				continue
			}
		}

		cost := computeNodePreemptionCost(node.Name, selectedVictims)
		if bestCost == nil || cost.betterThan(*bestCost) {
			bestCost = &cost
		}
	}

	if bestCost != nil {
		logger.V(3).Info("MLWorkloadPreemption: found node for preemption", "pod", klog.KObj(pod), "nominatedNode", bestCost.nodeName, "victims", bestCost.victimCount, "highestPriority", bestCost.highestPriority, "sumPriorities", bestCost.sumPriorities)

		// Evict selected victim pods so the preemptor can be scheduled.
		if p.handle != nil {
			for _, victim := range bestCost.victims {
				eviction := &policyv1.Eviction{
					ObjectMeta: metav1.ObjectMeta{
						Name:      victim.Name,
						Namespace: victim.Namespace,
					},
				}
				err := p.handle.ClientSet().CoreV1().Pods(victim.Namespace).EvictV1(ctx, eviction)
				if err != nil {
					logger.V(2).Info("MLWorkloadPreemption: failed to evict victim pod", "victim", klog.KObj(victim), "err", err)
				} else {
					logger.V(3).Info("MLWorkloadPreemption: evicted victim pod", "victim", klog.KObj(victim))
				}
			}
		}

		return framework.NewPostFilterResultWithNominatedNode(bestCost.nodeName), framework.NewStatus(framework.Success)
	}

	return nil, framework.NewStatus(framework.Unschedulable, "insufficient capacity for preemption on any node")
}

// PDBTracker tracks and decrements PodDisruptionBudget allocations during preemption victim selection.
type PDBTracker struct {
	pdbs           []*policyv1.PodDisruptionBudget
	selectors      []labels.Selector
	initialBudgets []int32
	podMatches     map[types.UID][]int
}

// NewPDBTracker initializes a PDBTracker and precomputes label selectors for all provided PDBs.
// PDBs with nil or invalid selectors are safely ignored.
func NewPDBTracker(pdbs []*policyv1.PodDisruptionBudget) *PDBTracker {
	tracker := &PDBTracker{
		podMatches: make(map[types.UID][]int),
	}
	for _, pdb := range pdbs {
		if pdb == nil {
			continue
		}
		if pdb.Spec.Selector == nil {
			continue
		}
		selector, err := metav1.LabelSelectorAsSelector(pdb.Spec.Selector)
		if err != nil || selector == nil {
			continue
		}
		tracker.pdbs = append(tracker.pdbs, pdb)
		tracker.selectors = append(tracker.selectors, selector)
		tracker.initialBudgets = append(tracker.initialBudgets, pdb.Status.DisruptionsAllowed)
	}
	return tracker
}

// PrecomputePodMatches precomputes which PDBs match each pod in the provided list of pods.
func (pt *PDBTracker) PrecomputePodMatches(pods []*corev1.Pod) {
	for _, pod := range pods {
		if pod == nil {
			continue
		}
		if pod.UID != "" {
			pt.podMatches[pod.UID] = pt.matchingPDBIndices(pod)
		}
	}
}

func (pt *PDBTracker) matchingPDBIndices(pod *corev1.Pod) []int {
	if pod == nil {
		return nil
	}
	podLabels := labels.Set(pod.Labels)
	var matches []int
	for i, pdb := range pt.pdbs {
		if pdb.Namespace != pod.Namespace {
			continue
		}
		if pt.selectors[i] != nil && pt.selectors[i].Matches(podLabels) {
			matches = append(matches, i)
		}
	}
	return matches
}

// GetMatchingPDBIndices returns the indices of all PDBs matching the given pod.
func (pt *PDBTracker) GetMatchingPDBIndices(pod *corev1.Pod) []int {
	if pod == nil {
		return nil
	}
	if pod.UID != "" {
		if matches, ok := pt.podMatches[pod.UID]; ok {
			return matches
		}
	}
	return pt.matchingPDBIndices(pod)
}

// NodePDBBudget represents a deep-copied disruption budget state for evaluating a single candidate node.
type NodePDBBudget struct {
	tracker *PDBTracker
	budgets []int32
}

// NewNodeBudget creates a deep-copied budget state from the tracker's initial budgets.
func (pt *PDBTracker) NewNodeBudget() *NodePDBBudget {
	b := make([]int32, len(pt.initialBudgets))
	copy(b, pt.initialBudgets)
	return &NodePDBBudget{
		tracker: pt,
		budgets: b,
	}
}

// CanDisrupt returns true if all matching PDBs have DisruptionsAllowed > 0.
// If no PDBs match the pod, it returns true.
func (nb *NodePDBBudget) CanDisrupt(pod *corev1.Pod) bool {
	if nb == nil || nb.tracker == nil {
		return true
	}
	matching := nb.tracker.GetMatchingPDBIndices(pod)
	for _, idx := range matching {
		if nb.budgets[idx] <= 0 {
			return false
		}
	}
	return true
}

// ConsumeBudget decrements DisruptionsAllowed for all matching PDBs.
func (nb *NodePDBBudget) ConsumeBudget(pod *corev1.Pod) {
	if nb == nil || nb.tracker == nil {
		return
	}
	matching := nb.tracker.GetMatchingPDBIndices(pod)
	for _, idx := range matching {
		nb.budgets[idx]--
	}
}

// IsPDBViolated checks whether evicting pod violates any PDB in pdbs.
// Maintained for direct callers and backwards compatibility.
func IsPDBViolated(pod *corev1.Pod, pdbs []*policyv1.PodDisruptionBudget) bool {
	tracker := NewPDBTracker(pdbs)
	nodeBudget := tracker.NewNodeBudget()
	return !nodeBudget.CanDisrupt(pod)
}
