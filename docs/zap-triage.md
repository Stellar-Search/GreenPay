# OWASP ZAP Baseline Scan Triage Guide

This guide explains how automated DAST (Dynamic Application Security Testing) is executed in the CI pipeline, and how to triage and whitelist false positives.

## Architecture & Ephemeral Staging Deployment

1. **Active Scanning**: The `zaproxy/action-baseline` GitHub Action runs the ZAP baseline scan against a target URL. There is **no hard-coded staging domain**; the target is supplied as the `dast_target` input of the `workflow_dispatch` trigger in [ci.yml](../.github/workflows/ci.yml). On push/PR runs the scan is **skipped** (no target) and only runs when an operator provides a deployed environment URL.
2. **Report Generation**: It yields standard HTML and JSON findings reports.
3. **CI Rules Enforcement**: The CI executes a triage script (`scripts/triage-zap.js`) which parses `report.json`.
4. **Enforced Threshold**: The build **fails automatically** if there are any unhandled **HIGH or CRITICAL** risk findings (risk code `3`).

---

## How to Triage and Add False Positives

If a HIGH finding is reported by ZAP in CI but is determined to be a **false positive** or an intentional architectural design:

1. Identify the details of the finding in the CI console logs (or download the `report.json` artifact). Specifically note:
   - **Plugin ID**: The ZAP scanner ID (e.g. `10020`).
   - **Alert**: The name of the alert.
   - **URI/URL**: The page/endpoint that triggered the alert.

2. Open the main config file [zap-false-positives.json](../zap-false-positives.json).

3. Append your rule override inside `ignored_alerts`:
   ```json
   {
     "pluginId": "10020",
     "alert": "X-Frame-Options Header Scanner",
     "url": "/widget",
     "reason": "Explain clearly why this is safe and verified."
   }
   ```
   *Note: If `url` is omitted, the override will apply to all instances matching that Plugin ID globally. Provide a `url` substring (e.g., `/widget`) if the exclusion should be scoped strictly.*

4. Commit and push the changes. The next CI run will verify the triage list, skip the matching alert, and allow the pipeline to succeed.

