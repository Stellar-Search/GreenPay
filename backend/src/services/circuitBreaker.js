// In-memory Circuit Breaker & Velocity Limiter for Matcher Wallet

const CONFIG = {
    MAX_HOURLY_SPEND_XLM: 1000, // Maximum total XLM allowed per hour
    MAX_CONSECUTIVE_FAILURES: 5, // Auto-trip after N consecutive errors
    WINDOW_MS: 60 * 60 * 1000,  // 1-hour rolling window
};

let consecutiveFailures = 0;
let hourlySpendWindow = []; // Array of timestamps and amounts
let isTripped = false;
let tripReason = "";

const CircuitBreaker = {
    checkCanExecute(amountXLM) {
        if (isTripped) {
            throw new Error(`Circuit breaker is TRIPPED: ${tripReason}. Payouts halted.`);
        }

        // Clean up spend entries older than 1 hour
        const now = Date.now();
        hourlySpendWindow = hourlySpendWindow.filter(
            (entry) => now - entry.timestamp < CONFIG.WINDOW_MS
        );

        // Calculate current hourly spend
        const currentHourlySpend = hourlySpendWindow.reduce(
            (total, entry) => total + entry.amount,
            0
        );

        if (currentHourlySpend + amountXLM > CONFIG.MAX_HOURLY_SPEND_XLM) {
            this.trip(`Hourly spend limit reached (${currentHourlySpend + amountXLM} XLM > ${CONFIG.MAX_HOURLY_SPEND_XLM} XLM)`);
            throw new Error(`Circuit breaker TRIPPED: Spend velocity limit exceeded.`);
        }
    },

    recordSuccess(amountXLM) {
        consecutiveFailures = 0; // Reset consecutive failures on success
        hourlySpendWindow.push({ timestamp: Date.now(), amount: amountXLM });
    },

    recordFailure() {
        consecutiveFailures += 1;
        if (consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
            this.trip(`Exceeded maximum consecutive failure threshold (${CONFIG.MAX_CONSECUTIVE_FAILURES})`);
        }
    },

    trip(reason) {
        isTripped = true;
        tripReason = reason;
        console.error(`🚨 ALERT: Matcher Wallet Circuit Breaker TRIPPED! Reason: ${reason}`);
        // Here you would trigger an operator notification (e.g., Slack webhook, email, or PagerDuty)
    },

    reset() {
        isTripped = false;
        tripReason = "";
        consecutiveFailures = 0;
        hourlySpendWindow = [];
    },

    isTripped() {
        return isTripped;
    }
};

module.exports = { CircuitBreaker };