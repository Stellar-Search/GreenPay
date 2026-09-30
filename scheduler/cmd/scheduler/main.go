// Binary greenpay-scheduler is a custom Kubernetes scheduler built on top of
// the upstream scheduler-plugins framework.  It extends the default scheduler
// with two GreenPay-specific plugins:
//
//   - GPUHardwareFilter — hard-constraint filter for GPU/TPU hardware matching
//   - MLWorkloadScore   — composite scoring for ML workload bin-packing
//
// The binary is a drop-in replacement for kube-scheduler and accepts the same
// flags and configuration file format.  The only addition is the plugin
// registration before the scheduler is started.
//
// # Running
//
//	greenpay-scheduler \
//	  --config=/etc/kubernetes/greenpay-scheduler-config.yaml \
//	  --v=4
//
// The scheduler config references the plugins by name in
// KubeSchedulerProfile.plugins sections.
package main

import (
	"math/rand"
	"os"
	"time"

	"github.com/spf13/cobra"
	"k8s.io/component-base/cli"
	_ "k8s.io/component-base/logs/json/register" // register JSON log format
	"k8s.io/klog/v2"
	"k8s.io/kubernetes/cmd/kube-scheduler/app"
	"k8s.io/kubernetes/cmd/kube-scheduler/app/options"
	schedulerruntime "k8s.io/kubernetes/pkg/scheduler/framework/runtime"

	"github.com/greenpay/scheduler/pkg/plugins"
)

func main() {
	// Seed the global random source — the scheduler framework uses it for
	// jitter in backoff loops.
	rand.Seed(time.Now().UnixNano()) //nolint:staticcheck // pre-Go1.20 compat

	// Build the scheduler command with our out-of-tree plugins.
	command := app.NewSchedulerCommand(
		plugins.RegisterPlugins,
	)

	failFastOnUnwiredPlugins(command)

	// cli.Run handles flag parsing, signal handling, and os.Exit.
	code := cli.Run(command)
	os.Exit(code)
}

// failFastOnUnwiredPlugins wraps the command's RunE so that, once flags are
// parsed, it loads --config and checks that every GreenPay plugin is
// actually wired into a profile before the scheduler starts serving — see
// plugins.ValidateRegisteredPluginsWired for why kube-scheduler's own
// startup validation doesn't already catch this.
func failFastOnUnwiredPlugins(command *cobra.Command) {
	next := command.RunE
	command.RunE = func(cmd *cobra.Command, args []string) error {
		configFile, err := cmd.Flags().GetString("config")
		if err == nil && configFile != "" {
			cfg, err := options.LoadConfigFromFile(klog.Background(), configFile)
			if err != nil {
				return err
			}
			registry := schedulerruntime.Registry{}
			if err := plugins.RegisterPlugins(registry); err != nil {
				return err
			}
			if err := plugins.ValidateRegisteredPluginsWired(cfg, registry); err != nil {
				return err
			}
		}
		return next(cmd, args)
	}
}
