import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { isNotFound } from "@mia/protocol";

export type ExportReadResult =
  | { status: "read"; bytes: Buffer }
  | { status: "missing" }
  | { status: "invalid"; problem: string };

const invalidPath = (name: string): boolean =>
  !name ||
  isAbsolute(name) ||
  win32.isAbsolute(name) ||
  name.includes("\\") ||
  name.includes("\0") ||
  name.split("/").some((part) => part === ".." || part === "." || part === "");

/**
 * The caller selects the root; export entries may never redirect reads through symlinks.
 * Checks protect against crafted exports, not concurrent replacement of filesystem entries.
 */
export class ExportFiles {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static openSync(directory: string): ExportFiles {
    const root = realpathSync(directory);
    if (!lstatSync(root).isDirectory()) throw new Error("export root is not a directory");
    return new ExportFiles(root);
  }

  readSync(name: string): ExportReadResult {
    if (invalidPath(name)) return { status: "invalid", problem: `invalid file path: ${name}` };
    try {
      let path = this.#root;
      const parts = name.split("/");
      for (const [index, part] of parts.entries()) {
        path = join(path, part);
        const entry = lstatSync(path);
        const prefix = parts.slice(0, index + 1).join("/");
        if (entry.isSymbolicLink())
          return { status: "invalid", problem: `symlink not allowed: ${prefix}` };
        if (index < parts.length - 1 && !entry.isDirectory())
          return { status: "invalid", problem: `not a directory: ${prefix}` };
        if (index === parts.length - 1 && !entry.isFile())
          return { status: "invalid", problem: `not a regular file: ${prefix}` };
      }
      return { status: "read", bytes: readFileSync(path) };
    } catch (error) {
      if (isNotFound(error)) return { status: "missing" };
      return { status: "invalid", problem: `file unreadable: ${name}` };
    }
  }

  inventorySync(): { files: string[]; problems: string[] } {
    const files: string[] = [];
    const problems: string[] = [];
    const pending = [""];
    for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
      let names: string[];
      try {
        names = readdirSync(join(this.#root, directory));
      } catch {
        problems.push(`directory unreadable: ${directory || "."}`);
        continue;
      }
      for (const name of names) {
        const relativeName = directory ? `${directory}/${name}` : name;
        try {
          const entry = lstatSync(join(this.#root, relativeName));
          if (entry.isSymbolicLink()) problems.push(`symlink not allowed: ${relativeName}`);
          else if (entry.isDirectory()) pending.push(relativeName);
          else if (entry.isFile()) files.push(relativeName);
          else problems.push(`not a regular file: ${relativeName}`);
        } catch {
          problems.push(`file unreadable: ${relativeName}`);
        }
      }
    }
    return { files, problems };
  }
}
