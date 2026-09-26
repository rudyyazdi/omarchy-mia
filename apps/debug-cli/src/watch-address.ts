import { isIP } from "node:net";

/** The address the watch listens on unless told otherwise: only this machine can reach it. */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * Whether the watch may listen on `host`: an IP address, so the one Host header a page sends is known, and not a
 * wildcard, whose pages could arrive under any of the machine's names.
 */
export const isListenableHost = (host: string): boolean =>
  isIP(host) !== 0 && host !== "0.0.0.0" && host !== "::";

/**
 * Where a watch listening on `host` and `port` is reached. `ownHosts` are the only Host headers it answers, so a
 * site that rebinds its domain to this address gets nothing; a loopback address also answers to `localhost`.
 */
export const watchAddress = (
  host: string,
  port: number,
): { origin: string; ownHosts: ReadonlySet<string> } => {
  const authority = isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
  const loopback = host === LOOPBACK_HOST || host === "::1";
  return {
    origin: `http://${authority}`,
    ownHosts: new Set(loopback ? [authority, `localhost:${port}`] : [authority]),
  };
};
