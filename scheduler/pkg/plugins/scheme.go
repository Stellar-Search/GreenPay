package plugins

import (
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	kubeschedulerscheme "k8s.io/kubernetes/pkg/scheduler/apis/config/scheme"
	kubeschedulerconfigv1 "k8s.io/kubernetes/pkg/scheduler/apis/config/v1"
)

// ArgsGroupVersion is the KubeSchedulerConfiguration API group/version under
// which pluginConfig[].args blocks are declared. It must match the
// apiVersion used in k8s/scheduler/config.yaml and deployment.yaml.
var ArgsGroupVersion = schema.GroupVersion{Group: "kubescheduler.config.k8s.io", Version: "v1"}

func init() {
	registerArgsScheme()
}

// registerArgsScheme makes MLWorkloadScoreArgs decodable from a profile's
// `pluginConfig[].args` block.
//
// kube-scheduler resolves each pluginConfig entry's args by convention —
// KubeSchedulerConfiguration.DecodeNestedObjects looks up GVK
// {ArgsGroupVersion, Kind: "<plugin name>Args"} in the scheduler's shared
// config scheme (k8s.io/kubernetes/pkg/scheduler/apis/config/scheme.Scheme).
// Without a matching registration, that lookup fails and args are left as
// *runtime.Unknown (raw, undecoded bytes) — which is exactly why the type
// assertion in NewMLWorkloadScore always failed before this fix, silently
// ignoring any configured fragThreshold.
//
// A second, separate scheme (returned by configv1.GetPluginArgConversionScheme,
// used by the v1->internal KubeSchedulerConfiguration conversion step and by
// its defaulting pass) independently needs the type registered under both
// its external (v1) and internal group versions before it will convert or
// default a decoded args value instead of leaving it as *runtime.Unknown too.
// Both registrations use the same Go struct for the external and internal
// representation — no separate conversion function is required, since
// apimachinery falls back to a direct copy when converting between two
// registered versions of an identical type.
func registerArgsScheme() {
	gvk := ArgsGroupVersion.WithKind(MLWorkloadScoreName + "Args")
	internalGV := schema.GroupVersion{Group: ArgsGroupVersion.Group, Version: runtime.APIVersionInternal}

	kubeschedulerscheme.Scheme.AddKnownTypes(gvk.GroupVersion(), &MLWorkloadScoreArgs{})

	argScheme := kubeschedulerconfigv1.GetPluginArgConversionScheme()
	argScheme.AddKnownTypes(gvk.GroupVersion(), &MLWorkloadScoreArgs{})
	argScheme.AddKnownTypes(internalGV, &MLWorkloadScoreArgs{})
	argScheme.AddTypeDefaultingFunc(&MLWorkloadScoreArgs{}, func(obj interface{}) {
		SetDefaults_MLWorkloadScoreArgs(obj.(*MLWorkloadScoreArgs))
	})
}
