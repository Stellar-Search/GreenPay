# ADR-004: Managed PostgreSQL vs Self-Hosted HA for Production Database

## Status

Accepted

## Context and Problem Statement

GreenPay currently deploys PostgreSQL as a single-replica Kubernetes StatefulSet (`k8s/postgres.yaml`) with a single ReadWriteOnce PersistentVolumeClaim (PVC). While WAL archiving to S3 (`archive_command`) achieves a Recovery Point Objective (RPO) of < 5 minutes, a single-pod StatefulSet cannot satisfy production Recovery Time Objective (RTO) requirements (target < 5-15 minutes) during node failure, PVC corruption, or maintenance events, as pod recreation and manual WAL replay require 30 to 60 minutes.

To meet high availability (HA) and stringent RTO targets for transaction and donation data, GreenPay must decide between operating a self-hosted HA PostgreSQL cluster on Kubernetes (e.g., via CloudNativePG / Zalando Postgres Operator with Patroni) or migrating production workloads to a managed PostgreSQL service (e.g., AWS RDS PostgreSQL / GCP Cloud SQL).

## Decision Drivers

- **RTO & Availability Requirements**: Production recovery time must be < 5 minutes with automated failover in case of hardware or availability zone (AZ) failures.
- **Operational Overhead**: Platform engineering resources are focused on smart contracts, transaction scaling, and application features rather than managing database consensus, replication topologies, and failover orchestrators.
- **Data Protection & PITR**: Automated point-in-time recovery with continuous WAL archiving and automated snapshot backups without custom sidecars or maintenance scripts.
- **Cost Efficiency**: Total cost of ownership (TCO) considering compute, storage, backup retention, and engineering maintenance hours.
- **Compliance & Security**: Automated patching, encryption at rest/transit, automated IAM role integration, and disaster recovery isolation across AZs.

## Considered Options

1. **Managed PostgreSQL Service (AWS RDS / GCP Cloud SQL)**
2. **Self-Hosted HA PostgreSQL Operator on Kubernetes (Patroni / CloudNativePG)**
3. **Single-Pod StatefulSet with WAL Archiving (Current Baseline / Dev)**

## Decision Outcome

Chosen option: **Managed PostgreSQL Service (AWS RDS / GCP Cloud SQL) for Production**, while retaining the single-pod StatefulSet with WAL archiving for local/ephemeral development and staging environments.

### Rationale

A single-pod StatefulSet cannot meet production RTO targets during node or storage failures. Self-hosting an HA PostgreSQL cluster with Patroni or CloudNativePG on Kubernetes introduces significant operational overhead (etcd/consensus management, network partition handling, split-brain mitigation, and node maintenance). Using AWS RDS or GCP Cloud SQL provides multi-AZ replication, sub-minute automated failover, managed minor version upgrades, and zero-maintenance PITR while keeping GreenPay's operational complexity low.

## Positive Consequences

- Production RTO reduced from 30–60 minutes (manual PVC/pod recovery) to **< 60 seconds** via multi-AZ automated failover.
- Production RPO reduced to **< 5 seconds** through synchronous multi-AZ streaming replication and continuous WAL archiving.
- Eliminates Kubernetes cluster state dependencies (etcd, PVC binding delays, node scheduling) for database availability.
- Automated storage auto-scaling, point-in-time recovery UI/API integration, and automated security patches.
- Engineering team focuses on payment workflows rather than database operator troubleshooting.

## Negative Consequences

- Higher cloud infrastructure costs compared to raw EC2/EKS nodes.
- Requires cloud provider secret management (AWS Secrets Manager / GCP Secret Manager) integration for production credentials.
- Staging/Dev environments continue using the single-pod StatefulSet to save costs, introducing minor architectural divergence from production.

## Pros and Cons of the Options

### Managed PostgreSQL Service (AWS RDS / GCP Cloud SQL)

- Good, because it provides out-of-the-box multi-AZ failover (< 60s RTO).
- Good, because automated PITR and WAL management require zero custom scripts or sidecars.
- Good, because it minimizes operational burden on the development team.
- Bad, because infrastructure billing cost is higher than self-hosted instances on raw compute.
- Bad, because vendor lock-in occurs for platform-specific backup/restore tools.

### Self-Hosted HA PostgreSQL Operator on Kubernetes (CloudNativePG / Patroni)

- Good, because it runs entirely inside Kubernetes with uniform YAML manifests.
- Good, because compute costs can be optimized across spot/on-demand instances.
- Bad, because handling quorum loss, network split-brains, and persistent volume failover requires deep database operator expertise.
- Bad, because upgrading Postgres major versions and operator CRDs adds operational risk and maintenance overhead.

### Single-Pod StatefulSet with WAL Archiving (Current Baseline)

- Good, because it is lightweight, simple, and low-cost for dev/test environments.
- Good, because adding WAL archiving (`archive_command` to S3) protects against data loss (RPO < 5 min).
- Bad, because it cannot meet RTO targets (< 30-60 min recovery window during pod/PVC failure).
- Bad, because single PVC creates a single point of failure (SPOF) for database availability.

## More Information

- [Database Documentation](../database.md)
- [Kubernetes Postgres Manifest](../../k8s/postgres.yaml)
- [Helm Postgres Template](../../helm/greenpay/templates/postgres.yaml)
