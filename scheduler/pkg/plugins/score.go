package plugins

// Score plugin: MLWorkloadScore
// ──────────────────────────────
// Soft-preference stage.  Each candidate node that survived filtering receives
// a composite score 0–100 built from four sub-scores:
//
//  A. BinPacking score   — favour nodes already running ML pods so we pack
//                          GPU capacity tightly and leave clean nodes for
//                          non-ML workloads.  Score = allocatedGPUFraction × 100.
//
//  B. GPU Fragmentation  — penalise nodes whose allocated GPUs are nearly
//                          full (> fragThreshold %).  This prevents landing
//                          a large training job on a node that has only one
//                          free GPU slice left, which would fragment capacity.
//                          Score = 100 when fragmentation is low, 0 when high.
//
//  C. NUMA Topology      — prefer nodes where the pod's requested GPUs fit in
//                          the fewest NUMA domains, using the declared
//                          GPU-per-domain distribution.  Topology scoring is
//                          only trusted when kubelet alignment is enforced.
//
//  D. Network Bandwidth  — normalise the node's bandwidth against the cluster
//                          maximum and score proportionally (high-bandwidth
//                          nodes get higher scores for ML-batch workloads).
//
// Final score = w_A×A + w_B×B + w_C×C + w_D×D, normalised to [0, 100].
// Default weights: A=0.40, B=0.25, C=0.20, D=0.15.
//
// The pod annotation greenpay.io/bin-pack-weight multiplies the final score
// so individual pods can tune aggressiveness without changing global config.

import (
	"context"
	"math"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/klog/v2"
	"k8s.io/kubernetes/pkg/scheduler/framework"

	"github.com/greenpay/scheduler/pkg/hardware"
)

// MLWorkloadScoreName is the unique plugin name.
const MLWorkloadScoreName = "MLWorkloadScore"

// scoreWeights holds the relative importance of each sub-score dimension.
// They must sum to 1.0.
type scoreWeights struct {
	BinPacking    float64
	Fragmentation float64
	NUMA          float64
	Bandwidth     float64
}

var defaultWeights = scoreWeights{
	BinPacking:    0.40,
	Fragmentation: 0.25,
	NUMA:          0.20,
	Bandwidth:     0.15,
}

// clusterBandwidthState is a CycleState value storing the max observed
// bandwidth across the candidate node set (used for normalisation).
// It is constructed once in PreScore and treated as immutable across
// parallel Score goroutines.
type clusterBandwidthState struct {
	maxGbps int64
}

func (s *clusterBandwidthState) Clone() framework.StateData {
	if s == nil {
		return nil
	}
	return &clusterBandwidthState{maxGbps: s.maxGbps}
}

const bandwidthStateKey framework.StateKey = "greenpay/bandwidthState"

// defaultFragThreshold is applied both by NewMLWorkloadScore (for callers,
// such as tests, that construct MLWorkloadScoreArgs directly and bypass the
// scheme's defaulting) and by SetDefaults_MLWorkloadScoreArgs (for the
// scheduler's own config-loading path, registered against the plugin arg
// conversion scheme in scheme.go).
const defaultFragThreshold = 0.85

// MLWorkloadScoreArgs holds configuration parameters for the MLWorkloadScore plugin.
type MLWorkloadScoreArgs struct {
	metav1.TypeMeta `json:",inline"`
	FragThreshold   float64 `json:"fragThreshold,omitempty"`
}

// DeepCopyObject implements runtime.Object.
func (args *MLWorkloadScoreArgs) DeepCopyObject() runtime.Object {
	if args == nil {
		return nil
	}
	out := new(MLWorkloadScoreArgs)
	out.TypeMeta = args.TypeMeta
	out.FragThreshold = args.FragThreshold
	return out
}

// SetDefaults_MLWorkloadScoreArgs applies the plugin's default fragmentation
// threshold when a profile enables MLWorkloadScore without an explicit
// pluginConfig entry, or with one that omits fragThreshold. Registered with
// the scheduler's plugin arg conversion scheme in scheme.go.
func SetDefaults_MLWorkloadScoreArgs(obj *MLWorkloadScoreArgs) {
	if obj.FragThreshold <= 0 {
		obj.FragThreshold = defaultFragThreshold
	}
}

// MLWorkloadScore implements framework.ScorePlugin and framework.PreScorePlugin.
type MLWorkloadScore struct {
	handle  framework.Handle
	weights scoreWeights
	// fragThreshold is the GPU-allocation fraction above which a node is
	// considered fragmented.  Default: 0.85 (85 %).
	fragThreshold float64
}

// FragThreshold returns the configured fragmentation threshold.
func (s *MLWorkloadScore) FragThreshold() float64 {
	return s.fragThreshold
}

