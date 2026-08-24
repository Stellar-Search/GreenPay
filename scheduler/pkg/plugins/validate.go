package plugins

import (
	"fmt"
	"sort"

	"k8s.io/apimachinery/pkg/util/sets"
	"k8s.io/kubernetes/pkg/scheduler/apis/config"
	"k8s.io/kubernetes/pkg/scheduler/framework/runtime"
)

// ValidateRegisteredPluginsWired checks that every plugin name registered in
// registry is actually referenced by at least one profile's extension
// points (including multiPoint) in cfg.
//
// kube-scheduler's own framework construction already fails fast in the
// opposite direction — a config that references a plugin name with no
// registered factory errors at startup ("... does not exist"). It does not,
// however, catch a plugin that IS registered (a working factory exists) but
// is never referenced anywhere in the shipped config: that plugin simply
// never runs, silently. That's exactly how MLWorkloadPreemption shipped —
// registered in register.go, absent from postFilter in both config.yaml and
// the deployment.yaml ConfigMap — so this check exists to catch that class
// of mistake at startup instead of in production.
func ValidateRegisteredPluginsWired(cfg *config.KubeSchedulerConfiguration, registry runtime.Registry) error {
	referenced := sets.New[string]()
	for _, prof := range cfg.Profiles {
		if prof.Plugins == nil {
			continue
		}
		for _, ps := range extensionPointSets(prof.Plugins) {
			for _, p := range ps.Enabled {
				referenced.Insert(p.Name)
			}
		}
	}

	var missing []string
	for name := range registry {
		if !referenced.Has(name) {
			missing = append(missing, name)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	sort.Strings(missing)
	return fmt.Errorf(
		"plugin(s) %v are registered but not enabled in any profile's extension points "+
			"(multiPoint/filter/postFilter/score/etc.) in the shipped scheduler config — "+
			"wire them into a profile or remove the registration",
		missing,
	)
}

func extensionPointSets(p *config.Plugins) []config.PluginSet {
	return []config.PluginSet{
		p.PreEnqueue, p.QueueSort, p.PreFilter, p.Filter, p.PostFilter,
		p.PreScore, p.Score, p.Reserve, p.Permit, p.PreBind, p.Bind,
		p.PostBind, p.MultiPoint,
	}
}
