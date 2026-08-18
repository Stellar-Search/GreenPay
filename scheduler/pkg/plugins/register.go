// Package plugins contains the plugin registration bootstrap.
//
// Call RegisterPlugins(registry) from main.go to make the GreenPay plugins
// available to the scheduler binary before it processes its KubeSchedulerProfile
// configuration.
package plugins

import (
	"k8s.io/kubernetes/pkg/scheduler/framework/runtime"
)

// RegisterPlugins registers all GreenPay scheduler plugins into the given
// registry.  This must be called before scheduler.New() so the KubeSchedulerProfile
// can reference the plugins by name.
func RegisterPlugins(registry runtime.Registry) error {
	if err := registry.Register(GPUHardwareFilterName, NewGPUHardwareFilter); err != nil {
		return err
	}
	if err := registry.Register(MLWorkloadScoreName, NewMLWorkloadScore); err != nil {
		return err
	}
	if err := registry.Register(MLWorkloadPreemptionName, NewMLWorkloadPreemption); err != nil {
		return err
	}
	return nil
}
