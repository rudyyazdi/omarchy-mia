import { describe, expect, it } from "vitest";
import { isListenableHost, machineAddresses, watchAddress } from "./watch-address.ts";

const ADDRESSES = ["127.0.0.1", "::1", "192.168.20.31", "fdbb::1"];

describe("watch address", () => {
  it("listens only on an IP address, never a name", () => {
    expect(isListenableHost("0.0.0.0")).toBe(true);
    expect(isListenableHost("omarchy.local")).toBe(false);
  });

  it("leaves out IPv6 link-local addresses, which no Host header could name", () => {
    const info = { netmask: "", mac: "", internal: false, cidr: null };
    expect(
      machineAddresses({
        lo: [{ ...info, address: "127.0.0.1", family: "IPv4", internal: true }],
        wlan: [
          { ...info, address: "192.168.20.31", family: "IPv4" },
          { ...info, address: "fe80::1", family: "IPv6", scopeid: 2 },
        ],
      }),
    ).toEqual(["127.0.0.1", "192.168.20.31"]);
  });

  it("on 0.0.0.0, is opened locally on loopback and from elsewhere on each IPv4 address", () => {
    expect(watchAddress({ host: "0.0.0.0", port: 4000, addresses: ADDRESSES })).toEqual({
      local: "http://127.0.0.1:4000",
      network: ["http://192.168.20.31:4000"],
      ownHosts: new Set(["127.0.0.1:4000", "192.168.20.31:4000", "localhost:4000"]),
    });
  });

  it("on ::, adds the IPv6 addresses in brackets", () => {
    const reached = watchAddress({ host: "::", port: 4000, addresses: ADDRESSES });
    expect(reached.network).toEqual(["http://192.168.20.31:4000", "http://[fdbb::1]:4000"]);
    expect(reached.ownHosts).toContain("[::1]:4000");
  });

  it("on one address, answers only to it, and to localhost only on loopback", () => {
    expect(watchAddress({ host: "127.0.0.1", port: 4000, addresses: ADDRESSES })).toEqual({
      local: "http://127.0.0.1:4000",
      network: [],
      ownHosts: new Set(["127.0.0.1:4000", "localhost:4000"]),
    });
    expect(watchAddress({ host: "192.168.20.31", port: 4000, addresses: ADDRESSES })).toEqual({
      local: "http://192.168.20.31:4000",
      network: ["http://192.168.20.31:4000"],
      ownHosts: new Set(["192.168.20.31:4000"]),
    });
  });
});
