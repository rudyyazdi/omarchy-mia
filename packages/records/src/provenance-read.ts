import { errorMessage } from "@mia/protocol";
import type { Catalog } from "./catalog.ts";
import { ObjectStore } from "./objects.ts";
import { findConversation } from "./queries.ts";
import type { ArtifactRow, ProvenanceEntryRow, ProvenanceRole } from "./schema.ts";

/** What a conversation's provenance retained for one role: its bytes, or why there are none to read. */
export type ProvenanceContent =
  { status: "retained"; bytes: Buffer } | { status: "unavailable"; reason: string };

const unavailable = (reason: string): ProvenanceContent => ({ status: "unavailable", reason });

/**
 * The bytes the conversation's own provenance set retained for `role`, checked against their digest; `maxBytes` bounds
 * the memory a read takes, as the artifact's recorded size states it. Anything that
 * keeps them from being read (a role recorded as unavailable, a missing or corrupt object) is a reason, not a
 * failure, so a debug view can still show the rest of the conversation; only an abort of `signal` rejects.
 */
export const readConversationProvenance = async (
  catalog: Catalog,
  input: { conversationId: string; role: ProvenanceRole; maxBytes: number; signal: AbortSignal },
): Promise<ProvenanceContent> => {
  const { conversationId, role, maxBytes, signal } = input;
  const conversation = findConversation(catalog, conversationId);
  if (!conversation) return unavailable(`conversation ${conversationId} not found`);
  const entry = catalog.get<ProvenanceEntryRow>(
    "SELECT * FROM provenance_entries WHERE provenance_set_id = ? AND role = ? ORDER BY ordinal LIMIT 1",
    conversation.provenance_set_id,
    role,
  );
  if (!entry) return unavailable(`its provenance records no ${role}`);
  if (entry.availability === "unavailable" || entry.artifact_id === null)
    return unavailable(entry.reason ?? `its provenance retained no ${role}`);
  const artifact = catalog.get<ArtifactRow>(
    "SELECT * FROM artifacts WHERE id = ?",
    entry.artifact_id,
  );
  const digest = artifact?.object_digest;
  if (!digest) return unavailable(`its ${role} artifact holds no object`);
  if (artifact.byte_size !== null && artifact.byte_size > maxBytes)
    return unavailable(`its ${role} object is over ${maxBytes} bytes`);
  let bytes: Buffer;
  try {
    bytes = await new ObjectStore(catalog.paths).read(digest, { signal });
  } catch (error) {
    signal.throwIfAborted();
    return unavailable(`its ${role} object could not be read: ${errorMessage(error)}`);
  }
  if (ObjectStore.digestOf(bytes) !== digest)
    return unavailable(`its ${role} object does not match its digest`);
  return { status: "retained", bytes };
};
