package plugins

import "github.com/greenpay/scheduler/pkg/hardware"

func scoreNUMALocality(reqs hardware.PodHardwareReqs, hw hardware.NodeHardware) float64 {
	if !reqs.IsMLWorkload() || reqs.GPUCountReq <= 0 {
		return 50.0
	}

	if !hw.HasValidGPUNUMATopology() || !hw.EnforcesPodNUMAAlignment() {
		return 50.0
	}

	domains, fits := hw.MinimumNUMADomainsForGPUs(reqs.GPUCountReq)
	if !fits {
		return 0.0
	}

	if hw.TopologyManagerPolicy == hardware.TopologyManagerPolicySingleNUMANode {
		if domains == 1 {
			return 100.0
		}
		return 0.0
	}

	return 100.0 / float64(domains)
}
