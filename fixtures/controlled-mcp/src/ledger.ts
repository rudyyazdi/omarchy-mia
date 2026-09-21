import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LedgerKind =
  "entered" | "committed" | "cancelled" | "returned" | "rejected" | "released";

export interface LedgerEntry {
  seq: number;
  at: string;
  kind: LedgerKind;
  tool: string;
  call_id: string;
  args: unknown;
  detail?: string;
}

/** Append-only JSONL ledger plus a counter file. Effects stay inside the fixture directory. */
export class Ledger {
  private seq = 0;
  readonly ledgerPath: string;
  readonly counterPath: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.ledgerPath = join(dir, "ledger.jsonl");
    this.counterPath = join(dir, "counter.txt");
    if (!existsSync(this.ledgerPath)) writeFileSync(this.ledgerPath, "", { mode: 0o600 });
    if (!existsSync(this.counterPath)) writeFileSync(this.counterPath, "0\n", { mode: 0o600 });
    this.seq = this.entries().length;
  }

  append(
    kind: LedgerKind,
    tool: string,
    callId: string,
    args: unknown,
    detail?: string,
  ): LedgerEntry {
    const entry: LedgerEntry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      kind,
      tool,
      call_id: callId,
      args,
    };
    if (detail !== undefined) entry.detail = detail;
    appendFileSync(this.ledgerPath, JSON.stringify(entry) + "\n");
    return entry;
  }

  entries(): LedgerEntry[] {
    const text = readFileSync(this.ledgerPath, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LedgerEntry);
  }

  counter(): number {
    return Number.parseInt(readFileSync(this.counterPath, "utf8").trim() || "0", 10);
  }

  increment(delta: number): number {
    const next = this.counter() + delta;
    writeFileSync(this.counterPath, `${next}\n`);
    return next;
  }

  reset(): void {
    writeFileSync(this.ledgerPath, "");
    writeFileSync(this.counterPath, "0\n");
    this.seq = 0;
  }

  commits(tool?: string): LedgerEntry[] {
    return this.entries().filter(
      (e) => e.kind === "committed" && (tool === undefined || e.tool === tool),
    );
  }
}
