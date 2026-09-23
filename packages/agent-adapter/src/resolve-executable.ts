import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export interface ExecutableLookup {
  /** The PATH the runtime is launched with; unset means nothing is found by name. */
  path: string | undefined;
  /** The directory the runtime is launched in: a name containing "/", and a relative PATH entry, resolve against it. */
  cwd: string;
}

const isExecutableFile = (candidate: string): boolean => {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/**
 * Finds the file `spawn` would run for `executable`, as an absolute path, or null. Resolved in Node rather than with a
 * shell's `command -v` so the name is only ever a path, never shell code. Follows execvp: a name containing "/" is a
 * path, any other name is looked up in each PATH entry in order (an empty entry is the working directory).
 * Synchronous: it runs only in the startup probe.
 */
export const resolveExecutable = (executable: string, lookup: ExecutableLookup): string | null => {
  if (executable.includes("/")) {
    const candidate = resolve(lookup.cwd, executable);
    return isExecutableFile(candidate) ? candidate : null;
  }
  if (lookup.path === undefined) return null;
  return (
    lookup.path
      .split(delimiter)
      .map((entry) => resolve(lookup.cwd, entry, executable))
      .find(isExecutableFile) ?? null
  );
};
