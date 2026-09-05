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

	// Every sub-score reports both a measured value and how well the inputs
	// behind it are known; applyMetadataPolicy turns that pair into the score
	// the dimension is entitled to.  Routing all four through the one call is
	// what keeps the missing-metadata policy single-sourced — see its
	// definition below.
	scoreA := applyMetadataPolicy(s.binPackingScore(nodeInfo, hw))
	scoreB := applyMetadataPolicy(s.fragmentationScore(nodeInfo, node, hw))
	scoreC := applyMetadataPolicy(s.numaScore(reqs, hw))
	scoreD := applyMetadataPolicy(s.bandwidthScore(hw, bwState))

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

// ── Missing-metadata policy ───────────────────────────────────────────────────
//
// Every sub-score below draws on node metadata that may simply not be there.
// The greenpay.io labels are applied by hand — k8s/ml-workloads/node-labels.yaml
// is an operator runbook, not a manifest, and nothing in the cluster applies
// them automatically — so an unlabelled node is not a transient startup state.
// It is the default state of every node until someone gets to it, and under
// cluster autoscaling a node may never be labelled at all.
//
// The rule, applied identically by all four sub-scores:
//
//	A sub-score may claim only as much of its range as its inputs justify.
//
//	  declared — the value comes from an authoritative source: a greenpay.io
//	             label the operator attested, or a resource kubelet reports on
//	             the node itself.  Scored across the full range.
//
//	  inferred — the value is derived from a secondary, dynamic source: the
//	             accelerator extended resources a device plugin advertises.
//	             Usable, but not the quantity a label declares — kubelet drops
//	             unhealthy devices from allocatable, a device plugin may not
//	             have finished registering, and MIG or time-slicing advertises
//	             slices rather than physical GPUs.  Scored on the measured
//	             value, discounted by inferredSignalConfidence so it cannot
//	             reach the top of the range: the signal is worth trusting, but
//	             not worth treating as certainty.
//
//	  unknown  — no source at all.  Scored unknownMetadataScore.
//
// unknownMetadataScore is 0, the bottom of the range, and that is forced rather
// than chosen.  The property this policy exists to hold is that a node we know
// nothing about must not outrank a node that honestly reports poor
// characteristics — for *every* honest node, not merely most of them.  Honest
// scores occupy the whole closed range [0, 100], and the only value less than
// or equal to every element of that range is 0.  A "deprioritised but not
// maximally penalised" band would still outrank every honest node scoring below
// the band, relocating the inverted incentive instead of removing it.
//
// Scoring is a preference, not an admission check.  A node scoring 0 here stays
// schedulable and simply ranks last, which is the honest answer while we know
// nothing about it, and NormalizeScore deliberately preserves that low absolute
// magnitude (see its doc comment) so the other plugins in the profile decide
// placement instead.  The score corrects itself on the next scheduling cycle as
// soon as either signal source appears.
//
// What this policy does NOT govern: a dimension that provably does not apply to
// the node or pod at hand.  A node the operator has declared CPU-only has no
// GPU fragmentation to measure, and a pod that requests no GPUs has no NUMA
// locality to optimise.  Those keep their own per-dimension constants
// (noGPUFragmentationScore, numaNotApplicableScore) and report declared
// confidence, because they are answers rather than gaps.

// signalConfidence classifies how well the inputs behind a sub-score are known.
// See the missing-metadata policy above.
type signalConfidence int

const (
	// signalDeclared marks a value read from an authoritative source.
	signalDeclared signalConfidence = iota
	// signalInferred marks a value derived from a secondary, dynamic source.
	signalInferred
	// signalUnknown marks a dimension with no available source.  A sub-score
	// returning it has no measured value to report and returns 0; the measured
	// value is ignored either way.
	signalUnknown
)

const (
	// unknownMetadataScore is what a dimension scores when nothing on the node
	// determines it.  See the missing-metadata policy for why it is the bottom
	// of the range rather than the neutral midpoint.
	unknownMetadataScore = 0.0

	// inferredSignalConfidence discounts a sub-score computed from an inferred
	// rather than a declared signal, keeping it below the top of the range.
	inferredSignalConfidence = 0.75
)

