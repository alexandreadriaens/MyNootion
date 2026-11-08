import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

/**
 * Outgoing requests on behalf of users (webhooks, link previews…) must not reach the server's own network: the
 * router, a NAS, other containers, cloud metadata services. Addresses are checked after DNS resolution, at
 * connection time (no gap for DNS rebinding), and again on every redirect.
 */
const BLOCKED = new net.BlockList();
const V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const V6: [string, number][] = [
  ["::", 128],
  ["::1", 128],
  // IPv4 written as IPv6 could hide a local address. ::ffff:a.b.c.d needs no rule: BlockList checks it against the
  // IPv4 rules above (a ::ffff:0:0/96 rule would block every IPv4 address). NAT64, 6to4 and Teredo are refused.
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2002::", 16],
  ["2001::", 32],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];
for (const [a, p] of V4) BLOCKED.addSubnet(a, p, "ipv4");
for (const [a, p] of V6) BLOCKED.addSubnet(a, p, "ipv6");

/** True for an address on the public internet; false for loopback, private, link-local, reserved… and non-addresses. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !BLOCKED.check(ip, "ipv4");
  if (family === 6) return !BLOCKED.check(ip, "ipv6");
  return false;
}

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`${host}: local network address refused`);
    this.name = "BlockedAddressError";
  }
}

/** dns.lookup that refuses names pointing (even partly) to a non-public address. */
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as unknown as dns.LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) return callback(new BlockedAddressError(hostname), "", 0);
    if ((options as dns.LookupOptions).all) (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  /** Redirects followed for GET and HEAD (each target checked again). 0: the 3xx answer is returned as is. */
  maxRedirects?: number;
  /** Lets requests reach private addresses (setting chosen by the administrator). */
  allowPrivate?: boolean;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function once(url: URL, init: SafeFetchInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!init.allowPrivate && net.isIP(host) && !isPublicAddress(host)) return reject(new BlockedAddressError(host));
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: init.method ?? "GET",
        headers: init.headers,
        signal: init.signal,
        agent: false,
        ...(init.allowPrivate ? {} : { lookup: guardedLookup }),
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const item of v) headers.append(k, item);
          else if (v !== undefined) headers.set(k, v);
        }
        const status = res.statusCode ?? 502;
        const body = NULL_BODY.has(status) || init.method === "HEAD" ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        if (!body) res.resume();
        resolve(new Response(body, { status, statusText: res.statusMessage, headers }));
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

/** fetch() for addresses chosen by users: http(s) only, public addresses only (unless allowed), checked redirects. */
export async function safeFetch(input: string | URL, init: SafeFetchInit = {}): Promise<Response> {
  let url = new URL(input);
  const method = (init.method ?? "GET").toUpperCase();
  const follow = method === "GET" || method === "HEAD" ? (init.maxRedirects ?? 3) : 0;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https addresses are allowed.");
    const res = await once(url, { ...init, method });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location || hop >= follow) return res;
    await res.body?.cancel().catch(() => {});
    url = new URL(location, url);
  }
}
