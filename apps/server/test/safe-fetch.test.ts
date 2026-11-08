import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { BlockedAddressError, isPublicAddress, safeFetch } from "../src/safe-fetch.js";

describe("requests on behalf of users", () => {
  it("tell public addresses from the local network", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.0.148",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:192.168.0.148",
      "::ffff:c0a8:94",
      "64:ff9b::c0a8:94",
      "2002:c0a8:94::1",
      "not an address",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("refuse local addresses, names pointing to them and IPv4 written as IPv6", async () => {
    const server = http.createServer((_req, res) => res.writeHead(302, { location: "http://127.0.0.1/" }).end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, `http://[::1]:${port}/`]) {
        await expect(safeFetch(url), url).rejects.toBeInstanceOf(BlockedAddressError);
      }
      await expect(safeFetch("ftp://example.com/")).rejects.toThrow();
      // Allowed by the administrator: the server is reached; a redirect is handed back when not followed.
      const res = await safeFetch(`http://127.0.0.1:${port}/`, { allowPrivate: true, maxRedirects: 0 });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://127.0.0.1/");
    } finally {
      server.close();
    }
  });
});