// SetFragThreshold sets the fragmentation threshold.
func (s *MLWorkloadScore) SetFragThreshold(t float64) {
	s.fragThreshold = t
}

// Compile-time interface assertions.
var _ framework.ScorePlugin = &MLWorkloadScore{}
var _ framework.PreScorePlugin = &MLWorkloadScore{}

// Name returns the plugin name.
func (s *MLWorkloadScore) Name() string { return MLWorkloadScoreName }

// NewMLWorkloadScore is the plugin factory.
func NewMLWorkloadScore(_ context.Context, obj runtime.Object, handle framework.Handle) (framework.Plugin, error) {
	threshold := defaultFragThreshold
	if args, ok := obj.(*MLWorkloadScoreArgs); ok && args != nil && args.FragThreshold > 0 {
		threshold = args.FragThreshold
	}
	return &MLWorkloadScore{
		handle:        handle,
		weights:       defaultWeights,
		fragThreshold: threshold,
	}, nil
}

// ── PreScore ─────────────────────────────────────────────────────────────────

// PreScore runs once per scheduling cycle before Score is called per-node.
// It calculates the cluster-wide maximum network bandwidth so each per-node
// Score call can normalise against it without rescanning all nodes.
func (s *MLWorkloadScore) PreScore(
	ctx context.Context,
	state *framework.CycleState,
	pod *corev1.Pod,
	nodes []*framework.NodeInfo,
) *framework.Status {
	var maxGbps int64

	for _, nodeInfo := range nodes {
		node := nodeInfo.Node()
		if node == nil {
			continue
		}
		hw := hardware.ParseNodeHardware(node)
		if hw.NetworkBandwidthGbps > maxGbps {
			maxGbps = hw.NetworkBandwidthGbps
		}
	}

	state.Write(bandwidthStateKey, &clusterBandwidthState{maxGbps: maxGbps})

	klog.FromContext(ctx).V(5).Info("PreScore: cluster max bandwidth",
		"maxGbps", maxGbps,
		"pod", klog.KObj(pod),
	)
	return framework.NewStatus(framework.Success)
}

// ── Score ─────────────────────────────────────────────────────────────────────

// Score returns a value in [0, framework.MaxNodeScore] (i.e. 0–100) for the
// given node.  Higher scores mean a more preferred placement.
func (s *MLWorkloadScore) Score(
	ctx context.Context,
	state *framework.CycleState,
	pod *corev1.Pod,
	nodeName string,
) (int64, *framework.Status) {
	// Retrieve the pre-computed cluster bandwidth state.
	var bwState *clusterBandwidthState
	if raw, err := state.Read(bandwidthStateKey); err == nil && raw != nil {
		var ok bool
		bwState, ok = raw.(*clusterBandwidthState)
		if !ok {
			// Graceful degradation: foreign/unexpected type stored under key.
			bwState = &clusterBandwidthState{}
		}
	} else {
		// Graceful degradation: missing state means PreScore didn't run.
		// Fall back to a zero max (bandwidth sub-score will be neutral).
		bwState = &clusterBandwidthState{}
	}

	// Resolve the candidate node through the framework handle's snapshot.  The
	// neutral fallback below is reserved for a node that genuinely cannot be
	// resolved; it must not become the path every scheduling cycle takes.
	if s.handle == nil || s.handle.SnapshotSharedLister() == nil {
		klog.FromContext(ctx).V(3).Info("Score: no shared lister available", "node", nodeName)
		return framework.MaxNodeScore / 2, framework.NewStatus(framework.Success)
	}
	nodeInfo, err := s.handle.SnapshotSharedLister().NodeInfos().Get(nodeName)
	if err != nil {
		klog.FromContext(ctx).V(3).Info("Score: could not retrieve node info", "node", nodeName, "err", err)
		return framework.MaxNodeScore / 2, framework.NewStatus(framework.Success)
	}
	node := nodeInfo.Node()
	if node == nil {
		klog.FromContext(ctx).V(3).Info("Score: node object is missing from node info", "node", nodeName)
		return framework.MaxNodeScore / 2, framework.NewStatus(framework.Success)
	}

	reqs := hardware.ParsePodHardwareReqs(pod)
	hw := hardware.ParseNodeHardware(node)

	scoreA := s.binPackingScore(nodeInfo, hw)
	scoreB := s.fragmentationScore(nodeInfo, node, hw)
	scoreC := s.numaScore(reqs, hw)
	scoreD := s.bandwidthScore(hw, bwState)

	composite := s.weights.BinPacking*scoreA +
		s.weights.Fragmentation*scoreB +
		s.weights.NUMA*scoreC +
		s.weights.Bandwidth*scoreD

	// Apply per-pod bin-pack weight multiplier and clamp to [0, 100].
	composite *= reqs.BinPackWeight
	composite = math.Min(composite, 100.0)
	composite = math.Max(composite, 0.0)

	final := int64(math.Round(composite))

	klog.FromContext(ctx).V(5).Info("Score: computed",
		"pod", klog.KObj(pod),
		"node", nodeName,
		"binPacking", scoreA,
		"fragmentation", scoreB,
		"numa", scoreC,
		"requestedGPUs", reqs.GPUCountReq,
		"topologyManagerPolicy", hw.TopologyManagerPolicy,
		"bandwidth", scoreD,
		"composite", final,
	)

	return final, framework.NewStatus(framework.Success)
}

