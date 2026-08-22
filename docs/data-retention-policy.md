# Data Retention Policy

This document defines the data-retention and deletion policies for personal data stored by the GreenPay platform. It covers device tokens, audit-log IP addresses, donor profile data, and related data categories.

## Scope

This policy applies to all personal data collected and processed by GreenPay's backend services, including:

- Device push tokens and associated metadata
- IP addresses recorded in admin audit logs
- Donor profile information (public keys, display names, bios)
- Email addresses from project subscriptions
- Donation records and transaction metadata

## Data Categories and Retention Periods

### 1. Device Tokens (`device_tokens`)

| Field | Retention | Rationale |
|---|---|---|
| `token` | 90 days from `last_seen_at` | Push tokens become stale when users uninstall the app or rotate tokens. Stale tokens waste push delivery resources and may cause `DeviceNotRegistered` errors. |
| `platform` | Tied to token lifetime | Platform identifier is only useful alongside a valid token. |
| `wallet_address` | Tied to token lifetime | Association between device and wallet is only relevant while the token is active. |
| `last_seen_at` | Updated on each push registration | Used to calculate staleness. Tokens not seen in 90 days are candidates for deletion. |

**Automated cleanup:** A scheduled job deletes `device_tokens` rows where `last_seen_at` is older than 90 days. Associated `project_follows` rows cascade-delete via foreign key.

### 2. Admin Audit Log (`admin_audit_log`)

| Field | Retention | Rationale |
|---|---|---|
| `ip_address` | 365 days from `created_at` | IP addresses are personal data under GDPR/CCPA. Retained for 1 year to support security investigations and incident response, then redacted. |
| `actor`, `action`, `target_type`, `target_id`, `metadata` | 2 years from `created_at` | Administrative action records retained for compliance and accountability. |
| Full row | 2 years from `created_at` | Entire audit log entries deleted after 2 years. |

**Automated cleanup:** A scheduled job runs monthly to:
1. Redact `ip_address` to `'REDACTED'` for rows older than 365 days
2. Delete entire rows older than 2 years

### 3. Donor Profiles (`profiles`)

| Field | Retention | Rationale |
|---|---|---|
| `public_key` | Duration of account + 30 days | Primary identifier; retained while account is active. |
| `display_name`, `bio` | Duration of account + 30 days | User-provided content; deleted upon account deletion. |
| `total_donated_xlm`, `projects_supported`, `badges` | Duration of account + 30 days | Aggregate stats; deleted upon account deletion. |

**No automated expiry.** Profiles persist until the donor requests deletion.

### 4. Donation Records (`donations`)

| Field | Retention | Rationale |
|---|---|---|
| `donor_address` | 7 years | Financial transaction records retained for tax and regulatory compliance. |
| `amount`, `currency`, `transaction_hash` | 7 years | Transaction details required for financial audits. |
| `message` | 3 years or upon deletion request | Optional donor messages; can be purged earlier. |

**No automated expiry** for financial records (7-year regulatory requirement). Donor messages can be anonymized upon request.

### 5. Project Subscriptions (`project_subscriptions`)

| Field | Retention | Rationale |
|---|---|---|
| `email` | Until unsubscribe or 12 months of inactivity | Email addresses retained only while subscriptions are active. |
| `donor_address` | Tied to subscription lifetime | Associated wallet data retained with subscription. |

**Automated cleanup:** Subscriptions with no associated activity for 12 months are flagged for removal.

### 6. Event Stream (`event_stream`)

| Field | Retention | Rationale |
|---|---|---|
| All fields | 2 years | Event sourcing log retained for replay capability and debugging. |

**No automated expiry** in current implementation. Consider archival strategy for production deployments.

## Automated Cleanup Schedule

| Job | Frequency | Action |
|---|---|---|
| Device token pruning | Daily at 03:00 UTC | Delete `device_tokens` where `last_seen_at < NOW() - INTERVAL '90 days'` |
| Audit log IP redaction | Monthly, 1st at 04:00 UTC | Set `ip_address = 'REDACTED'` where `created_at < NOW() - INTERVAL '365 days'` |
| Audit log deletion | Monthly, 1st at 04:00 UTC | Delete rows where `created_at < NOW() - INTERVAL '2 years'` |
| Subscription cleanup | Weekly, Sunday at 05:00 UTC | Flag subscriptions inactive for >12 months |

## Deletion Request Handling

### Current Process (Manual)

Donors may request deletion of their personal data by contacting the platform administrators. Upon receiving a verified deletion request:

1. **Identity verification:** Confirm the requestor controls the wallet address by signing a challenge message.
2. **Scope determination:** Identify all data associated with the wallet address:
   - `device_tokens` rows (delete immediately)
   - `project_follows` rows (cascade from device_tokens)
   - `profiles` row (delete, but retain anonymized donation records)
   - `project_subscriptions` rows (delete email, retain anonymized subscription)
   - `donations` records (retain `donor_address` anonymized for 7-year financial compliance)
3. **Anonymization:** For data subject to financial retention requirements, replace `donor_address` with a salted hash rather than full deletion.
4. **Confirmation:** Notify the requestor once deletion/anonymization is complete.

### Future Enhancements

- Self-service deletion endpoint in the donor profile UI
- Automated identity verification via signed message challenge
- Audit trail of deletion requests and their completion status

## Jurisdictional Considerations

| Regulation | Applicability | Key Requirements |
|---|---|---|
| GDPR (EU) | Donors in EU/EEA | Right to erasure, data minimization, consent for processing |
| CCPA (California) | Donors in California | Right to delete, right to know, opt-out of sale |
| PIPEDA (Canada) | Donors in Canada | Consent, limiting collection, right of access |

This policy is designed to satisfy the most restrictive applicable regulation. Deployments serving donors in specific jurisdictions should review local requirements and adjust retention periods if necessary.

## Implementation References

- Schema changes: `backend/src/db/schema.sql` (admin_audit_log table, device_tokens.last_seen_at column)
- Cleanup script: `backend/src/scripts/cleanup-expired-data.js`
- Push notification service: `backend/src/services/push.js`
- Audit logging: `backend/src/services/audit.js`

## Review Schedule

This policy should be reviewed:
- Annually, or
- Upon significant changes to data processing activities, or
- When new regulatory requirements take effect
