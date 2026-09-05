# Donor-content translation policy

GreenPay stores the language originally supplied for every project and update. A translation is a separate record keyed by content and language; it never replaces or edits the original fields. The currently supported donor-content languages match the interface languages: English (`en`), Spanish (`es`), and Arabic (`ar`).

## Selection and fallback

Clients request content with the optional `lang` query parameter. An approved translation in that language is returned when available. Otherwise the original is returned. Every response identifies `sourceLanguage`, `contentLanguage`, `requestedLanguage`, `usedFallback`, `machineTranslated`, and `contentDirection`, so clients can label the result instead of implying that fallback copy is translated. Omitting `lang` preserves the original fields and is backwards compatible.

Search considers the original and every approved translation, regardless of the requested display language. Pending or rejected translations are neither searchable nor donor-visible.

## Quality and impact claims

Translations are user content and go through the authenticated project moderation path. New and edited translations return to `pending`; only `approved` records can be read by donors, used for search, or sent in notifications. Rejected records remain retained for review history but are not published.

Machine translation is allowed for scale, but is always visibly labelled. Environmental results, quantities, timelines, certifications, donation terms, and other claims that could affect a donation decision are treated as impact claims. A machine-translated record cannot be approved until a human reviewer explicitly records `impactClaimsReviewed: true`. Reviewers must compare those claims with the source and reject or correct translations that change their meaning. The label remains after review because approval does not turn machine-authored wording into human translation.

## Bidirectional content

The API returns `contentDirection` from the selected content language. Frontend content containers apply their own `lang` and `dir` attributes, independently of the interface direction. This isolates Arabic project text correctly even when it appears inside an English or Spanish page. The Playwright screenshot suite covers the Arabic project-card layout.

## Notifications

Subscriptions store `preferredLanguage`. Update email batches are grouped by that language and use approved project/update translations when present. Missing translations fall back to the source content, while translated email chrome uses the recipient preference. Machine-translated notification copy retains its warning.
