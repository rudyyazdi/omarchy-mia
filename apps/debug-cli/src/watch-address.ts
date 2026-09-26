import { isIP } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

/** The address the watch listens on unless told otherwise: every IPv4 address of this machine. */
export const ANY_HOST = "0.0.0.0";

const WILDCARDS: ReadonlySet<string> = new Set(["0.0.0.0", "::"]);

/** Whether the watch may listen on `host`: an IP address, so the Host headers a page may send are known. */
export const isListenableHost = (host: string): boolean => isIP(host) !== 0;

const isLoopback = (address: string): boolean => address.startsWith("127.") || address === "::1";

/**
 * This machine's addresses, from `os.networkInterfaces()`. IPv6 link-local ones are left out: a browser names them
 * with a zone that differs per device, so no Host header could be checked against them.
 */
export const machineAddresses = (
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): readonly string[] =>
  Object.values(interfaces)
    .flatMap((infos) => infos ?? [])
    .filter((info) => !(info.family === "IPv6" && info.address.startsWith("fe80:")))
    .map((info) => info.address);

/** Where a watch listening on `host` and `port` is reached. */
export interface WatchAddress {
  /** What this machine opens: a loopback origin when the watch listens on one. */
  local: string;
  /** What another device opens, one origin per address outside this machine. */
  network: readonly string[];
  /**
   * The only Host headers the watch answers, so a site that rebinds its domain to one of its addresses gets
   * nothing; a loopback address also answers to `localhost`.
   */
  ownHosts: ReadonlySet<string>;
}

/**
 * On a wildcard `host` the watch is reached at each of `addresses` of the same family (both for `::`), as they
 * were when it started: an address the machine gains later is refused.
 */
export const watchAddress = (options: {
  host: string;
  port: number;
  addresses: readonly string[];
}): WatchAddress => {
  const { host, port } = options;
  const reached = WILDCARDS.has(host)
    ? options.addresses.filter((address) => host === "::" || isIP(address) === 4)
    : [host];
  const authority = (address: string) =>
    isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`;
  const loopback = reached.find(isLoopback);
  const outside = reached.filter((address) => !isLoopback(address));
  const authorities = reached.map(authority);
  return {
    local: `http://${authority(loopback ?? outside[0] ?? host)}`,
    network: outside.map((address) => `http://${authority(address)}`),
    ownHosts: new Set(loopback ? [...authorities, `localhost:${port}`] : authorities),
  };
};
