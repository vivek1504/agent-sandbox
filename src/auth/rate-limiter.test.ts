import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, resetRateLimits } from "./rate-limiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("allows requests within limit", () => {
    const keyId = "key-1";
    expect(checkRateLimit(keyId, 2)).toBe(true);
    expect(checkRateLimit(keyId, 2)).toBe(true);
  });

  it("rejects requests exceeding limit", () => {
    const keyId = "key-1";
    expect(checkRateLimit(keyId, 2)).toBe(true);
    expect(checkRateLimit(keyId, 2)).toBe(true);
    expect(checkRateLimit(keyId, 2)).toBe(false);
  });

  it("allows unlimited when limit is 0", () => {
    const keyId = "key-unlimited";
    for (let i = 0; i < 100; i++) {
      expect(checkRateLimit(keyId, 0)).toBe(true);
    }
  });
});