// applyMetadataPolicy maps a sub-score's measured value onto the range its
// input confidence justifies.  It is the single implementation of the
// missing-metadata policy documented above: the four sub-scores report what
// they measured and how well they know it, and this decides what that is worth,
// so a gap in one dimension is never valued differently from a gap in another.
func applyMetadataPolicy(measured float64, confidence signalConfidence) float64 {
	switch confidence {
	case signalInferred:
		return measured * inferredSignalConfidence
	case signalUnknown:
		return unknownMetadataScore
	default:
		return measured
	}
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
//
// Utilisation is read straight off the node, so it is either observable or it
// is not — this dimension has no secondary source to infer from and never
// reports inferred confidence.  A node whose utilisation cannot be observed at
// all falls to the missing-metadata policy rather than to a neutral score.
func (s *MLWorkloadScore) binPackingScore(ni *framework.NodeInfo, hw hardware.NodeHardware) (float64, signalConfidence) {
	if ni == nil || ni.Node() == nil {
		return 0, signalUnknown
	}

	allocatable := ni.Allocatable
	requested := ni.Requested

	if allocatable == nil || requested == nil {
		return 0, signalUnknown
	}

	var fractions []float64

	// 1. CPU
	if allocatable.MilliCPU > 0 {
		f := float64(requested.MilliCPU) / float64(allocatable.MilliCPU)
		fractions = append(fractions, f)
	}

	// 2. Accelerators (extended resources).  Matched through
	// hardware.IsAcceleratorResource so this agrees with the filter plugin and
	// with pod-side accounting instead of carrying its own vendor list; the
	// duplicate list this replaces is what silently dropped TPU nodes.
	for resName, allocQty := range allocatable.ScalarResources {
		if !hardware.IsAcceleratorResource(resName) || allocQty <= 0 {
			continue
		}
		var reqQty int64
		if requested.ScalarResources != nil {
			reqQty = requested.ScalarResources[resName]
		}
		fractions = append(fractions, float64(reqQty)/float64(allocQty))
	}

	if len(fractions) == 0 {
		// The node reports neither an allocatable CPU figure nor an advertised
		// accelerator, so how loaded it is cannot be determined at all.
		return 0, signalUnknown
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

	return avgFraction * 100.0, signalDeclared
}

// noGPUFragmentationScore is the fragmentation sub-score for a node the
// operator has declared has no GPUs (greenpay.io/gpu-vendor=none,
// greenpay.io/gpu-count=0).  There is no GPU capacity to fragment, so the
// dimension does not apply and cannot count against the node.
//
// This is a declared answer, not missing metadata: an unlabelled node does not
// receive it, which is the whole point of the DeclaresNoGPU gate below.
const noGPUFragmentationScore = 100.0

// fragmentationScore computes the allocated GPU fraction for a node and
// applies a V-shaped scoring curve centered at fragThreshold.
//
// Score:
//   - 0% or 100% allocation: 100 (plenty of room OR fully packed)
//   - fragThreshold allocation: 0 (fragmented zone)
//
// The score function is a "V" shaped curve centered at s.fragThreshold.
//
// The GPU total behind that fraction comes from resolveGPUAllocation, which
// also reports how well the node's GPU capacity is known.  A node that
// advertises accelerators but carries no greenpay.io labels is scored on its
// real allocation at inferred confidence — see the missing-metadata policy —
// rather than waved through with a perfect score, and a node that reports
// nothing at all is not mistaken for one that has no GPUs.
func (s *MLWorkloadScore) fragmentationScore(ni *framework.NodeInfo, node *corev1.Node, hw hardware.NodeHardware) (float64, signalConfidence) {
	totalGPUs, allocatedGPUs, confidence := resolveGPUAllocation(ni, node, hw)

	if totalGPUs <= 0 {
		if hw.DeclaresNoGPU() {
			// The operator has characterised this node as having no GPUs, so
			// there is no GPU capacity to fragment.
			return noGPUFragmentationScore, signalDeclared
		}
		// Nothing has told us anything about this node's GPUs: no greenpay.io
		// labels, and no advertised accelerator resources either.  That is the
		// window in which a GPU node whose device plugin has not registered yet
		// is indistinguishable from a CPU node, so the policy applies.
		return 0, signalUnknown
	}

	fraction := float64(allocatedGPUs) / float64(totalGPUs)
	if fraction < 0.0 {
		fraction = 0.0
	} else if fraction > 1.0 {
		fraction = 1.0
	}

	threshold := s.fragThreshold
	if threshold <= 0.0 {
		return fraction * 100.0, confidence
	}
	if threshold >= 1.0 {
		return (1.0 - fraction) * 100.0, confidence
	}

	var score float64
	if fraction <= threshold {
		score = 100.0 * (threshold - fraction) / threshold
	} else {
		score = 100.0 * (fraction - threshold) / (1.0 - threshold)
	}

	return score, confidence
}

// resolveGPUAllocation reports a node's total GPU capacity, how much of it is
// already allocated, and how well the total is known.
//
// The two sources are independent and arrive independently: the operator's
// greenpay.io/gpu-count label is a hand-applied attestation of the node's
// physical GPUs, while the accelerator extended resources are advertised
// automatically by a device plugin some time after the node goes Ready.  The
// declared count wins when both are present — it is the physical count the rest
// of the plugin is written against — and the advertised count is the fallback
// that keeps an unlabelled GPU node scored on reality.  A total of 0 means
// neither source said anything, which the caller must not read as "no GPUs".
func resolveGPUAllocation(
	ni *framework.NodeInfo,
	node *corev1.Node,
	hw hardware.NodeHardware,
) (totalGPUs int64, allocatedGPUs int64, confidence signalConfidence) {
	confidence = signalUnknown

	if hw.HasGPU() {
		totalGPUs = hw.GPUCount
		confidence = signalDeclared
	}

	if ni != nil {
		// computeGPUCapacity is the filter plugin's capacity resolution, reused
		// here so filtering and scoring cannot disagree about how many GPUs a
		// node has or which resource names count as accelerators.
		advertisedTotal, advertisedAllocated, _ := computeGPUCapacity(ni, hw)
		allocatedGPUs = advertisedAllocated

		if totalGPUs <= 0 && advertisedTotal > 0 {
			totalGPUs = advertisedTotal
			confidence = signalInferred
		}

		if allocatedGPUs <= 0 {
			// NodeInfo.Requested only carries scalar totals once each pod has
			// been accumulated through AddPod; fall back to the node's pod list
			// when it has not.
			allocatedGPUs = allocatedGPUsFromPods(ni)
		}

		return totalGPUs, allocatedGPUs, confidence
	}

	if totalGPUs <= 0 && node != nil {
		for resName, quantity := range node.Status.Allocatable {
			if hardware.IsAcceleratorResource(resName) {
				totalGPUs += quantity.Value()
			}
		}
		if totalGPUs > 0 {
			confidence = signalInferred
		}
	}

	return totalGPUs, allocatedGPUs, confidence
}

// allocatedGPUsFromPods sums the accelerator requests of the pods already
// placed on a node.  NodeInfo.Requested carries the same total once every pod
// has been added through AddPod, so this only matters for a NodeInfo whose
// scalar totals were never accumulated.
func allocatedGPUsFromPods(ni *framework.NodeInfo) int64 {
	var allocated int64
	for _, podInfo := range ni.Pods {
		if podInfo == nil || podInfo.Pod == nil {
			continue
		}
		for _, container := range podInfo.Pod.Spec.Containers {
			for resName, quantity := range container.Resources.Requests {
				if hardware.IsAcceleratorResource(resName) {
					allocated += quantity.Value()
				}
			}
		}
	}
	return allocated
}

// numaScore scores a node by the minimum number of NUMA domains needed to
// supply the pod's requested GPUs.
//
// Strategy:
//   - A pod that is not an ML workload, or asks for no GPUs, has no NUMA
//     locality to optimise: the dimension does not apply and stays neutral.
//   - Missing or self-contradictory topology metadata is unknown and falls to
//     the missing-metadata policy; a node whose kubelet honestly declares it
//     will not enforce pod-scope alignment is a declared answer and stays
//     neutral.  See scoreNUMALocality for why those two are scored apart.
//   - restricted policy scores 100 / required NUMA domains.
//   - single-numa-node scores 100 only when all requested GPUs fit in one
//     domain, otherwise 0 because kubelet will not admit that alignment.
func (s *MLWorkloadScore) numaScore(reqs hardware.PodHardwareReqs, hw hardware.NodeHardware) (float64, signalConfidence) {
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
//
// Bandwidth is label-only — the Node API publishes no uplink figure to infer
// one from — so this dimension is either declared or unknown, and an unlabelled
// node falls to the missing-metadata policy rather than to a neutral score.
func (s *MLWorkloadScore) bandwidthScore(hw hardware.NodeHardware, bwState *clusterBandwidthState) (float64, signalConfidence) {
	if hw.NetworkBandwidthGbps <= 0 {
		// No greenpay.io/network-bandwidth label on the node.
		return 0, signalUnknown
	}

	if bwState == nil || bwState.maxGbps == 0 {
		// PreScore did not run, so there is no cluster maximum to normalise
		// against and this node's share of it cannot be determined.
		return 0, signalUnknown
	}

	return float64(hw.NetworkBandwidthGbps) / float64(bwState.maxGbps) * 100.0, signalDeclared
}
