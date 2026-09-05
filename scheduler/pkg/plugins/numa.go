package plugins

import "github.com/greenpay/scheduler/pkg/hardware"

// numaNotApplicableScore is the NUMA sub-score for a pod or node the dimension
// does not apply to: a pod that asks for no GPUs has no NUMA locality to
// optimise, and a node whose kubelet declares it will not enforce pod-scope
// alignment cannot honour one either.
//
// Both are answers rather than gaps, so they keep the neutral score instead of
// the missing-metadata policy's — see that policy in score.go.
const numaNotApplicableScore = 50.0

// scoreNUMALocality scores how tightly the pod's requested GPUs fit into the
// node's declared NUMA domains, and reports how well the inputs behind that
// score are known.  The caller turns the pair into a score through
// applyMetadataPolicy.
func scoreNUMALocality(reqs hardware.PodHardwareReqs, hw hardware.NodeHardware) (float64, signalConfidence) {
	if !reqs.IsMLWorkload() || reqs.GPUCountReq <= 0 {
		// Nothing to align: the pod does not ask for GPUs.
		return numaNotApplicableScore, signalDeclared
	}

	// These next two conditions used to collapse into one neutral score, which
	// is what let an unlabelled node outrank a node honestly reporting a poor
	// GPU-to-domain spread.  They are different situations and are scored apart.

	// The node's GPU-to-NUMA-domain layout is absent or self-contradictory, so
	// the domain count this score is built on cannot be determined.  There is no
	// runtime source to fall back on: the Node API does not publish GPU NUMA
	// affinity, which is why the distribution is an operator attestation in the
	// first place.
	if !hw.HasValidGPUNUMATopology() {
		return 0, signalUnknown
	}

	// The topology is known and says kubelet will not enforce pod-scope
	// alignment.  That is a declared fact about the node, not a gap: the
	// scheduler cannot predict how the GPUs will be aligned, but it is not
	// missing any metadata either.
	if !hw.EnforcesPodNUMAAlignment() {
		return numaNotApplicableScore, signalDeclared
	}

	domains, fits := hw.MinimumNUMADomainsForGPUs(reqs.GPUCountReq)
	if !fits {
		return 0.0, signalDeclared
	}

	if hw.TopologyManagerPolicy == hardware.TopologyManagerPolicySingleNUMANode {
		if domains == 1 {
			return 100.0, signalDeclared
		}
		return 0.0, signalDeclared
	}

	return 100.0 / float64(domains), signalDeclared
}
