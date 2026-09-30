package plugins_test

import (
	"strings"
	"testing"

	"k8s.io/kubernetes/pkg/scheduler/apis/config"
	schedulerruntime "k8s.io/kubernetes/pkg/scheduler/framework/runtime"

	"github.com/greenpay/scheduler/pkg/plugins"
)

func registryWithGreenPayPlugins(t *testing.T) schedulerruntime.Registry {
	t.Helper()
	registry := schedulerruntime.Registry{}
	if err := plugins.RegisterPlugins(registry); err != nil {
		t.Fatalf("RegisterPlugins: %v", err)
	}
	return registry
}

// TestValidateRegisteredPluginsWired_CatchesUnwiredPlugin reproduces the
// exact shape of the bug this check exists for: MLWorkloadPreemption is
// registered (a working factory exists in the registry) but no profile's
// postFilter (or any other extension point) references it — it would
// silently never run. The check must fail fast instead.
func TestValidateRegisteredPluginsWired_CatchesUnwiredPlugin(t *testing.T) {
	cfg := &config.KubeSchedulerConfiguration{
		Profiles: []config.KubeSchedulerProfile{
			{
				SchedulerName: "greenpay-scheduler",
				Plugins: &config.Plugins{
					Filter: config.PluginSet{Enabled: []config.Plugin{{Name: plugins.GPUHardwareFilterName}}},
					Score:  config.PluginSet{Enabled: []config.Plugin{{Name: plugins.MLWorkloadScoreName}}},
					// PostFilter intentionally omitted — MLWorkloadPreemption
					// is registered but unwired, matching the original bug.
				},
			},
		},
	}

	err := plugins.ValidateRegisteredPluginsWired(cfg, registryWithGreenPayPlugins(t))
	if err == nil {
		t.Fatal("expected an error for an unwired registered plugin, got nil")
	}
	if !strings.Contains(err.Error(), plugins.MLWorkloadPreemptionName) {
		t.Errorf("error %q does not name the unwired plugin %q", err.Error(), plugins.MLWorkloadPreemptionName)
	}
}

// TestValidateRegisteredPluginsWired_PassesWhenFullyWired mirrors the fixed
// k8s/scheduler/config.yaml: every registered plugin appears in some
// extension point (postFilter for MLWorkloadPreemption specifically).
func TestValidateRegisteredPluginsWired_PassesWhenFullyWired(t *testing.T) {
	cfg := &config.KubeSchedulerConfiguration{
		Profiles: []config.KubeSchedulerProfile{
			{
				SchedulerName: "greenpay-scheduler",
				Plugins: &config.Plugins{
					Filter:     config.PluginSet{Enabled: []config.Plugin{{Name: plugins.GPUHardwareFilterName}}},
					PostFilter: config.PluginSet{Enabled: []config.Plugin{{Name: plugins.MLWorkloadPreemptionName}}},
					Score:      config.PluginSet{Enabled: []config.Plugin{{Name: plugins.MLWorkloadScoreName}}},
				},
			},
		},
	}

	if err := plugins.ValidateRegisteredPluginsWired(cfg, registryWithGreenPayPlugins(t)); err != nil {
		t.Errorf("expected no error for a fully-wired config, got: %v", err)
	}
}

// TestValidateRegisteredPluginsWired_MultiPointCounts confirms a plugin
// wired only via multiPoint (rather than a specific extension point) still
// counts as referenced — multiPoint is a normal, supported way to enable a
// plugin, not a gap the check should flag.
func TestValidateRegisteredPluginsWired_MultiPointCounts(t *testing.T) {
	cfg := &config.KubeSchedulerConfiguration{
		Profiles: []config.KubeSchedulerProfile{
			{
				SchedulerName: "greenpay-scheduler",
				Plugins: &config.Plugins{
					MultiPoint: config.PluginSet{Enabled: []config.Plugin{
						{Name: plugins.GPUHardwareFilterName},
						{Name: plugins.MLWorkloadPreemptionName},
						{Name: plugins.MLWorkloadScoreName},
					}},
				},
			},
		},
	}

	if err := plugins.ValidateRegisteredPluginsWired(cfg, registryWithGreenPayPlugins(t)); err != nil {
		t.Errorf("expected multiPoint-wired plugins to satisfy the check, got: %v", err)
	}
}
