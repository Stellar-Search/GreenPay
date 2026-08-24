const { CircuitBreaker } = require("../services/circuitBreaker");

describe("CircuitBreaker Unit Tests", () => {
  beforeEach(() => {
    // Reset circuit breaker state before each test
    CircuitBreaker.reset();
  });

  it("should allow transactions under the hourly velocity limit", () => {
    expect(() => CircuitBreaker.checkCanExecute(100)).not.toThrow();
    CircuitBreaker.recordSuccess(100);
    expect(CircuitBreaker.isTripped()).toBe(false);
  });

  it("should trip when hourly spend velocity exceeds limit", () => {
    // Send 900 XLM successfully
    CircuitBreaker.recordSuccess(900);

    // Attempting to send another 200 XLM exceeds 1000 XLM cap
    expect(() => CircuitBreaker.checkCanExecute(200)).toThrow(
      /Circuit breaker TRIPPED: Spend velocity limit exceeded/
    );
    expect(CircuitBreaker.isTripped()).toBe(true);
  });

  it("should trip after consecutive failure threshold is met", () => {
    for (let i = 0; i < 5; i++) {
      CircuitBreaker.recordFailure();
    }

    expect(CircuitBreaker.isTripped()).toBe(true);
    expect(() => CircuitBreaker.checkCanExecute(10)).toThrow(
      /Circuit breaker is TRIPPED/
    );
  });

  it("should reset consecutive failure count on a successful transaction", () => {
    CircuitBreaker.recordFailure();
    CircuitBreaker.recordFailure();
    CircuitBreaker.recordSuccess(50); // Reset failure count

    // Should require 5 NEW consecutive failures to trip
    for (let i = 0; i < 4; i++) {
      CircuitBreaker.recordFailure();
    }
    expect(CircuitBreaker.isTripped()).toBe(false);
  });
});