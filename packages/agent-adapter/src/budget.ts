import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Only digits pass: `Number()` would read "" as 0 and "1e3" as 1000. */
const parseCallCap = (text: string): number => {
  if (!/^\d+$/.test(text))
    throw new Error(`MIA_LIVE_CALL_CAP must be a non-negative integer (got "${text}")`);
  return Number(text);
};

/**
 * Live model-call budget shared by the probe and the live acceptance lane.
 * One entry per Mia-submitted turn. The cap is a session guard, not a billing record.
 */
export class LiveCallBudget {
  constructor(
    readonly file: string,
    readonly cap: number,
  ) {
    // NaN or Infinity would make `used >= cap` never stop a call.
    if (!Number.isSafeInteger(cap) || cap < 0)
      throw new Error(`live call cap must be a non-negative integer (got ${cap})`);
  }

  static fromEnv(defaultFile: string): LiveCallBudget {
    return new LiveCallBudget(
      process.env.MIA_LIVE_BUDGET_FILE ?? defaultFile,
      parseCallCap(process.env.MIA_LIVE_CALL_CAP ?? "50"),
    );
  }

  used(): number {
    if (!existsSync(this.file)) return 0;
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.trim()).length;
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
