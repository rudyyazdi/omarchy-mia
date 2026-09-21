import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const LedgerKindSchema = z.enum([
  "entered",
  "committed",
  "cancelled",
  "returned",
  "rejected",
  "released",
]);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;

/** One JSONL line of the ledger; also the shape the harness API serves back to tests. */
export const LedgerEntrySchema = z.object({
  seq: z.number(),
  at: z.string(),
  kind: LedgerKindSchema,
  tool: z.string(),
  call_id: z.string(),
  args: z.unknown().optional(),
  detail: z.string().optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export interface LedgerAppend {
  kind: LedgerKind;
  tool: string;
  callId: string;
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

  append({ kind, tool, callId, args, detail }: LedgerAppend): LedgerEntry {
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
      .filter((line) => line.trim().length > 0)
      .map((line) => LedgerEntrySchema.parse(JSON.parse(line)));
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
      (entry) => entry.kind === "committed" && (tool === undefined || entry.tool === tool),
    );
  }
}
