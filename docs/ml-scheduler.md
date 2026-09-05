# GreenPay ML-Aware Kubernetes Scheduler

## Why a custom scheduler?

The default `kube-scheduler` uses a generic scoring model based on CPU/memory
utilisation.  For ML workloads that consume GPUs, require specific VRAM
budgets, and benefit from NVLink interconnects or NUMA-local memory, the
default model leaves expensive capacity stranded.

Observed problems before this feature:
- A 7B inference pod landing on an A100 node (wasting 73 GiB of idle VRAM) when T4 nodes were available.
- A training job splitting across two nodes because the scheduler couldn't see that NVLink locality mattered.
- CPU-only summary workers competing with GPU inference pods for the same physical node.

The `greenpay-scheduler` runs **alongside** the default scheduler as a second
profile.  Only pods that explicitly opt-in via `schedulerName: greenpay-scheduler`
in their `spec` are handled by it — all other workloads continue to use
`kube-scheduler`.

---

## Architecture

```
Pod (schedulerName: greenpay-scheduler)
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│               Scheduling Framework Cycle                     │
│                                                              │
│  1. Filter Phase                                             │
│     NodeResourcesFit  → removes nodes without CPU/memory    │
│     NodeAffinity      → nodeSelector / affinityRules        │
│     TaintToleration   → checks tolerations                  │
│     NodeUnschedulable → skips cordoned nodes                 │
│     VolumeBinding     → checks PVC availability             │
│     GPUHardwareFilter → checks GPU vendor/model/VRAM/zone   │ ← custom
│                                                              │
│  2. PreScore Phase                                           │
│     MLWorkloadScore.PreScore → computes cluster-wide        │ ← custom
│                                max bandwidth (normaliser)   │
│                                                              │
│  3. Score Phase (per surviving node, 0–100)                  │
│     NodeResourcesFit  (weight 1) → least-allocated tie-break │
│     MLWorkloadScore   (weight 10) → composite ML score      │ ← custom
│       A. BinPacking       (w=0.40) GPU density              │
│       B. Fragmentation    (w=0.25) anti-fragmentation       │
│       C. NUMATopology     (w=0.20) GPU/NUMA locality        │
│       D. NetworkBandwidth (w=0.15) bandwidth normalisation  │
│                                                              │
│  4. NormalizeScore Phase                                     │
│     MLWorkloadScore.NormalizeScore → rescales to [0, 100]   │ ← custom
│                                                              │
│  5. Reserve / Bind → assigns pod to winning node            │
└──────────────────────────────────────────────────────────────┘
```

---

## Plugin reference

### GPUHardwareFilter (Filter)

Hard constraints.  A node is **removed from consideration** if any check fails.

| Check | Pod annotation | Node label | Failure message |
|---|---|---|---|
| GPU vendor | `greenpay.io/gpu-vendor-req` | `greenpay.io/gpu-vendor` | vendor mismatch |
| GPU model | `greenpay.io/gpu-model-req` | `greenpay.io/gpu-model` | model mismatch |
| VRAM floor | `greenpay.io/gpu-vram-min-mib` | `greenpay.io/gpu-vram-mib` | VRAM too low |
| Network zone | `greenpay.io/network-zone-req` | `greenpay.io/network-zone` | zone mismatch |
| Bandwidth floor | `greenpay.io/network-bw-min-gbps` | `greenpay.io/network-bandwidth` | bandwidth too low |

Set vendor to `"any"` or omit the annotation to skip vendor/model filtering.

### MLWorkloadScore (PreScore + Score + NormalizeScore)

Composite scoring across four dimensions.

**A. BinPacking (weight 0.40)**

Rewards nodes already running ML pods so GPU capacity is packed tightly.
Score = `(usedCPU / totalCPU) × 100` (CPU used as proxy for general node
pressure; GPU-specific density requires DCGM metrics).

**B. Fragmentation (weight 0.25)**

Penalises nodes in the "dangerous middle" of GPU allocation — nearly full but
not enough room for a new training job.  Score is a V-curve centred on
`fragThreshold` (default `0.85`): an empty node and a fully packed node both
score 100, and allocation at the threshold scores 0.

