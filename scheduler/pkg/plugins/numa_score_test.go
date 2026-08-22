package plugins

import (
	"math"
	"testing"

	"github.com/greenpay/scheduler/pkg/hardware"
)

func TestNUMAScoreAccountsForGPURequestAndDistribution(t *testing.T) {
	cases := []struct {
		name         string
		requestedGPU int64
		distribution []int64
		want         float64
	}{
		{
			name:         "four GPUs fit one domain",
			requestedGPU: 4,
			distribution: []int64{4, 0, 0, 0},
			want:         100,
		},
		{
			name:         "four GPUs require two domains",
			requestedGPU: 4,
			distribution: []int64{2, 2, 0, 0},
			want:         50,
		},
		{
			name:         "four GPUs require four domains",
			requestedGPU: 4,
			distribution: []int64{1, 1, 1, 1},
			want:         25,
		},
		{
			name:         "request exceeds declared topology",
			requestedGPU: 5,
			distribution: []int64{2, 2},
			want:         0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hw := topologyHardware(
				hardware.TopologyManagerPolicyRestricted,
				hardware.TopologyManagerScopePod,
				tc.distribution,
			)
			reqs := hardware.PodHardwareReqs{
				WorkloadType: hardware.WorkloadMLTraining,
				GPUCountReq:  tc.requestedGPU,
			}

			got := scoreNUMALocality(reqs, hw)
			if math.Abs(got-tc.want) > 0.001 {
				t.Errorf("numaScore() = %.3f, want %.3f", got, tc.want)
			}
		})
	}
}

func TestNUMAScoreDoesNotRewardUnusedDomains(t *testing.T) {
	reqs := hardware.PodHardwareReqs{
		WorkloadType: hardware.WorkloadMLTraining,
		GPUCountReq:  1,
	}

	singleDomain := topologyHardware(
		hardware.TopologyManagerPolicyRestricted,
		hardware.TopologyManagerScopePod,
		[]int64{1},
	)
	fourDomains := topologyHardware(
		hardware.TopologyManagerPolicyRestricted,
		hardware.TopologyManagerScopePod,
		[]int64{1, 1, 1, 1},
	)

	singleDomainScore := scoreNUMALocality(reqs, singleDomain)
	fourDomainScore := scoreNUMALocality(reqs, fourDomains)
	if singleDomainScore != fourDomainScore {
		t.Errorf(
			"one-GPU scores differ: single domain %.1f, four domains %.1f",
			singleDomainScore,
			fourDomainScore,
		)
	}
}

func TestNUMAScoreRequiresEnforcedPodAlignment(t *testing.T) {
	reqs := hardware.PodHardwareReqs{
		WorkloadType: hardware.WorkloadMLInference,
		GPUCountReq:  2,
	}

	cases := []struct {
		name   string
		policy string
		scope  string
		want   float64
	}{
		{
			name:   "restricted pod scope uses topology",
			policy: hardware.TopologyManagerPolicyRestricted,
			scope:  hardware.TopologyManagerScopePod,
			want:   100,
		},
		{
			name:   "best effort is not guaranteed",
			policy: hardware.TopologyManagerPolicyBestEffort,
			scope:  hardware.TopologyManagerScopePod,
			want:   50,
		},
		{
			name:   "container scope does not match pod request",
			policy: hardware.TopologyManagerPolicyRestricted,
			scope:  hardware.TopologyManagerScopeContainer,
			want:   50,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hw := topologyHardware(tc.policy, tc.scope, []int64{2, 0})
			if got := scoreNUMALocality(reqs, hw); got != tc.want {
				t.Errorf("numaScore() = %.1f, want %.1f", got, tc.want)
			}
		})
	}
}

func TestNUMAScoreHonorsSingleNUMANodePolicy(t *testing.T) {
	reqs := hardware.PodHardwareReqs{
		WorkloadType: hardware.WorkloadMLBatch,
		GPUCountReq:  4,
	}

	local := topologyHardware(
		hardware.TopologyManagerPolicySingleNUMANode,
		hardware.TopologyManagerScopePod,
		[]int64{4, 0},
	)
	if got := scoreNUMALocality(reqs, local); got != 100 {
		t.Errorf("single-domain numaScore() = %.1f, want 100", got)
	}

	split := topologyHardware(
		hardware.TopologyManagerPolicySingleNUMANode,
		hardware.TopologyManagerScopePod,
		[]int64{2, 2},
	)
	if got := scoreNUMALocality(reqs, split); got != 0 {
		t.Errorf("split-domain numaScore() = %.1f, want 0", got)
	}
}

func TestNUMAScoreFallsBackToNeutralWithoutUsableTopology(t *testing.T) {
	validTopology := topologyHardware(
		hardware.TopologyManagerPolicyRestricted,
		hardware.TopologyManagerScopePod,
		[]int64{4},
	)

	cases := []struct {
		name string
		reqs hardware.PodHardwareReqs
		hw   hardware.NodeHardware
	}{
		{
			name: "non ML workload",
			reqs: hardware.PodHardwareReqs{
				WorkloadType: hardware.WorkloadAPI,
				GPUCountReq:  1,
			},
			hw: validTopology,
		},
		{
			name: "no GPU request",
			reqs: hardware.PodHardwareReqs{
				WorkloadType: hardware.WorkloadMLTraining,
			},
			hw: validTopology,
		},
		{
			name: "invalid distribution",
			reqs: hardware.PodHardwareReqs{
				WorkloadType: hardware.WorkloadMLTraining,
				GPUCountReq:  2,
			},
			hw: hardware.NodeHardware{
				GPUCount:              4,
				NUMANodes:             2,
				GPUNUMADistribution:   []int64{4},
				TopologyManagerPolicy: hardware.TopologyManagerPolicyRestricted,
				TopologyManagerScope:  hardware.TopologyManagerScopePod,
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := scoreNUMALocality(tc.reqs, tc.hw); got != 50 {
				t.Errorf("numaScore() = %.1f, want neutral score 50", got)
			}
		})
	}
}

func topologyHardware(policy, scope string, distribution []int64) hardware.NodeHardware {
	var gpuCount int64
	for _, count := range distribution {
		gpuCount += count
	}

	return hardware.NodeHardware{
		GPUCount:              gpuCount,
		NUMANodes:             int64(len(distribution)),
		GPUNUMADistribution:   distribution,
		TopologyManagerPolicy: policy,
		TopologyManagerScope:  scope,
	}
}