// ScoreExtensions returns the NormalizeScore extension so the scheduler calls
// NormalizeScore after all nodes are scored.
func (s *MLWorkloadScore) ScoreExtensions() framework.ScoreExtensions {
	return s
}

// NormalizeScore ensures all node scores are within the valid range [framework.MinNodeScore, framework.MaxNodeScore]
// (0 to 100) while preserving the absolute magnitude of raw composite scores.
//
// Interaction with KubeSchedulerProfile Plugin Weights:
// In Kubernetes scheduling profiles, plugins are combined via a weighted sum across all scoring plugins:
//
//	TotalNodeScore = Sum(Plugin_i_Weight * NormalizedScore_i)
//
// By preserving absolute score magnitude rather than scaling the cycle's observed max to 100:
//  1. Genuinely mediocre placements (e.g. all candidate nodes scoring ~40 due to poor packing/NUMA/bandwidth fit)
//     retain their modest absolute scores, allowing other weighted plugins in the profile (such as NodeResourcesFit
//     or ImageLocality) to drive placement decisions proportionally.
//  2. An optimal node scoring near 100 exerts the full intended influence of this plugin's configured weight.
//  3. Relative-max score stretching is avoided, preventing false confidence signals from dominating the multi-plugin
//     profile evaluation.
func (s *MLWorkloadScore) NormalizeScore(
	ctx context.Context,
	state *framework.CycleState,
	pod *corev1.Pod,
	scores framework.NodeScoreList,
) *framework.Status {
	for i := range scores {
		if scores[i].Score > framework.MaxNodeScore {
			scores[i].Score = framework.MaxNodeScore
		} else if scores[i].Score < framework.MinNodeScore {
			scores[i].Score = framework.MinNodeScore
		}
	}

	klog.FromContext(ctx).V(5).Info("NormalizeScore: preserved absolute scores", "pod", klog.KObj(pod), "nodeCount", len(scores))
	return framework.NewStatus(framework.Success)
}

// ── Sub-score implementations ─────────────────────────────────────────────────

// binPackingScore rewards nodes that are already hosting ML workloads,
// promoting dense GPU utilisation.
//
// Score = (requestedMilliCPU / allocatableMilliCPU) × 100
//
// The requested figure comes from the scheduler snapshot's NodeInfo, which
// accumulates the resource requests of the pods actually placed on the node.
// That is the quantity that has to move as ML pods land — scoring off
// capacity − allocatable instead would only measure kubelet's static system
// reservation and would return the same number for a node no matter what is
// running on it.
//
// We use CPU as a proxy here because GPU-request accounting via the device
// plugin model is exposed through extended resources on node allocatable.
// Operators should also label GPU extended resources on nodes; this gives a
// robust fallback for clusters where GPU device plugins are not deployed.
func (s *MLWorkloadScore) binPackingScore(ni *framework.NodeInfo, hw hardware.NodeHardware) float64 {
	if ni == nil || ni.Node() == nil {
		return 50.0 // neutral
	}

	allocatable := ni.Allocatable
	requested := ni.Requested

	if allocatable == nil || requested == nil {
		return 50.0
	}

	var fractions []float64

	// 1. CPU
	if allocatable.MilliCPU > 0 {
		f := float64(requested.MilliCPU) / float64(allocatable.MilliCPU)
		fractions = append(fractions, f)
	}

	// 2. GPUs (extended resources)
	gpuResourceNames := []corev1.ResourceName{
		"nvidia.com/gpu",
		"amd.com/gpu",
		"google.com/tpu",
	}

	for _, resName := range gpuResourceNames {
		var allocQty int64 = 0
		if allocatable.ScalarResources != nil {
			allocQty = allocatable.ScalarResources[resName]
		}
		if allocQty > 0 {
			var reqQty int64 = 0
			if requested.ScalarResources != nil {
				reqQty = requested.ScalarResources[resName]
			}
			f := float64(reqQty) / float64(allocQty)
			fractions = append(fractions, f)
		}
	}

	if len(fractions) == 0 {
		return 50.0
	}

	var totalFraction float64 = 0
	for _, f := range fractions {
		totalFraction += f
	}

	avgFraction := totalFraction / float64(len(fractions))
	if avgFraction > 1.0 {
		avgFraction = 1.0
	} else if avgFraction < 0.0 {
		avgFraction = 0.0
	}

	return avgFraction * 100.0
}

