import net from "node:net";

/**
 * Slows down password guessing on one account, whatever address it comes from: the per-address limit alone is dodged
 * with many addresses (a botnet, or the billions of addresses of a single IPv6 connection). After FREE_FAILURES wrong
 * passwords in a row, each new try must wait: 1 minute, then 2, 4… up to an hour. A successful sign-in starts over.
 * Unknown e-mail addresses are counted the same way, so the answers don't tell which accounts exist.
 */
const FREE_FAILURES = 5;
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 60 * 60_000;
const FORGET_AFTER_MS = 24 * 60 * 60_000;
// Bounded memory, even when someone tries thousands of made-up addresses.
const MAX_ENTRIES = 10_000;

interface Entry {
  failures: number;
  until: number;
  last: number;
}

export type LoginThrottle = ReturnType<typeof createLoginThrottle>;

export function createLoginThrottle(now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  const keyOf = (email: string) => email.trim().toLowerCase();
  const current = (key: string): Entry | undefined => {
    const e = entries.get(key);
    if (e && now() - e.last > FORGET_AFTER_MS) {
      entries.delete(key);
      return undefined;
    }
    return e;
  };
  return {
    /** Milliseconds this account must wait before trying again (0: it may try now). */
    wait(email: string): number {
      const e = current(keyOf(email));
      return e ? Math.max(0, e.until - now()) : 0;
    },
    failed(email: string) {
      const key = keyOf(email);
      const t = now();
      const e = current(key) ?? { failures: 0, until: 0, last: t };
      e.failures++;
      e.last = t;
      if (e.failures > FREE_FAILURES) e.until = t + Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (e.failures - FREE_FAILURES - 1));
      entries.delete(key);
      entries.set(key, e);
      if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    },
    succeeded(email: string) {
      entries.delete(keyOf(email));
    },
  };
}

/**
 * Key of a client for per-address limits: the address itself for IPv4, its /64 network for IPv6 (one connection
 * gets a whole /64, so counting each address apart would allow billions of tries).
 */
export function clientKey(ip: string): string {
  const addr = ip.split("%")[0]!;
  if (addr.toLowerCase().startsWith("::ffff:") && net.isIPv4(addr.slice(7))) return addr.slice(7);
  if (!net.isIPv6(addr)) return addr;
  const [head = "", tail] = addr.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
