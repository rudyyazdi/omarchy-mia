import { readFile } from "node:fs/promises";

/** The records of a JSON-lines request log, for tests. */
export const readLogEntries = async (file: string): Promise<unknown[]> =>
  (await readFile(file, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
