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

function git(args: string[], cwd: string): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20_000 });
  return r.status === 0 ? r.stdout : null;
}

/** Identify the running source tree: commit, dirty flag and a retained snapshot of local changes. */
export function collectBuildInfo(name: string, sourceRoot: string): BuildInfo {
  const root = resolve(sourceRoot);
  let version = "0.0.0";
  try {
    version =
      (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: string })
        .version ?? version;
  } catch {
    /* keep default */
  }
  const commit = git(["rev-parse", "HEAD"], root)?.trim() ?? null;
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
  const status = git(["status", "--porcelain"], root) ?? "";
  const dirty = status.trim().length > 0;
  let local_changes: string | null = null;
  if (dirty) {
    const diff = git(["diff", "HEAD", "--", ".", ":(exclude)*.sqlite"], root) ?? "";
    // Untracked files are outside `git diff`; retain their names and content digests so the build digest is content-sensitive.
    const untracked = (git(["ls-files", "--others", "--exclude-standard"], root) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((f) => {
        try {
          return `${sha256Hex(readFileSync(resolve(root, f)))}  ${f}`;
        } catch {
          return `unreadable  ${f}`;
        }
      })
      .join("\n");
    local_changes = `# git status --porcelain\n${status}\n# untracked files (sha256  path)\n${untracked}\n# git diff HEAD\n${diff}`;
  }
  return {
    name,
    version,
    commit,
    dirty,
    local_changes_digest: local_changes ? sha256Hex(local_changes) : null,
    local_changes,
    source_root: root,
  };
}
