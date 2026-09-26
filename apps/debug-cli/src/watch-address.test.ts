import { describe, expect, it } from "vitest";
import { isListenableHost, watchAddress } from "./watch-address.ts";

describe("watch address", () => {
  it("listens only on one IP address, never a wildcard or a name", () => {
    expect(isListenableHost("192.168.20.31")).toBe(true);
    expect(isListenableHost("::1")).toBe(true);
    expect(isListenableHost("0.0.0.0")).toBe(false);
    expect(isListenableHost("::")).toBe(false);
    expect(isListenableHost("omarchy.local")).toBe(false);
  });

  it("answers to localhost only on a loopback address", () => {
    expect([...watchAddress("127.0.0.1", 4000).ownHosts]).toEqual([
      "127.0.0.1:4000",
      "localhost:4000",
    ]);
    expect(watchAddress("192.168.20.31", 4000)).toEqual({
      origin: "http://192.168.20.31:4000",
      ownHosts: new Set(["192.168.20.31:4000"]),
    });
  });

  it("brackets an IPv6 address", () => {
    expect(watchAddress("::1", 4000).origin).toBe("http://[::1]:4000");
  });
});
