# Project update content and moderation policy

**Owner:** Trust and Safety
**Applies to:** project update text, update translations, web/mobile display,
email, and push notifications
**Effective:** 2026-08-28
**Review cadence:** every six months and after any serious update-content incident

This policy makes project updates evidence donors can rely on without treating
project-supplied text as trusted content. It is written for both project
operators deciding what to post and moderators deciding what action to take.

## 1. Content rules

### Allowed

- Factual progress reports whose material claims can be tied to project records.
- Clearly labelled estimates, forecasts, goals, and opinions.
- Relevant requests for volunteers, feedback, or project-specific support.
- Links using `http`, `https`, or `mailto` when the destination is relevant and
  accurately described.
- Corrections that identify what changed and why.

### Disallowed

| Rule | Mechanical moderation question | Examples |
|---|---|---|
| Unsupported or misleading impact claim | Is a material statement presented as measured fact while available records contradict it or the project cannot supply the stated source? | Inflated trees planted, fabricated beneficiaries, false certification, invented measurement dates, misrepresented fund allocation, unrelated photos described as project evidence. |
| Abuse | Does the content attack, threaten, degrade, or target a person or protected group? | Threats, slurs, targeted harassment. |
| Spam | Is the content substantially duplicated, deceptive, irrelevant, or posted mainly to manipulate attention? | Repeated identical posts, keyword stuffing, deceptive links. |
| Off-topic solicitation | Does it request money, credentials, contact, or action unrelated to the project donors supported? | Personal fundraisers, unrelated token promotions, credential requests. |
| Dangerous content | Does it give operational instructions likely to cause physical harm or encourage illegal environmental damage? | Unsafe field instructions presented without required controls. |
| Privacy violation | Does it disclose personal, financial, location, health, or contact information without a documented need and permission? | Donor email lists, beneficiary addresses, private identity documents. |
| Renderer evasion | Does it attempt to introduce HTML, executable links, attributes, handlers, tracking, or visual impersonation? | Raw tags, `javascript:` links, event-handler attributes. |

“Fraudulent claim” is not inferred merely because a result is surprising, an
estimate changes, or evidence is incomplete. A moderator records this reason
only when a material factual statement is demonstrably false, uses evidence
that does not support it, omits a qualification necessary to avoid misleading
donors, or remains unsupported after a reasonable evidence request. Otherwise
the moderator requests clarification or uses a narrower policy reason.

## 2. Evidence and decision standard

Moderators record the exact sentence or element reviewed, the applicable rule,
the evidence consulted, and a plain-language rationale. Available project
records, ledger entries, dated field records, verifier attestations, and the
project's response may be considered. Report volume is a prioritization signal,
not evidence and never triggers automatic removal.

Decision thresholds:

- **Approve:** no disallowed content is found on the balance of available evidence.
- **Reject before publication:** a standard-project submission contains
  disallowed content or a material claim cannot be assessed after an evidence request.
- **Remove after publication:** published content meets a disallowed-content
  rule, or leaving it visible creates a material donor or safety risk.
- **Reinstate:** the removal premise is reversed or corrected evidence resolves it.

Every decision requires a non-empty reason and produces an immutable
`project_update_moderation_events` row containing actor, action, old state, new
state, reason, metadata, and time. Open reports are resolved with the decision;
reporter identities stay in the restricted report record and are not returned
in the donor feed.

## 3. Publication lifecycle

```text
standard create -> pending -> published
                         \-> rejected -> appealed -> published | rejected

fully verified create -> published_pending_review -> published
                                                \-> removed

published edit -> published_pending_review -> published | removed
published -> removed -> appealed -> published | removed
removed -> reinstated -> published
```

“Fully verified” means both `projects.verified` and
`projects.on_chain_verified` are true when the update is created.

### Pre- versus post-publication decision

- **Standard projects:** pre-publication review. New content in `pending` is
  absent from donor feeds and notifications.
- **Fully verified projects:** post-publication review. New content in
  `published_pending_review` appears immediately with a visible “review
  pending” label. This preserves posting speed for projects that passed both
  verification layers.
- **Edits to content donors could already read:** post-publication review for
  every project. The old public snapshot is retained, the changed post is
  labelled “Edited” with its revision number, and the new revision is
  `published_pending_review` until decided.

Trust affects initial visibility only. **Email and push notifications are held
for every project until a moderator approves the exact current revision.**
This prevents an irrevocable email from being sent during either review mode.

## 4. Notification rules