The node's GPU total is taken from `greenpay.io/gpu-count` when it is present,
and otherwise from the accelerator extended resources a device plugin
advertises — so an unlabelled GPU node is scored on its real allocation rather
than skipped.  See [Missing metadata](#missing-metadata) for how the two
sources are weighted, and for what a node reporting neither one scores.

**C. NUMATopology (weight 0.20)**

For GPU-backed ML workloads, the scheduler reads the pod's effective GPU
request from extended resources such as `nvidia.com/gpu` and compares it with
the node's `greenpay.io/gpu-numa-distribution`.

| Kubelet policy | Strategy |
|---|---|
| `restricted` with `pod` scope | Score `100 / minimum NUMA domains needed` |
| `single-numa-node` with `pod` scope | Score 100 when all requested GPUs fit one domain, otherwise 0 |
| `none`, `best-effort`, or container scope | Neutral (50), because pod-level alignment is not guaranteed |
| Missing or self-contradictory topology labels | Unknown — see [Missing metadata](#missing-metadata) |

Pods that request no GPUs, and non-ML workloads, also receive the neutral NUMA
score: there is no locality to optimise for them.  That is different from a node
whose topology labels are absent, where the domain count cannot be determined at
all.

**D. NetworkBandwidth (weight 0.15)**

Normalises node bandwidth against cluster maximum.  Score = `(nodeBW / clusterMaxBW) × 100`.
A node with no `greenpay.io/network-bandwidth` label has no uplink figure to
normalise — the Node API publishes none to fall back on — so it is scored as
unknown; see [Missing metadata](#missing-metadata).

### Missing metadata

The `greenpay.io` labels are applied by hand, so an unlabelled node is not a
brief startup state: it is the default state of every node until an operator
labels it, and an autoscaled node may never be labelled at all.  All four
sub-scores therefore share one rule — **a sub-score may claim only as much of
its range as its inputs justify**:

| Confidence | Source | Scored |
|---|---|---|
| Declared | a `greenpay.io` label, or a resource kubelet reports on the node | the measured value, full range |
| Inferred | accelerator extended resources advertised by a device plugin | the measured value × `0.75` |
| Unknown | nothing determines the dimension | `0` |

**Unknown scores 0, not the neutral 50 it used to.**  The rule the policy has to
hold is that a node nothing is known about must not outrank a node that honestly
reports poor characteristics — and honest scores span the whole `[0, 100]` range,
so 0 is the only value that satisfies it for *every* honest node.  Any middling
"unknown" band would still beat every honest node scoring below it.

Inferred signals are discounted rather than trusted outright because advertised
accelerators are not the physical GPU count a label declares: kubelet drops
unhealthy devices from allocatable, a device plugin may still be registering,
and MIG or time-slicing advertises slices rather than GPUs.  A node whose only
two working GPUs are both busy should not be read as "perfectly packed".

Two things this rule deliberately does *not* cover, because they are answers
rather than gaps: a node the operator has declared CPU-only (`gpu-vendor=none`,
`gpu-count=0`) has no GPU capacity to fragment and keeps its full fragmentation
score, and a node whose kubelet declares it will not enforce pod-scope alignment
keeps the neutral NUMA score.

Scoring is a preference, not an admission check.  A node scoring 0 here stays
schedulable and simply ranks last, and it re-scores on its own as soon as either
its labels or its extended resources appear.  **If your nodes are unlabelled,
label them** — `k8s/ml-workloads/node-labels.yaml` has the commands.

**BinPackWeight multiplier**

The pod annotation `greenpay.io/bin-pack-weight` (default `1.0`) multiplies
the final composite score.  Use `>1.0` to aggressively consolidate; use `<1.0`
to spread replicas across nodes.

---

## Node labels

Apply these labels to your nodes with `kubectl label node <name> <key>=<value>`.

| Label | Values | Example |
|---|---|---|
| `greenpay.io/gpu-vendor` | `nvidia`, `amd`, `google`, `none` | `nvidia` |
| `greenpay.io/gpu-model` | `a100`, `h100`, `v100`, `t4`, `l4`, `tpu-v4` | `a100` |
| `greenpay.io/gpu-count` | Integer string | `8` |
| `greenpay.io/gpu-vram-mib` | Integer string (MiB) | `81920` |
| `greenpay.io/gpu-interconnect` | `nvlink`, `pcie`, `none` | `nvlink` |
| `greenpay.io/numa-nodes` | Integer string | `2` |
| `greenpay.io/gpu-numa-distribution` | Dot-separated GPU counts in ascending NUMA ID order | `4.4` |
| `greenpay.io/topology-manager-policy` | `none`, `best-effort`, `restricted`, `single-numa-node` | `restricted` |
| `greenpay.io/topology-manager-scope` | `container`, `pod` | `pod` |
| `greenpay.io/network-zone` | Zone name | `zone-a` |
| `greenpay.io/network-bandwidth` | Integer string (Gbps) | `100` |
| `greenpay.io/node-tier` | `gpu-high`, `gpu-low`, `cpu-high`, `cpu-standard` | `gpu-high` |

See `k8s/ml-workloads/node-labels.yaml` for full example commands.

---

## Pod annotations

Add these to `spec.template.metadata.annotations` in your workload manifests.

| Annotation | Type | Default | Description |
|---|---|---|---|
| `greenpay.io/workload-type` | string | `api` | Workload class for scoring strategy |
| `greenpay.io/gpu-vendor-req` | string | `any` | Required GPU vendor |
| `greenpay.io/gpu-model-req` | string | `any` | Required GPU model |
| `greenpay.io/gpu-vram-min-mib` | integer string | `0` | Minimum per-GPU VRAM |
| `greenpay.io/network-zone-req` | string | `""` | Required network zone |
| `greenpay.io/network-bw-min-gbps` | integer string | `0` | Minimum bandwidth |
| `greenpay.io/bin-pack-weight` | float string | `1.0` | Score multiplier |

Also set `spec.schedulerName: greenpay-scheduler` in your PodSpec.

---

## Deployment

### 1. Label your nodes

```bash
kubectl label node gpu-node-01 \
  greenpay.io/gpu-vendor=nvidia \
  greenpay.io/gpu-model=a100 \
  greenpay.io/gpu-count=8 \
  greenpay.io/gpu-vram-mib=81920 \
  greenpay.io/gpu-interconnect=nvlink \
  greenpay.io/numa-nodes=2 \
  greenpay.io/gpu-numa-distribution=4.4 \
  greenpay.io/topology-manager-policy=restricted \
  greenpay.io/topology-manager-scope=pod \
  greenpay.io/network-zone=zone-a \
  greenpay.io/network-bandwidth=100 \
  greenpay.io/node-tier=gpu-high
```

The distribution must contain one entry per `greenpay.io/numa-nodes` value,
and its entries must sum to `greenpay.io/gpu-count`. A value of `4.4` means
four GPUs on NUMA domain 0 and four GPUs on NUMA domain 1. A distribution that
is invalid or inconsistent with the declared counts leaves the NUMA domain count
undeterminable, so the node is scored as unknown rather than neutral — see
[Missing metadata](#missing-metadata). Fix the labels rather than relying on
that fallback.

### Verify kubelet Topology Manager alignment

The Kubernetes Node API does not publish kubelet Topology Manager settings, so
the `greenpay.io/topology-manager-*` labels are operator attestations rather
than scheduler-discovered state. Verify each node before applying those labels:

```bash
NODE=gpu-node-01
kubectl get --raw "/api/v1/nodes/${NODE}/proxy/configz" \
  | jq -r '.kubeletconfig
    | [.topologyManagerPolicy, .topologyManagerScope]
    | @tsv'
# restricted    pod
```

Only label a node `restricted` or `single-numa-node` when that output matches
the declared policy and scope. Re-run the check after kubelet configuration
changes. The GPU device plugin must also report device `TopologyInfo`; without
those hints, Topology Manager cannot align GPU allocation with CPU and memory
NUMA affinity. See the Kubernetes
[Topology Manager documentation](https://kubernetes.io/docs/tasks/administer-cluster/topology-manager/)
and [device plugin API](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/#device-plugin-implementation).

### 2. Build and push the scheduler image

```bash
cd scheduler/
docker build -t greenpay/scheduler:1.0.0 .
docker push greenpay/scheduler:1.0.0
```

### 3. Deploy scheduler infrastructure

```bash
kubectl apply -k k8s/scheduler/
```

Verify the scheduler pods start:
```bash
kubectl get pods -n greenpay-scheduler
# NAME                                  READY   STATUS    RESTARTS   AGE
# greenpay-scheduler-6c9d8b7c5f-abcde   1/1     Running   0          30s
# greenpay-scheduler-6c9d8b7c5f-fghij   1/1     Running   0          30s
```

### 4. Deploy ML workloads

```bash
kubectl apply -k k8s/
```

### 5. Verify scheduling decisions

```bash
# Check where a pod was placed and why
kubectl describe pod <summary-worker-pod-name> -n greenpay \
  | grep -A 20 "Events:"

# Check scheduler logs
kubectl logs -n greenpay-scheduler -l app.kubernetes.io/name=greenpay-scheduler \
  --tail=100 | grep -E "Score|Filter|placed"
```

---

## Upgrading

The scheduler binary runs as a Deployment.  Rolling updates work the same
as any other Deployment — update the image tag and apply:

```bash
kubectl set image deployment/greenpay-scheduler \
  greenpay-scheduler=greenpay/scheduler:1.1.0 \
  -n greenpay-scheduler
```

Leader-election ensures scheduling continuity during the rollout.

---

## Troubleshooting

**Pod stays Pending with "0/N nodes are available"**

Run `kubectl describe pod <name>` and check the `Events` section.  The
`GPUHardwareFilter` will include a human-readable reason in the event.

Common causes:
- No node has the required GPU vendor/model — check node labels.
- VRAM floor is too high for all labelled nodes.
- Network zone requirement doesn't match any node's zone label.

**Scheduler pods are not starting**

Check RBAC: `kubectl auth can-i get pods --as=system:serviceaccount:greenpay-scheduler:greenpay-scheduler`

Check logs: `kubectl logs -n greenpay-scheduler deployment/greenpay-scheduler`

**Pod lands on wrong node**

Increase the scheduler log verbosity (`--v=5`) to see per-node scores.
The `MLWorkloadScore` plugin logs `Score: computed` with all four sub-scores.
