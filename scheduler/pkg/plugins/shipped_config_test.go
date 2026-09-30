package plugins_test

import (
	"io"
	"os"
	"testing"

	"gopkg.in/yaml.v3"
	"k8s.io/kubernetes/pkg/scheduler/apis/config"
	kubeschedulerscheme "k8s.io/kubernetes/pkg/scheduler/apis/config/scheme"

	"github.com/greenpay/scheduler/pkg/plugins"
)

// These paths are relative to this package's directory, which is also `go
// test`'s working directory.
const (
	standaloneConfigPath = "../../../k8s/scheduler/config.yaml"
	deploymentPath       = "../../../k8s/scheduler/deployment.yaml"
)

func decodeKubeSchedulerConfig(t *testing.T, data []byte) *config.KubeSchedulerConfiguration {
	t.Helper()
	obj, _, err := kubeschedulerscheme.Codecs.UniversalDecoder().Decode(data, nil, nil)
	if err != nil {
		t.Fatalf("decoding KubeSchedulerConfiguration: %v", err)
	}
	cfg, ok := obj.(*config.KubeSchedulerConfiguration)
	if !ok {
		t.Fatalf("decoded object is %T, want *config.KubeSchedulerConfiguration", obj)
	}
	return cfg
}

// extractInlinedSchedulerConfig pulls the `data["scheduler-config.yaml"]`
// string out of the ConfigMap document embedded in deployment.yaml — the
// same file the deployment actually mounts into the container, and the
// thing that must stay in sync with the standalone config.yaml.
func extractInlinedSchedulerConfig(t *testing.T) string {
	t.Helper()
	f, err := os.Open(deploymentPath)
	if err != nil {
		t.Fatalf("opening %s: %v", deploymentPath, err)
	}
	defer f.Close()

	dec := yaml.NewDecoder(f)
	for {
		var doc struct {
			Kind string            `yaml:"kind"`
			Data map[string]string `yaml:"data"`
		}
		err := dec.Decode(&doc)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("decoding a document from %s: %v", deploymentPath, err)
		}
		if doc.Kind == "ConfigMap" {
			cfg, ok := doc.Data["scheduler-config.yaml"]
			if !ok {
				t.Fatalf("ConfigMap in %s has no data[scheduler-config.yaml] key", deploymentPath)
			}
			return cfg
		}
	}
	t.Fatalf("no ConfigMap document found in %s", deploymentPath)
	return ""
}

// TestShippedConfig_StandaloneFile_WiresEveryRegisteredPlugin decodes the
// real k8s/scheduler/config.yaml this repo ships and checks it through the
// same validator main.go runs at startup — see plugins.ValidateRegisteredPluginsWired.
// This is the config.yaml half of the original bug: MLWorkloadPreemption was
// registered in code but absent from postFilter here.
func TestShippedConfig_StandaloneFile_WiresEveryRegisteredPlugin(t *testing.T) {
	data, err := os.ReadFile(standaloneConfigPath)
	if err != nil {
		t.Fatalf("reading %s: %v", standaloneConfigPath, err)
	}
	cfg := decodeKubeSchedulerConfig(t, data)

	registry := registryWithGreenPayPlugins(t)
	if err := plugins.ValidateRegisteredPluginsWired(cfg, registry); err != nil {
		t.Errorf("%s: %v", standaloneConfigPath, err)
	}
}

// TestShippedConfig_InlinedConfigMap_WiresEveryRegisteredPlugin is the
// deployment.yaml half of the same check — the inlined ConfigMap is what
// the running scheduler actually mounts and reads, and it drifted from
// config.yaml independently in the original bug (neither had postFilter).
func TestShippedConfig_InlinedConfigMap_WiresEveryRegisteredPlugin(t *testing.T) {
	cfg := decodeKubeSchedulerConfig(t, []byte(extractInlinedSchedulerConfig(t)))

	registry := registryWithGreenPayPlugins(t)
	if err := plugins.ValidateRegisteredPluginsWired(cfg, registry); err != nil {
		t.Errorf("%s (inlined ConfigMap): %v", deploymentPath, err)
	}
}
