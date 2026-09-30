#!/usr/bin/env python3
"""
scripts/check-k8s-manifests.py

Consistency checks over k8s/ that need no cluster:

 1. Every manifest in k8s/ is referenced by kustomization.yaml, and every
    referenced path exists. ingress.yaml and pdb.yaml were both present but
    unreferenced, so `kubectl apply -k k8s/` silently created neither.
 2. Every Ingress backend names a Service that exists. The removed
    ingress.yaml routed to backend-svc / frontend-svc, which do not exist —
    the real Services are the stable/canary pairs.
 3. Every PodDisruptionBudget selector matches at least one workload.
 4. If a namespace-wide default-deny ingress policy exists, some other policy
    must admit traffic to the frontend and backend, otherwise applying k8s/
    blackholes the application.
"""
import os
import sys

import yaml

K8S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "k8s")
problems = []


def load_all(path):
    with open(path, encoding="utf-8") as fh:
        return [d for d in yaml.safe_load_all(fh) if isinstance(d, dict)]


with open(os.path.join(K8S, "kustomization.yaml"), encoding="utf-8") as fh:
    kustomization = yaml.safe_load(fh)

referenced = list(kustomization.get("resources") or [])

for ref in referenced:
    if not os.path.exists(os.path.join(K8S, ref)):
        problems.append(f"kustomization.yaml references {ref}, which does not exist")

for name in sorted(os.listdir(K8S)):
    if name.endswith(".yaml") and name != "kustomization.yaml" and name not in referenced:
        problems.append(f"k8s/{name} is not referenced by kustomization.yaml")

docs = []
for ref in referenced:
    path = os.path.join(K8S, ref)
    if os.path.exists(path):
        docs.extend(load_all(path))

services = {d["metadata"]["name"] for d in docs if d.get("kind") == "Service"}

workload_labels = [
    (d.get("spec", {}).get("template", {}).get("metadata", {}).get("labels") or {})
    for d in docs
    if d.get("kind") in ("Deployment", "StatefulSet", "Rollout", "DaemonSet")
]

for ing in [d for d in docs if d.get("kind") == "Ingress"]:
    for rule in ing.get("spec", {}).get("rules") or []:
        for p in (rule.get("http") or {}).get("paths") or []:
            svc = ((p.get("backend") or {}).get("service") or {}).get("name")
            if svc and svc not in services:
                problems.append(
                    f'Ingress {ing["metadata"]["name"]} routes to Service "{svc}", '
                    "which is not defined in k8s/"
                )

for pdb in [d for d in docs if d.get("kind") == "PodDisruptionBudget"]:
    sel = (pdb.get("spec", {}).get("selector") or {}).get("matchLabels")
    if not sel:
        continue
    if not any(all(labels.get(k) == v for k, v in sel.items()) for labels in workload_labels):
        problems.append(
            f'PodDisruptionBudget {pdb["metadata"]["name"]} selects {sel}, '
            "which matches no workload"
        )

policies = [d for d in docs if d.get("kind") == "NetworkPolicy"]
has_default_deny = any(
    not (p.get("spec", {}).get("podSelector") or {})
    and "Ingress" in (p.get("spec", {}).get("policyTypes") or [])
    and not (p.get("spec", {}).get("ingress") or [])
    for p in policies
)

if has_default_deny:
    for app in ("frontend", "backend"):
        admitted = False
        for p in policies:
            if not (p.get("spec", {}).get("ingress") or []):
                continue
            sel = p.get("spec", {}).get("podSelector") or {}
            if (sel.get("matchLabels") or {}).get("app") == app:
                admitted = True
                break
            for expr in sel.get("matchExpressions") or []:
                if (
                    expr.get("key") == "app"
                    and expr.get("operator") == "In"
                    and app in (expr.get("values") or [])
                ):
                    admitted = True
                    break
            if admitted:
                break
        if not admitted:
            problems.append(
                "NetworkPolicy default-deny is present but nothing admits ingress to "
                f'"{app}" — applying k8s/ would blackhole it'
            )

if problems:
    print("k8s manifest checks failed:\n", file=sys.stderr)
    for p in problems:
        print(f"  - {p}", file=sys.stderr)
    print(f"\n{len(problems)} problem(s).", file=sys.stderr)
    sys.exit(1)

print(f"k8s manifest checks passed ({len(referenced)} resources, {len(docs)} objects).")
