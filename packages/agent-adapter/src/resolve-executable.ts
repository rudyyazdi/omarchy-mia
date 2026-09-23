import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export interface ExecutableLookup {
  /** The PATH the runtime is launched with; unset means spawn's default search path. */
  path: string | undefined;
  /** The directory the runtime is launched in: a name containing "/", and a relative PATH entry, resolve against it. */
  cwd: string;
}

/** Where `spawn` (libuv) looks a name up when the environment it is given has no PATH. */
const DEFAULT_SEARCH_PATH = "/usr/bin:/bin";

const isExecutableFileSync = (candidate: string): boolean => {
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
 * path, any other name is looked up in each PATH entry in order (an empty entry is the working directory), and an
 * unset PATH falls back to spawn's default search path.
 */
export const resolveExecutableSync = (
  executable: string,
  lookup: ExecutableLookup,
): string | null => {
  if (executable.includes("/")) {
    const candidate = resolve(lookup.cwd, executable);
    return isExecutableFileSync(candidate) ? candidate : null;
  }
  return (
    (lookup.path ?? DEFAULT_SEARCH_PATH)
      .split(delimiter)
      .map((entry) => resolve(lookup.cwd, entry, executable))
      .find(isExecutableFileSync) ?? null
  );
};