Approval queues email and push independently. Successful queue handoff is
stored per channel (`email_notified_at` and `push_notified_at`), so retrying a
temporary failure queues only the missing channel. Editing an already-notified
update does not resend it.

Publication also snapshots the exact email addresses and device tokens whose
jobs were accepted. Queue claims are stored before handoff and released if the
queue rejects them, so concurrent retries do not create duplicate jobs. A
later correction uses this recipient snapshot—not the current subscriber or
follower list. Someone who unsubscribed after receiving the original still
gets its necessary correction, while someone who subscribed later does not.
Recipient snapshots are restricted operational data and follow the same
retention and access controls as subscription and device-token records.

If a notified update is later removed:

1. It disappears from web/mobile donor feeds immediately.
2. Every channel that carried it receives a correction follow-up.
3. The correction names the project and update, states that moderation removed
   it, gives the recorded reason, and links to current project information.
4. The removed body is not repeated in the correction.
5. Per-channel correction timestamps make the follow-up retryable without
   duplicating a channel that already accepted it.

Email cannot be recalled; this follow-up is the required correction record.

## 5. Donor reporting and abuse resistance

Only an address with a committed donation to the update's project may report a
currently public update. The API enforces:

- a reason from the fixed policy list and bounded optional details;
- one report per donor address per update;
- five reports per donor address per 24 hours;
- twenty reports per source address per 24 hours;
- no automatic takedown or trust penalty based on count;
- moderator review and a recorded resolution for every acted-on report.

Coordinated or retaliatory reports therefore affect queue priority only. A
moderator decides from content and evidence, not popularity. Repeated bad-faith
reporting may be investigated using the retained restricted report records.

## 6. Edits and donor-visible history

Before an edit is applied, the current title, body, language, moderation state,
revision, editor, reason, and whether it was public are copied to
`project_update_revisions`. Public snapshots remain available from the history
endpoint and the web UI. The current card always shows an “Edited” label and
revision number after the first change.

Revision content that itself violates the policy remains retained for audit.
Its `content_visible` flag may be cleared so donors see that a historical
revision existed without redisplaying harmful content. Moderation and database
operators retain the full record according to the platform retention policy.

## 7. Appeals

A project administrator may appeal a `rejected` or `removed` update with a
specific reason and any corrected evidence. Only one appeal may be pending per
update. A moderator other than the filer decides it:

- **Granted:** publish the current revision and queue any notification channel
  that has never carried it.
- **Denied:** return to the prior `rejected` or `removed` state.

The appeal, filer, prior state, decision maker, decision reason, and timestamps
are retained. A further review requires new material evidence and a new appeal
after the existing one is decided.

Operational target: acknowledge an appeal within two working days and decide
within ten working days. Urgent privacy or safety cases are prioritized.

## 8. Posting limits

Creation is limited independently by source address, authenticated subject,
and project. The project bucket permits three new updates per hour even if
accounts or addresses rotate. Edits have their own subject/address limits so a
project cannot bypass creation review by rapidly rewriting one record.

## 9. Markdown security boundary

Project update markdown is untrusted. The renderer supports only bold, italic,
line breaks, and absolute `http`, `https`, or `mailto` links. It escapes every
text fragment before emitting HTML, normalizes links with the URL parser, and
generates only `a`, `strong`, `em`, and `br` elements. Anchors receive only
fixed `href`, `target`, `rel`, and `class` attributes; `rel` includes
`noopener`, `noreferrer`, and `nofollow`.

Property-based tests generate arbitrary text and assert that:

- raw tags and scripts remain text;
- generated elements and attributes stay inside the allowlist;
- no event-handler attribute is created;
- every link uses an allowed protocol;
- control-character and token-like payloads remain inert.

Renderer changes require these tests, frontend type checking, and review as a
security-sensitive change. Email templates separately HTML-escape update text.

## 10. Operator endpoints

The API reference lists each route. The primary operational flow is:

1. Read `GET /api/v1/updates/moderation/queue`.
2. Inspect report reasons, details, and prior resolutions with
   `GET /api/v1/updates/{updateId}/reports`, then review the recorded evidence.
3. Apply `approve`, `reject`, `remove`, or `reinstate` with a reason through
   `POST /api/v1/updates/{updateId}/moderation`.
4. Inspect the immutable audit with
   `GET /api/v1/updates/{updateId}/moderation-history`.
5. Retry only missing publication channels with
   `POST /api/v1/updates/{updateId}/notifications/retry` when queue handoff failed.
6. Review appeals from `GET /api/v1/updates/moderation/appeals`; a different
   moderator submits the appeal decision.
