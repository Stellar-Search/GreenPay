package plugins

import (
	"math"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

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

			got := applyMetadataPolicy(scoreNUMALocality(reqs, hw))
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

	singleDomainScore := applyMetadataPolicy(scoreNUMALocality(reqs, singleDomain))
	fourDomainScore := applyMetadataPolicy(scoreNUMALocality(reqs, fourDomains))
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
			if got := applyMetadataPolicy(scoreNUMALocality(reqs, hw)); got != tc.want {
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
	if got := applyMetadataPolicy(scoreNUMALocality(reqs, local)); got != 100 {
		t.Errorf("single-domain numaScore() = %.1f, want 100", got)
	}

	split := topologyHardware(
		hardware.TopologyManagerPolicySingleNUMANode,
		hardware.TopologyManagerScopePod,
		[]int64{2, 2},
	)
	if got := applyMetadataPolicy(scoreNUMALocality(reqs, split)); got != 0 {
		t.Errorf("split-domain numaScore() = %.1f, want 0", got)
	}
}

// The NUMA dimension stays neutral only when it genuinely does not apply to the
// pod in front of it.  A node whose topology metadata is missing or unusable is
// a different situation and is covered by
// TestNUMAScoreTreatsUnusableTopologyAsUnknown.
func TestNUMAScoreIsNeutralWhenLocalityDoesNotApply(t *testing.T) {
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
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := applyMetadataPolicy(scoreNUMALocality(tc.reqs, tc.hw)); got != 50 {
				t.Errorf("numaScore() = %.1f, want neutral score 50", got)
			}
		})
	}
}

// A node that declares no GPU-to-NUMA topology, or declares one that
// contradicts itself, leaves the domain count undeterminable.  Under the
// missing-metadata policy that scores at the bottom of the range, not the
// neutral midpoint — otherwise an unlabelled node outranks a node honestly
// reporting a poor GPU spread, which is the inversion issue #335 is about.
func TestNUMAScoreTreatsUnusableTopologyAsUnknown(t *testing.T) {
	reqs := hardware.PodHardwareReqs{
		WorkloadType: hardware.WorkloadMLTraining,
		GPUCountReq:  4,
	}

	cases := []struct {
		name string
		hw   hardware.NodeHardware
	}{
		{
			// No greenpay.io topology labels at all: ParseNodeHardware yields
			// zero domains and a nil distribution.
			name: "no topology labels",
			hw:   hardware.NodeHardware{GPUVendor: "nvidia", GPUCount: 4},
		},
		{
			// Labels present but the distribution does not sum to gpu-count,
			// so nothing in it can be trusted.
			name: "distribution contradicts declared GPU count",
			hw: hardware.NodeHardware{
				GPUCount:              4,
				NUMANodes:             2,
				GPUNUMADistribution:   []int64{4},
				TopologyManagerPolicy: hardware.TopologyManagerPolicyRestricted,
				TopologyManagerScope:  hardware.TopologyManagerScopePod,
			},
		},
	}

	// A node that honestly reports the worst usable spread — one GPU per domain,
	// so the request needs all four — still scores above an unusable one.
	honestlyPoor := applyMetadataPolicy(scoreNUMALocality(reqs, topologyHardware(
		hardware.TopologyManagerPolicyRestricted,
		hardware.TopologyManagerScopePod,
		[]int64{1, 1, 1, 1},
	)))

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := applyMetadataPolicy(scoreNUMALocality(reqs, tc.hw))
			if got != unknownMetadataScore {
				t.Errorf("numaScore() = %.1f, want unknown-metadata score %.1f", got, unknownMetadataScore)
			}
			if got >= honestlyPoor {
				t.Errorf(
					"unusable topology scored %.1f, which is not below the honestly-poor spread %.1f",
					got, honestlyPoor,
				)
			}
		})
	}
}

// A TPU pod (google.com/tpu resource request) must produce a non-zero
// GPUCountReq and therefore exercise the NUMA locality path instead of
// silently returning its neutral value (issue #331).
func TestNUMAScore_TPUPodExercisesLocalityPath(t *testing.T) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "tpu-training",
			Namespace: "default",
			Annotations: map[string]string{
				hardware.AnnotWorkloadType: hardware.WorkloadMLTraining,
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name: "worker",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceName("google.com/tpu"): resource.MustParse("4"),
						},
					},
				},
			},
		},
	}

	reqs := hardware.ParsePodHardwareReqs(pod)
	if reqs.GPUCountReq != 4 {
		t.Fatalf("TPU pod GPUCountReq: got %d, want 4 — the locality path is bypassed", reqs.GPUCountReq)
	}

	hw := topologyHardware(
		hardware.TopologyManagerPolicySingleNUMANode,
		hardware.TopologyManagerScopePod,
		[]int64{4},
	)

	if got := applyMetadataPolicy(scoreNUMALocality(reqs, hw)); got != 100.0 {
		t.Errorf("numaScore() for TPU pod = %.1f, want 100.0 (topology fully satisfied)", got)
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
