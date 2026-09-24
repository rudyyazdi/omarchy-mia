import { match } from "ts-pattern";
import { errorMessage } from "@mia/protocol";
import type { Catalog } from "./catalog.ts";
import { ObjectStore, type VerifiedRead } from "./objects.ts";
import { findConversation } from "./queries.ts";
import type { ArtifactRow, ProvenanceEntryRow, ProvenanceRole } from "./schema.ts";

/** What a conversation's provenance retained for one role: its bytes, or why there are none to read. */
export type ProvenanceContent =
  { status: "retained"; bytes: Buffer } | { status: "unavailable"; reason: string };

const unavailable = (reason: string): ProvenanceContent => ({ status: "unavailable", reason });

/**
 * The bytes the conversation's own provenance set retained for `role`, checked against their digest and recorded size;
 * `maxBytes` bounds the memory a read takes, by the size on disk. Anything that keeps them from being read (a role
 * recorded as unavailable, a missing, altered or oversized object) is a reason, not a failure, so a debug view can
 * still show the rest of the conversation; only an abort of `signal` or a failing catalog rejects.
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
  if (!artifact?.object_digest) return unavailable(`its ${role} artifact holds no object`);
  let read: VerifiedRead;
  try {
    read = await new ObjectStore(catalog.paths).readVerified(artifact.object_digest, {
      expectedBytes: artifact.byte_size,
      maxBytes,
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    return unavailable(`its ${role} object could not be read: ${errorMessage(error)}`);
  }
  return match(read)
    .with({ status: "verified" }, ({ bytes }): ProvenanceContent => ({ status: "retained", bytes }))
    .with({ status: "missing" }, () => unavailable(`its ${role} object is missing`))
    .with({ status: "corrupt" }, () => unavailable(`its ${role} object does not match its digest`))
    .with({ status: "over_limit" }, () =>
      unavailable(`its ${role} object is over ${maxBytes} bytes`),
    )
    .exhaustive();
};
