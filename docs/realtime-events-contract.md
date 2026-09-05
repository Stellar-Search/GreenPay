# Realtime Event Contracts & Delivery Semantics

**Issue:** #375 — Typed Socket.IO event contract and delivery semantics  
**Applies to:** Backend Socket.IO emitters (`backend/src/`) and client consumers (`frontend/`, `mobile/`)

---

## 1. Overview

GreenPay utilizes Socket.IO for low-latency realtime broadcasts (e.g. live donation ticker, project progress updates, asynchronous summary notifications).

Because WebSockets carry untyped arbitrary JSON and compile-time types are erased across network boundaries, all realtime events are governed by a **canonical shared contract** (`shared/socketEvents.js`) enforced through **runtime validation** and **idempotent consumption**.

---

## 2. Event Catalog & Payload Schemas

All event names are defined in `SOCKET_EVENTS`:

### `donation_event`
Emitted whenever a donation is recorded on-chain or indexed from the Stellar network.

**Schema:**
```typescript
interface DonationSocketPayload {
  projectId: string;        // UUID v4 format
  donorAddress: string;     // Valid Stellar public key (G...)
  amountXLM: number;        // Positive finite number
  transactionHash: string;  // 64-character hexadecimal string
  timestamp: string;        // ISO-8601 UTC timestamp
}
```

**Example JSON:**
```json
{
  "projectId": "8d9ac19b-52eb-42f7-80d9-19a88ba59e43",
  "donorAddress": "GDYO6GEXKXPU3UH5SWGTAVHMBBZZEKUHWHXUJ33PL2TJJVHZB7CG6BI5",
  "amountXLM": 25.5,
  "transactionHash": "8f3b20c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3",
  "timestamp": "2026-08-21T09:30:00.000Z"
}
```

---

### `ai_summary_ready`
Emitted by background workers when an asynchronous project summary has been generated and persisted.

**Schema:**
```typescript
interface AISummarySocketPayload {
  projectId: string;             // UUID v4 format
  aiSummary: string;             // Non-empty string
  aiSummaryGeneratedAt: string;  // ISO-8601 UTC timestamp
  aiSummaryModel: string;        // Non-empty model identifier
}
```

**Example JSON:**
```json
{
  "projectId": "8d9ac19b-52eb-42f7-80d9-19a88ba59e43",
  "aiSummary": "Verified community reforestation in the Amazon basin.",
  "aiSummaryGeneratedAt": "2026-08-21T09:30:05.000Z",
  "aiSummaryModel": "summary-model-v1"
}
```

---

## 3. Delivery Semantics & Guarantees

Realtime messaging across distributed systems is subject to network partitions, retries, and multi-emitter concurrency.

### At-Least-Once Delivery
- Events may be delivered more than once. For example, a donation might trigger a broadcast from the REST handler and a subsequent notification from the Stellar indexer service, or a client reconnect may cause re-transmission.
- **Rule:** Consumers **MUST** be idempotent.

### Ordering
- Events emitted from different nodes or asynchronous workers do not guarantee total strict ordering over the socket.
- State sorting must always rely on `timestamp` or `transactionHash`.

---

## 4. Consumer Responsibilities

Client consumers (such as `useDonationSocket`) MUST follow these three principles:

### A. Runtime Schema Validation
Before updating state or invoking user callbacks, clients validate every raw event payload using `validateDonationPayload` / `validateAISummaryPayload`.
- Malformed payloads (e.g. missing fields, invalid formats, negative amounts) are dropped immediately with a diagnostic warning and never touch React state or UI stores.

### B. Idempotent Deduplication (No Double-Counting)
For `donation_event`, the `transactionHash` is a globally unique primary key on the Stellar ledger:
- Consumers track seen transaction hashes in an internal hash set (O(1) lookup).
- If an incoming event's `transactionHash` is already present in the deduplication cache, the event is safely ignored.

### C. Reconnection Reconciliation (Offline Gap Handling)
When a client loses network connectivity, events emitted during the disconnect window are not buffered indefinitely by the server.
- Upon reconnect (`socket.on("connect")`), consumers trigger a **reconcile callback** to re-fetch the latest REST view (`GET /api/v1/donations/project/:id`).
- Merging the REST data with the live stream using `transactionHash` deduplication ensures no donations are lost and none are double-counted.

---

## 5. Usage in Code

### Backend Emission
```javascript
const { SOCKET_EVENTS } = require("../schemas/socketEvents");

io.emit(SOCKET_EVENTS.DONATION_EVENT, {
  projectId,
  donorAddress,
  amountXLM: 50,
  transactionHash,
  timestamp: new Date().toISOString(),
});
```

### Frontend Consumption
```typescript
import { useDonationSocket } from "@/hooks/useDonationSocket";

useDonationSocket(projectId, (donation) => {
  setDonations((prev) => [donation, ...prev]);
}, {
  onReconnect: () => refetchDonations(),
});
```
