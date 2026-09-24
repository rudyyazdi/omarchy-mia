import { spawn } from "node:child_process";
import { errorMessage } from "@mia/protocol";

/**
 * Opens `url` in the desktop's browser through xdg-open, detached so the watch never waits on it. When that
 * fails, the address the watch already printed is the way in.
 */
export const openInBrowser = (url: string): void => {
  const child = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  child.once("error", (error) =>
    console.error(`could not open a browser (${errorMessage(error)}); open ${url} yourself`),
  );
  child.unref();
};