// fragmentationScore computes the allocated GPU fraction for a node and
// applies a V-shaped scoring curve centered at fragThreshold.
//
// Score:
//   - 0% or 100% allocation: 100 (plenty of room OR fully packed)
//   - fragThreshold allocation: 0 (fragmented zone)
//
// The score function is a "V" shaped curve centered at s.fragThreshold.
func (s *MLWorkloadScore) fragmentationScore(ni *framework.NodeInfo, node *corev1.Node, hw hardware.NodeHardware) float64 {
	if !hw.HasGPU() {
		// Non-GPU nodes — skip GPU fragmentation logic.
		return 100.0
	}

	var totalGPUs int64 = hw.GPUCount
	var allocatedGPUs int64 = 0

	gpuResourceNames := []corev1.ResourceName{
		"nvidia.com/gpu",
		"amd.com/gpu",
		"google.com/tpu",
	}

	if ni != nil {
		if totalGPUs == 0 {
			if ni.Allocatable != nil && ni.Allocatable.ScalarResources != nil {
				for _, resName := range gpuResourceNames {
					if qty, ok := ni.Allocatable.ScalarResources[resName]; ok && qty > 0 {
						totalGPUs += qty
					}
				}
			}
			if totalGPUs == 0 && node != nil && node.Status.Allocatable != nil {
				for _, resName := range gpuResourceNames {
					if q, ok := node.Status.Allocatable[resName]; ok {
						totalGPUs += q.Value()
					}
				}
			}
		}

		if ni.Requested != nil && ni.Requested.ScalarResources != nil {
			for _, resName := range gpuResourceNames {
				if qty, ok := ni.Requested.ScalarResources[resName]; ok {
					allocatedGPUs += qty
				}
			}
		} else if len(ni.Pods) > 0 {
			for _, podInfo := range ni.Pods {
				if podInfo == nil || podInfo.Pod == nil {
					continue
				}
				for _, container := range podInfo.Pod.Spec.Containers {
					for _, resName := range gpuResourceNames {
						if q, ok := container.Resources.Requests[resName]; ok {
							allocatedGPUs += q.Value()
						}
					}
				}
			}
		}
	} else if node != nil && totalGPUs == 0 {
		if node.Status.Allocatable != nil {
			for _, resName := range gpuResourceNames {
				if q, ok := node.Status.Allocatable[resName]; ok {
					totalGPUs += q.Value()
				}
			}
		}
	}

	if totalGPUs <= 0 {
		return 100.0
	}

	fraction := float64(allocatedGPUs) / float64(totalGPUs)
	if fraction < 0.0 {
		fraction = 0.0
	} else if fraction > 1.0 {
		fraction = 1.0
	}

	threshold := s.fragThreshold
	if threshold <= 0.0 {
		return fraction * 100.0
	}
	if threshold >= 1.0 {
		return (1.0 - fraction) * 100.0
	}

	var score float64
	if fraction <= threshold {
		score = 100.0 * (threshold - fraction) / threshold
	} else {
		score = 100.0 * (fraction - threshold) / (1.0 - threshold)
	}

	return score
}

// numaScore scores a node by the minimum number of NUMA domains needed to
// supply the pod's requested GPUs.
//
// Strategy:
//   - Missing, inconsistent, or non-enforced topology metadata is neutral.
//   - restricted policy scores 100 / required NUMA domains.
//   - single-numa-node scores 100 only when all requested GPUs fit in one
//     domain, otherwise 0 because kubelet will not admit that alignment.
//   - Non-ML or CPU-only workloads remain neutral.
func (s *MLWorkloadScore) numaScore(reqs hardware.PodHardwareReqs, hw hardware.NodeHardware) float64 {
	return scoreNUMALocality(reqs, hw)
}

// bandwidthScore rewards nodes with higher network bandwidth, normalised
// against the cluster-maximum bandwidth observed in PreScore.
//
// Score = (node bandwidth / cluster max bandwidth) × 100
//
// High-bandwidth nodes are preferred for ml-training and ml-batch workloads
// that need to shuffle large tensors or datasets over the network.  For
// ml-inference this is less critical, so the overall weight is lower (0.15).
func (s *MLWorkloadScore) bandwidthScore(hw hardware.NodeHardware, bwState *clusterBandwidthState) float64 {
	if hw.NetworkBandwidthGbps == 0 {
		return 50.0 // no label — neutral
	}

	if bwState == nil || bwState.maxGbps == 0 {
		return 50.0
	}

	return float64(hw.NetworkBandwidthGbps) / float64(bwState.maxGbps) * 100.0
}
