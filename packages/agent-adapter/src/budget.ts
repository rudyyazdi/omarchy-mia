import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Live model-call budget shared by the probe and the live acceptance lane.
 * One entry per Mia-submitted turn. The cap is a session guard, not a billing record.
 */
export class LiveCallBudget {
  constructor(
    readonly file: string,
    readonly cap: number,
  ) {}

  static fromEnv(defaultFile: string): LiveCallBudget {
    return new LiveCallBudget(
      process.env.MIA_LIVE_BUDGET_FILE ?? defaultFile,
      Number(process.env.MIA_LIVE_CALL_CAP ?? "50"),
    );
  }

  used(): number {
    if (!existsSync(this.file)) return 0;
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;
  }

  /** Reserve one call or throw. */
  take(label: string, model: string): number {
    const used = this.used();
    if (used >= this.cap)
      throw new Error(`live call cap reached (${used}/${this.cap}); refusing to start "${label}"`);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    appendFileSync(
      this.file,
      JSON.stringify({ at: new Date().toISOString(), label, model }) + "\n",
      { mode: 0o600 },
    );
    return used + 1;
  }
}
