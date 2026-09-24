import { chmodSync, mkdtempDisposableSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Catalog } from "./catalog.ts";
import { readConversationProvenance } from "./provenance-read.ts";
import { RecordWriter } from "./writer.ts";

const AT = "2026-01-01T00:00:00.000Z";
const CONTRACTS = '{"mcpServers":{}}';

/** A catalog in a fresh directory, closed and removed when the test's `using` scope ends, even when it fails. */
const freshCatalog = () => {
  const directory = mkdtempDisposableSync(join(tmpdir(), "mia-provenance-read-"));
  const catalog = Catalog.openSync(directory.path);
  return {
    catalog,
    writer: new RecordWriter(catalog),
    [Symbol.dispose]: () => {
      catalog.close();
      directory.remove();
    },
  };
};

type ToolContractsEntry = Omit<
  Parameters<RecordWriter["addProvenanceEntry"]>[0],
  "id" | "provenanceSetId" | "role"
>;

/** A conversation whose provenance set holds `entry` as its tool contracts. */
const conversationWith = (writer: RecordWriter, entry: ToolContractsEntry): void => {
  writer.createProvenanceSet({ id: "prov-1", createdAt: AT, description: "test" });
  writer.addProvenanceEntry({
    ...entry,
    id: "pe-1",
    provenanceSetId: "prov-1",
    role: "tool_contracts",
  });
  writer.createConversation({
    id: "conv-1",
    startedAt: AT,
    provenanceSetId: "prov-1",
    runtimeConversationId: "rt-1",
  });
};

/** A conversation whose provenance retains `text` as its tool contracts, and the digest it was stored as. */
const conversationRetaining = async (writer: RecordWriter, text: string): Promise<string> => {
  const stored = await writer.objects.put(Buffer.from(text), {
    signal: new AbortController().signal,
  });
  writer.registerArtifact({
    id: "art-1",
    createdAt: AT,
    kind: "snapshot",
    logicalName: "tool_contracts",
    stored,
  });
  conversationWith(writer, { artifactId: "art-1", availability: "retained" });
  return stored.digest;
};

const read = (catalog: Catalog, options: { maxBytes?: number; signal?: AbortSignal } = {}) =>
  readConversationProvenance(catalog, {
    conversationId: "conv-1",
    role: "tool_contracts",
    maxBytes: options.maxBytes ?? 1024,
    signal: options.signal ?? new AbortController().signal,
  });

describe("readConversationProvenance", () => {
  it("reads the bytes the conversation's provenance retained for a role", async () => {
    using fresh = freshCatalog();
    await conversationRetaining(fresh.writer, CONTRACTS);
    const content = await read(fresh.catalog);
    expect(content.status).toBe("retained");
    if (content.status === "retained") expect(content.bytes.toString("utf8")).toBe(CONTRACTS);
  });

  it("gives the reason a role was recorded as unavailable", async () => {
    using fresh = freshCatalog();
    conversationWith(fresh.writer, { availability: "unavailable", reason: "not captured" });
    expect(await read(fresh.catalog)).toEqual({ status: "unavailable", reason: "not captured" });
  });

  it("reports an object that is over the bound, altered or missing instead of failing", async () => {
    using fresh = freshCatalog();
    const digest = await conversationRetaining(fresh.writer, CONTRACTS);
    expect(await read(fresh.catalog, { maxBytes: CONTRACTS.length - 1 })).toEqual({
      status: "unavailable",
      reason: `its tool_contracts object is over ${CONTRACTS.length - 1} bytes`,
    });
    const path = fresh.writer.objects.pathFor(digest);
    chmodSync(path, 0o600);
    writeFileSync(path, '{"mcpServers":{"x":{}}}');
    expect(await read(fresh.catalog)).toEqual({
      status: "unavailable",
      reason: "its tool_contracts object does not match its digest",
    });
    rmSync(path);
    expect(await read(fresh.catalog)).toEqual({
      status: "unavailable",
      reason: "its tool_contracts object is missing",
    });
  });

  it("rejects only once its signal aborts", async () => {
    using fresh = freshCatalog();
    await conversationRetaining(fresh.writer, CONTRACTS);
    await expect(read(fresh.catalog, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
