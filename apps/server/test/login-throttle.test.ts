import { describe, expect, it } from "vitest";
import { clientKey, createLoginThrottle } from "../src/auth/login-throttle.js";

describe("slowing down password guessing", () => {
  it("lets 5 mistakes through, then doubles the wait up to an hour; a success starts over", () => {
    let now = 0;
    const throttle = createLoginThrottle(() => now);
    for (let i = 0; i < 5; i++) {
      expect(throttle.wait("ada@example.com")).toBe(0);
      throttle.failed(" ADA@example.com ");
    }
    expect(throttle.wait("ada@example.com")).toBe(0);
    throttle.failed("ada@example.com");
    expect(throttle.wait("ada@example.com")).toBe(60_000);
    now += 60_000;
    throttle.failed("ada@example.com");
    expect(throttle.wait("ada@example.com")).toBe(120_000);
    for (let i = 0; i < 10; i++) {
      now += throttle.wait("ada@example.com");
      throttle.failed("ada@example.com");
    }
    expect(throttle.wait("ada@example.com")).toBe(60 * 60_000);
    expect(throttle.wait("bob@example.com")).toBe(0);
    throttle.succeeded("ada@example.com");
    expect(throttle.wait("ada@example.com")).toBe(0);
  });

  it("forgets mistakes after a day", () => {
    let now = 0;
    const throttle = createLoginThrottle(() => now);
    for (let i = 0; i < 6; i++) throttle.failed("ada@example.com");
    expect(throttle.wait("ada@example.com")).toBeGreaterThan(0);
    now += 24 * 60 * 60_000 + 1;
    expect(throttle.wait("ada@example.com")).toBe(0);
    throttle.failed("ada@example.com");
    expect(throttle.wait("ada@example.com")).toBe(0);
  });

  it("counts one IPv6 connection (its /64) as one client", () => {
    expect(clientKey("2a01:cc00:daa0:3c00:65fa:e651:7a22:c179")).toBe("2a01:cc00:daa0:3c00::/64");
    expect(clientKey("2a01:cc00:daa0:3c00::1")).toBe("2a01:cc00:daa0:3c00::/64");
    expect(clientKey("2A01:0CC0::1")).toBe("2a01:cc0:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("::ffff:192.168.0.10")).toBe("192.168.0.10");
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
  });
});
