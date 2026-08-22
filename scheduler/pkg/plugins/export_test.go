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

// BinPackingScoreForTest exposes the bin-packing sub-score.
func (s *MLWorkloadScore) BinPackingScoreForTest(ni *framework.NodeInfo) float64 {
	return s.binPackingScore(ni, hardware.ParseNodeHardware(ni.Node()))
}

// FragmentationScoreForTest exposes the GPU-fragmentation sub-score.
func (s *MLWorkloadScore) FragmentationScoreForTest(ni *framework.NodeInfo) float64 {
	node := ni.Node()
	return s.fragmentationScore(ni, node, hardware.ParseNodeHardware(node))
}
