# Canary Deployment Rollback

Runbook for handling canary deployment failures and performing rollbacks.
Covers both automated rollback (via Argo Rollouts analysis) and manual rollback procedures.

## Overview

Backend and frontend services use **Argo Rollouts** with a canary deployment strategy.
Traffic is shifted progressively (10% → 30% → 60% → 100%) with analysis checks at each step.
If error rate exceeds 5% or p99 latency exceeds 500ms, the rollout is automatically aborted
and traffic is rolled back to the previous stable version.

## Prerequisites

- Argo Rollouts controller installed in the cluster
- Prometheus accessible at `prometheus.monitoring.svc.cluster.local:9090`
- `kubectl` access to the `greenpay` namespace
- `kubectl argo rollouts` plugin installed

## Automated Rollback

The rollout performs analysis after each traffic shift:

| Step | Traffic Weight | Pause Duration | Analysis |
|------|---------------|----------------|----------|
| 1    | 10%           | 2m             | —        |
| 2    | 30%           | 2m             | Error rate + latency (backend) / error rate (frontend) |
| 3    | 60%           | 2m             | Error rate + latency (backend) / error rate (frontend) |
| 4    | 100%          | —              | —        |

**Analysis thresholds:**
- Error rate: < 5% (5xx responses / total requests over 2m window)
- p99 latency: < 500ms (backend only)

If any analysis step fails 3 consecutive checks, the rollout is **automated rollback**:
1. Argo Rollouts detects the failure
2. Traffic is shifted back to 100% stable
3. The canary pods are terminated
4. The previous ReplicaSet is preserved for quick re-deploy

## Monitoring Rollout Status

```bash
# Watch the backend rollout in real-time
kubectl argo rollouts get rollout backend -n greenpay --watch

# Watch the frontend rollout
kubectl argo rollouts get rollout frontend -n greenpay --watch

# View rollout history
kubectl argo rollouts history rollout backend -n greenpay

# Check analysis runs
kubectl get analysisrun -n greenpay
```

## Manual Rollback

If the automated rollback didn't trigger or you need to force a rollback:

### Rollback to Previous Revision

```bash
# Rollback backend to the previous revision
kubectl argo rollouts undo rollout backend -n greenpay

# Rollback frontend to the previous revision
kubectl argo rollouts undo rollout frontend -n greenpay

# Rollback to a specific revision
kubectl argo rollouts history rollout backend -n greenpay
kubectl argo rollouts undo rollout backend --to-revision=<revision-number> -n greenpay
```

### Abort an In-Progress Rollout

```bash
# Abort the backend rollout (keeps current traffic split, stops progression)
kubectl argo rollouts abort rollout backend -n greenpay

# Abort the frontend rollout
kubectl argo rollouts abort rollout frontend -n greenpay
```

### Resume a Paused Rollout

```bash
# Resume after manual inspection
kubectl argo rollouts promote rollout backend -n greenpay
```

## Canary Rollback Drill

Perform this drill quarterly to verify rollback procedures work correctly.

### Step 1: Deploy a Known-Broken Version

```bash
# Update the backend image to a version that returns 500 errors
kubectl argo rollouts set image backend backend=greenpay/backend:broken-test -n greenpay

# Watch the rollout — it should automatically abort
kubectl argo rollouts get rollout backend -n greenpay --watch
```

### Step 2: Verify Automated Rollback

Expected behavior:
1. Rollout starts, shifts 10% traffic to canary
2. After 2m pause, analysis runs
3. Error rate exceeds 5% threshold
4. After 3 consecutive failures, rollout is **aborted**
5. Traffic returns to 100% stable

```bash
# Confirm the rollout status shows "Degraded" then "Healthy"
kubectl argo rollouts get rollout backend -n greenpay

# Confirm the analysis run shows failures
kubectl get analysisrun -n greenpay -o yaml

# Confirm the canary pods are terminated
kubectl get pods -n greenpay -l app=backend
```

### Step 3: Verify Manual Rollback

```bash
# Force a rollback to the previous revision
kubectl argo rollouts undo rollout backend -n greenpay

# Confirm rollout completes successfully
kubectl argo rollouts get rollout backend -n greenpay --watch

# Verify the service is healthy
kubectl get svc backend-stable -n greenpay
kubectl get svc backend-canary -n greenpay
```

### Step 4: Clean Up

```bash
# Restore the correct backend image
kubectl argo rollouts set image backend backend=greenpay/backend:1.0.0 -n greenpay

# Verify healthy state
kubectl argo rollouts get rollout backend -n greenpay
```

## Troubleshooting

### Rollout Stuck in "Progressing"

```bash
# Check rollout status
kubectl argo rollouts get rollout backend -n greenpay -o yaml

# Check for pending pods
kubectl get pods -n greenpay -l app=backend --field-selector=status.phase=Pending

# Check events
kubectl get events -n greenpay --sort-by=.lastTimestamp | tail -20
```

### Analysis Run Failing Unexpectedly

```bash
# Check if Prometheus is reachable
kubectl run -it --rm debug --image=curlimages/curl --restart=Never -n greenpay -- \
  curl -s http://prometheus.monitoring.svc.cluster.local:9090/api/v1/query?query=up

# Check the analysis run details
kubectl get analysisrun -n greenpay -o yaml

# Manually run the PromQL query
kubectl run -it --rm debug --image=curlimages/curl --restart=Never -n greenpay -- \
  curl -s "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/query?query=sum(rate(http_requests_total{service='backend-canary.greenpay.svc.cluster.local',code=~'5.*'}[2m]))/sum(rate(http_requests_total{service='backend-canary.greenpay.svc.cluster.local'}[2m]))"
```

### Canary Ingress Not Receiving Traffic

```bash
# Verify the canary ingress exists
kubectl get ingress -n greenpay

# Check nginx canary annotations
kubectl get ingress backend-canary-ingress -n greenpay -o yaml

# Verify the nginx ingress controller is running
kubectl get pods -n ingress-nginx
```

## Configuration Reference

### Helm Values (canary tuning)

```yaml
backend:
  canary:
    steps:
      initialWeight: 10    # First canary traffic percentage
      initialPause: 2m     # Pause before analysis
      midWeight: 30        # Second step traffic
      midPause: 2m
      highWeight: 60       # Third step traffic
      highPause: 2m
    analysis:
      errorRateThreshold: 0.05    # 5% error rate triggers rollback
      latencyP99Threshold: 500    # 500ms p99 latency triggers rollback
      interval: 1m                # How often to check metrics
      count: 5                    # Number of checks per step
      failureLimit: 3             # Consecutive failures before abort

monitoring:
  namespace: monitoring
  prometheusAddress: http://prometheus.monitoring.svc.cluster.local:9090
```

### Adjusting Thresholds

To make rollback more aggressive (lower error tolerance):
```yaml
backend:
  canary:
    analysis:
      errorRateThreshold: 0.02   # 2% instead of 5%
      failureLimit: 2            # 2 failures instead of 3
```

To slow down the rollout (longer observation):
```yaml
backend:
  canary:
    steps:
      initialPause: 5m    # 5 minutes instead of 2
      midPause: 5m
      highPause: 5m
```
