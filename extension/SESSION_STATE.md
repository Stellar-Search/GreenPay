# Extension session state

The MV3 service worker treats memory as disposable. `WorkerSessionState`
reconstructs every popup dependency before responding to a recovery request.

| State | Storage | Invalidation |
| --- | --- | --- |
| Wallet public key and network | `chrome.storage.session` | Revalidated with Freighter on every popup open; cleared when locked, access is revoked, the active account changes, the schema changes, or after 15 minutes |
| Three project summaries | `chrome.storage.local` | Refetched after 5 minutes or a schema change; search results are never persisted |
| Last worker instance seen by the popup | `chrome.storage.session` | Replaced after every successful popup recovery; a mismatch identifies worker termination/restart |

Only public wallet identity is stored. Secret keys, signed transactions, pending
donations, balances, search queries, and Freighter authorization are never
persisted. Balances are fetched again after recovery, and authorization is
always determined by Freighter rather than the cached wallet record.

## Trust boundary & messaging security

All background messaging handlers enforce strict origin and sender validation:
- **Privileged senders only**: `SET_WALLET_SESSION`, `CLEAR_WALLET_SESSION`, `GET_RECOVERY_STATE`, and `REFRESH_PROJECTS` are accepted strictly from trusted extension-page contexts (`sender.id === chrome.runtime.id` and `sender.tab === undefined`, such as the popup).
- **Content-script isolation**: Content scripts run in the context of arbitrary host pages (`<all_urls>`). Any message originating from a tab context (`sender.tab !== undefined`) or external extension ID is rejected, ensuring untrusted web pages cannot tamper with, poison, or clear the stored wallet session.
- **Runtime validation**: All incoming messages are validated at runtime for valid message discriminants and field types before processing.

