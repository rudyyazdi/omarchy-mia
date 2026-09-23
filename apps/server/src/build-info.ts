import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex } from "@mia/protocol";

export interface BuildInfo {
  name: string;
  version: string;
  commit: string | null;
  dirty: boolean | null;
  /** Digest of `git diff HEAD` plus untracked file list when dirty; the diff bytes are retained separately. */
  local_changes_digest: string | null;
  local_changes: string | null;
  source_root: string;
}

const gitSync = (args: string[], cwd: string): string | null => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20_000 });
  return result.status === 0 ? result.stdout : null;
};

/** The `version` field of a package.json, when the file is readable and carries one. */
const packageVersionSync = (packageJsonPath: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof parsed.version === "string"
    )
      return parsed.version;
  } catch {
    /* keep default */
  }
  return undefined;
};

/** One `sha256  path` line per untracked file, or `unreadable  path` for a file that cannot be read. */
const digestUntrackedSync = (root: string, files: string[]): string => {
  const lines: string[] = [];
  for (const file of files) {
    try {
      lines.push(`${sha256Hex(readFileSync(resolve(root, file)))}  ${file}`);
    } catch {
      lines.push(`unreadable  ${file}`);
    }
  }
  return lines.join("\n");
};

/** Identify the running source tree: commit, dirty flag and a retained snapshot of local changes. */
export const collectBuildInfoSync = (name: string, sourceRoot: string): BuildInfo => {
  const root = resolve(sourceRoot);
  const version = packageVersionSync(resolve(root, "package.json")) ?? "0.0.0";
  const commit = gitSync(["rev-parse", "HEAD"], root)?.trim() ?? null;
  if (!commit)
    return {
      name,
      version,
      commit: null,
      dirty: null,
      local_changes_digest: null,
      local_changes: null,
      source_root: root,
    };
  const status = gitSync(["status", "--porcelain"], root) ?? "";
  const dirty = status.trim().length > 0;
  let localChanges: string | null = null;
  if (dirty) {
    const diff = gitSync(["diff", "HEAD", "--", ".", ":(exclude)*.sqlite"], root) ?? "";
    // Untracked files are outside `git diff`; retain their names and content digests so the build digest is content-sensitive.
    const untracked = digestUntrackedSync(
      root,
      (gitSync(["ls-files", "--others", "--exclude-standard"], root) ?? "")
        .split("\n")
        .filter(Boolean),
    );
    localChanges = `# git status --porcelain\n${status}\n# untracked files (sha256  path)\n${untracked}\n# git diff HEAD\n${diff}`;
  }
  return {
    name,
    version,
    commit,
    dirty,
    local_changes_digest: localChanges ? sha256Hex(localChanges) : null,
    local_changes: localChanges,
    source_root: root,
  };
};
