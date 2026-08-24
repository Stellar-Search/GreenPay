{{/*
Name of the Secret the workloads read their credentials from.

When secrets.provider is external, External Secrets Operator materializes
this Secret from AWS Secrets Manager or Vault. When secrets.existingSecret
is set with provider=inline, the chart renders no Secret and every workload
references the operator-managed name instead. Nothing production-shaped is
ever committed in values files.
*/}}
{{- define "greenpay.secretName" -}}
{{- default "greenpay-secrets" .Values.secrets.existingSecret -}}
{{- end -}}

{{/*
Scheme the release is publicly reachable on. Ingress TLS is off in the testnet
defaults and on in the mainnet overlay, and ALLOWED_ORIGINS has to agree with
whichever is actually served or the browser CORS check fails.
*/}}
{{- define "greenpay.publicScheme" -}}
{{- if .Values.ingress.tls.enabled -}}https{{- else -}}http{{- end -}}
{{- end -}}

{{/*
TLS-related Ingress annotations. The cert-manager cluster-issuer annotation is
only rendered when both TLS and a ClusterIssuer name are set, so testnet stays
HTTP-only and a mainnet deploy that already has an issuer outside this chart
can still point the Ingress at it via ingress.tls.clusterIssuer.
*/}}
{{- define "greenpay.ingress.tlsAnnotations" -}}
{{- if .Values.ingress.tls.enabled }}
nginx.ingress.kubernetes.io/ssl-redirect: "true"
{{- if .Values.ingress.tls.clusterIssuer }}
cert-manager.io/cluster-issuer: {{ .Values.ingress.tls.clusterIssuer | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
spec.tls block shared by every Ingress the chart renders. All of them must
reference the same Secret so nginx and the canary pair terminate the same cert.
*/}}
{{- define "greenpay.ingress.tls" -}}
{{- if .Values.ingress.tls.enabled }}
tls:
  - hosts:
      - {{ .Values.ingress.host | quote }}
    secretName: {{ .Values.ingress.tls.secretName }}
{{- end }}
{{- end -}}
