package plugins

import (
	"k8s.io/kubernetes/pkg/scheduler/framework"

	"github.com/greenpay/scheduler/pkg/hardware"
)

// This file is compiled only for tests (Go treats `export_test.go` as part of
// package `plugins` but excludes it from normal builds), which lets the
// external `plugins_test` package assert on individual sub-score heuristics.
//
// Testing a heuristic's shape through the public Score() composite does not
// work: Score() is a weighted sum of four sub-scores, and moving the input
// that one heuristic reacts to (e.g. GPU allocation fraction) usually moves
// another at the same time. The bin-packing term in particular rises
// monotonically with utilisation and carries the largest weight, so it masks
// the fragmentation term's V-curve entirely. Each heuristic therefore has to
// be exercised directly.

// Each accessor applies the missing-metadata policy the same way Score() does,
// so a test sees the value the sub-score actually contributes to a placement
// decision rather than its undiscounted measurement.

// BinPackingScoreForTest exposes the bin-packing sub-score.
func (s *MLWorkloadScore) BinPackingScoreForTest(ni *framework.NodeInfo) float64 {
	return applyMetadataPolicy(s.binPackingScore(ni, hardware.ParseNodeHardware(ni.Node())))
}

// FragmentationScoreForTest exposes the GPU-fragmentation sub-score.
func (s *MLWorkloadScore) FragmentationScoreForTest(ni *framework.NodeInfo) float64 {
	node := ni.Node()
	return applyMetadataPolicy(s.fragmentationScore(ni, node, hardware.ParseNodeHardware(node)))
}

// NUMAScoreForTest exposes the NUMA-locality sub-score.
func (s *MLWorkloadScore) NUMAScoreForTest(reqs hardware.PodHardwareReqs, ni *framework.NodeInfo) float64 {
	return applyMetadataPolicy(s.numaScore(reqs, hardware.ParseNodeHardware(ni.Node())))
}

// BandwidthScoreForTest exposes the network-bandwidth sub-score, normalised
// against clusterMaxGbps.  The cluster-maximum state PreScore writes is
// unexported, so an external test cannot reach this sub-score any other way.
// Pass clusterMaxGbps = 0 to simulate PreScore not having run.
func (s *MLWorkloadScore) BandwidthScoreForTest(ni *framework.NodeInfo, clusterMaxGbps int64) float64 {
	return applyMetadataPolicy(s.bandwidthScore(
		hardware.ParseNodeHardware(ni.Node()),
		&clusterBandwidthState{maxGbps: clusterMaxGbps},
	))
}
