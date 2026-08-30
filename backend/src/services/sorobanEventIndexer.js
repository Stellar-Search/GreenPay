"use strict";

const { nativeToScVal, scValToNative } = require("@stellar/stellar-sdk");

const DEFAULT_POLL_INTERVAL_MS = 500;
const DONATED_TOPIC = nativeToScVal("donated", { type: "symbol" }).toXDR("base64");

function addressToString(value) {
  return typeof value === "string" ? value : value?.toString();
}

function decodeDonationEvent(event) {
  const topics = event.topic.map((topic) => scValToNative(topic));
  if (topics[0] !== "donated") {
    throw new Error(`unexpected Soroban event topic: ${String(topics[0])}`);
  }

  const value = scValToNative(event.value);
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("donated event value must contain amount, badge, and message hash");
  }

  const amountStroops = BigInt(value[0]);
  if (amountStroops <= 0n) throw new Error("donated event amount must be positive");

  const donorAddress = addressToString(topics[1]);
  const projectId = String(topics[2]);
  if (!donorAddress || !projectId) throw new Error("donated event is missing donor or project identity");

  return {
    donorAddress,
    projectId,
    amountStroops: amountStroops.toString(),
    transactionHash: event.txHash,
    ledger: event.ledger,
  };
}

class SorobanEventIndexer {
  constructor({ rpcServer, contractId, db, handleDonation, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS }) {
    this.rpcServer = rpcServer;
    this.contractId = contractId;
    this.db = db;
    this.handleDonation = handleDonation;
    this.pollIntervalMs = pollIntervalMs;
    this.cursorKey = `soroban_events_cursor:${contractId}`;
    this.cursor = null;
    this.startLedger = null;
    this.timer = null;
    this.running = false;
    this.polling = null;
    this.lastError = null;
  }

  async loadCursor() {
    const result = await this.db.query("SELECT value FROM indexer_state WHERE key = $1", [this.cursorKey]);
    return result.rows[0]?.value || null;
  }

  async persistCursor(cursor) {
    await this.db.query(
      `INSERT INTO indexer_state (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [this.cursorKey, cursor]
    );
  }

  request() {
    const request = {
      filters: [{
        type: "contract",
        contractIds: [this.contractId],
        topics: [[DONATED_TOPIC, "*", "*"]],
      }],
      limit: 100,
    };
    if (this.cursor) request.cursor = this.cursor;
    else request.startLedger = this.startLedger;
    return request;
  }

  async pollOnce() {
    const response = await this.rpcServer.getEvents(this.request());
    for (const event of response.events) {
      const donation = decodeDonationEvent(event);
      const handled = await this.handleDonation(donation.projectId, {
        transaction_hash: donation.transactionHash,
        from: donation.donorAddress,
        amount_stroops: donation.amountStroops,
        ledger_attr: donation.ledger,
        integrity_source: "indexer_soroban",
      });
      if (handled === false) {
        throw new Error(`backend command boundary rejected Soroban event ${event.id}`);
      }
    }

    if (response.events.length > 0) {
      this.cursor = response.events.at(-1).pagingToken;
      await this.persistCursor(this.cursor);
    } else if (!this.cursor) {
      this.startLedger = response.latestLedger;
    }
    this.lastError = null;
    return response.events.length;
  }

  schedule(delay = this.pollIntervalMs) {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      this.polling = this.pollOnce();
      try {
        await this.polling;
      } catch (err) {
        this.lastError = err;
        console.error("[SorobanIndexer] Poll failed:", err.message);
      } finally {
        this.polling = null;
        this.schedule();
      }
    }, delay);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async start() {
    if (this.running) return;
    this.cursor = await this.loadCursor();
    if (!this.cursor) {
      const latest = await this.rpcServer.getLatestLedger();
      this.startLedger = latest.sequence;
    }
    this.running = true;
    console.log(
      `[SorobanIndexer] Watching ${this.contractId} from ${this.cursor ? `cursor ${this.cursor}` : `ledger ${this.startLedger}`}`
    );
    this.schedule(0);
  }

  async stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.polling) await this.polling.catch(() => undefined);
  }

  getStatus() {
    return {
      isRunning: this.running,
      cursor: this.cursor,
      startLedger: this.startLedger,
      lastError: this.lastError?.message || null,
    };
  }
}

module.exports = {
  DONATED_TOPIC,
  SorobanEventIndexer,
  decodeDonationEvent,
};
