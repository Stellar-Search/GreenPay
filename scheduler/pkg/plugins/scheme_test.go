package plugins_test

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/kubernetes/pkg/scheduler/apis/config"
	kubeschedulerscheme "k8s.io/kubernetes/pkg/scheduler/apis/config/scheme"

	"github.com/greenpay/scheduler/pkg/plugins"
)

// TestMLWorkloadScoreArgs_DecodedFromRealSchedulerConfig exercises the exact
// pipeline the shipped scheduler binary uses: decode a full
// KubeSchedulerConfiguration YAML document (the same one main.go loads via
// --config) through the real kube-scheduler config scheme, then hand the
// resulting PluginConfig.Args straight to NewMLWorkloadScore. Before
// scheme.go registered MLWorkloadScoreArgs, Args here decoded to
// *runtime.Unknown, the type assertion in NewMLWorkloadScore always failed,
// and a configured fragThreshold was silently ignored in favor of the 0.85
// default — this test would have caught that.
func TestMLWorkloadScoreArgs_DecodedFromRealSchedulerConfig(t *testing.T) {
	data := []byte(`
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
- schedulerName: greenpay-scheduler
  pluginConfig:
  - name: MLWorkloadScore
    args:
      fragThreshold: 0.6
`)

	obj, _, err := kubeschedulerscheme.Codecs.UniversalDecoder().Decode(data, nil, nil)
	if err != nil {
		t.Fatalf("decoding scheduler config: %v", err)
	}
	cfg, ok := obj.(*config.KubeSchedulerConfiguration)
	if !ok {
		t.Fatalf("decoded object is not a KubeSchedulerConfiguration: %T", obj)
	}

	var args interface{}
	for _, pc := range cfg.Profiles[0].PluginConfig {
		if pc.Name == plugins.MLWorkloadScoreName {
			args = pc.Args
		}
	}
	scoreArgs, ok := args.(*plugins.MLWorkloadScoreArgs)
	if !ok {
		t.Fatalf("MLWorkloadScore args decoded to %T, want *plugins.MLWorkloadScoreArgs (this is the exact "+
			"bug: an unregistered args type decodes to *runtime.Unknown and NewMLWorkloadScore's assertion "+
			"always fails)", args)
	}
	if scoreArgs.FragThreshold != 0.6 {
		t.Errorf("decoded fragThreshold = %v, want 0.6", scoreArgs.FragThreshold)
	}

	p, err := plugins.NewMLWorkloadScore(context.Background(), scoreArgs, nil)
	if err != nil {
		t.Fatalf("NewMLWorkloadScore: %v", err)
	}
	plugin := p.(*plugins.MLWorkloadScore)
	if plugin.FragThreshold() != 0.6 {
		t.Errorf("plugin.FragThreshold() = %v, want 0.6 (configured value never reached the plugin)", plugin.FragThreshold())
	}
}

// TestMLWorkloadScoreArgs_DecodedFromRealSchedulerConfig_DefaultsWhenOmitted
// covers a profile that enables MLWorkloadScore with no pluginConfig entry
// at all — the scheme's registered defaulting func (see scheme.go) must
// still produce the plugin's 0.85 default via the real config-loading path.
func TestMLWorkloadScoreArgs_DecodedFromRealSchedulerConfig_DefaultsWhenOmitted(t *testing.T) {
	data := []byte(`
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
- schedulerName: greenpay-scheduler
  plugins:
    score:
      enabled:
      - name: MLWorkloadScore
`)

	obj, _, err := kubeschedulerscheme.Codecs.UniversalDecoder().Decode(data, nil, nil)
	if err != nil {
		t.Fatalf("decoding scheduler config: %v", err)
	}
	cfg := obj.(*config.KubeSchedulerConfiguration)

	var args interface{}
	for _, pc := range cfg.Profiles[0].PluginConfig {
		if pc.Name == plugins.MLWorkloadScoreName {
			args = pc.Args
		}
	}
	scoreArgs, ok := args.(*plugins.MLWorkloadScoreArgs)
	if !ok {
		t.Fatalf("MLWorkloadScore args decoded to %T, want *plugins.MLWorkloadScoreArgs", args)
	}
	if scoreArgs.FragThreshold != 0.85 {
		t.Errorf("defaulted fragThreshold = %v, want 0.85", scoreArgs.FragThreshold)
	}
}

func TestMLWorkloadScoreArgs_DeepCopyObject_PreservesTypeMeta(t *testing.T) {
	in := &plugins.MLWorkloadScoreArgs{
		TypeMeta:      metav1.TypeMeta{Kind: "MLWorkloadScoreArgs", APIVersion: "kubescheduler.config.k8s.io/v1"},
		FragThreshold: 0.6,
	}

	out, ok := in.DeepCopyObject().(*plugins.MLWorkloadScoreArgs)
	if !ok {
		t.Fatalf("DeepCopyObject() returned %T, want *plugins.MLWorkloadScoreArgs", in.DeepCopyObject())
	}
	if out.TypeMeta != in.TypeMeta {
		t.Errorf("DeepCopyObject() dropped TypeMeta: got %+v, want %+v", out.TypeMeta, in.TypeMeta)
	}
	if out.FragThreshold != in.FragThreshold {
		t.Errorf("DeepCopyObject() FragThreshold = %v, want %v", out.FragThreshold, in.FragThreshold)
	}

	// Mutating the copy must not affect the original.
	out.FragThreshold = 0.1
	if in.FragThreshold != 0.6 {
		t.Errorf("mutating the copy changed the original: in.FragThreshold = %v", in.FragThreshold)
	}
}
