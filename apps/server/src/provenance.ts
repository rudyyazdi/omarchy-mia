import { basename } from "node:path";
import { match } from "ts-pattern";
import {
  ADAPTER_VERSION,
  type Profile,
  type RuntimeFileRead,
  type RuntimeFileReader,
  type StaticCapabilities,
} from "@mia/agent-adapter";
import { PROTOCOL_VERSION, redactValue, sha256Hex } from "@mia/protocol";
import type {
  NewId,
  ObjectStore,
  ProvenanceEntryRow,
  ProvenanceRole,
  StoredObject,
} from "@mia/records";
import type { BuildInfo } from "./build-info.ts";
import type { EngineRecord } from "./engine-records.ts";

/**
 * What the running server is: the runtime it launches and the source tree it loaded. `startServer`
 * computes it once before it listens, because both describe the process rather than a conversation and
 * collecting them runs child processes that would stall every connection mid-serve. A runtime upgraded
 * mid-run leaves `runtime.runtime_version` stale; each execution's retained init event records the
 * version that actually ran.
 */
export interface ServerIdentity {
  runtime: StaticCapabilities;
  build: BuildInfo;
}

export interface ProvenanceSummary {
  provenance_set_id: string;
  agent_prompt_digest: string | null;
  agent_prompt_version: string | null;
  configuration_digest: string;
  architecture_revision: string | null;
  server_build: Omit<BuildInfo, "local_changes">;
  runtime_version: string | null;
  entries: Pick<ProvenanceEntryRow, "role" | "availability" | "artifact_id" | "reason">[];
}

/** A file that shaped a conversation, read before its transaction; `bytes` is null when the file did not exist. */
export interface ConversationFile {
  path: string;
  bytes: Buffer | null;
}

/** The files a conversation's provenance retains, read by `readConversationFiles`. */
export interface ConversationFiles {
  agentPrompt: ConversationFile;
  architecture: ConversationFile;
}

/**
 * The most a conversation file may hold. The agent prompt and the architecture document are text measured in KiB;
 * the cap bounds the memory a misconfigured path (a disk image, a log) can take before the start is refused.
 */
export const MAX_CONVERSATION_FILE_BYTES = 16 * 1024 * 1024;

const conversationFile = (path: string, read: RuntimeFileRead): ConversationFile => {
  if (read.status === "absent") return { path, bytes: null };
  if (read.status === "unreadable") throw new Error(`${path} is unreadable: ${read.reason}`);
  return { path, bytes: read.bytes };
};

/**
 * Reads the profile's agent prompt and architecture document before the transaction that records a conversation
 * opens. The read is bounded like a turn-end read: it opens without blocking, refuses anything but a regular file,
 * refuses a file over `MAX_CONVERSATION_FILE_BYTES`, and is abandoned once `signal` aborts. Only a file that does
 * not exist is recorded as unavailable; any other failure throws, and no conversation starts, because a
 * misconfigured path should not silently drop provenance.
 */
export const readConversationFiles = async (input: {
  profile: Profile;
  read: RuntimeFileReader;
  signal: AbortSignal;
}): Promise<ConversationFiles> => {
  const { profile, read, signal } = input;
  const options = { signal, maxBytes: MAX_CONVERSATION_FILE_BYTES };
  const promptPath = profile.runtime.agentPromptFile;
  const architecturePath = profile.architectureDocument;
  const [agentPrompt, architecture] = await Promise.all([
    read(promptPath, options),
    read(architecturePath, options),
  ]);
  return {
    agentPrompt: conversationFile(promptPath, agentPrompt),
    architecture: conversationFile(architecturePath, architecture),
  };
};

/**
 * One provenance entry, decided before the transaction: its content to retain (the bytes, then the object they
 * were stored as), or why it is unavailable.
 */
export type ProvenanceItem<Content> =
  | { availability: "unavailable"; role: ProvenanceRole; reason: string }
  | {
      availability: "retained";
      role: ProvenanceRole;
      content: Content;
      version: string | null;
      mime: string;
      logicalName: string;
    };

/** Everything a conversation's provenance records, decided before its transaction opens. */
export interface ProvenancePlan<Content> {
  description: string;
  items: ProvenanceItem<Content>[];
  summary: Omit<ProvenanceSummary, "provenance_set_id" | "agent_prompt_digest" | "entries">;
}

const unavailable = (role: ProvenanceRole, reason: string): ProvenanceItem<Uint8Array> => ({
  availability: "unavailable",
  role,
  reason,
});

const retained = (
  role: ProvenanceRole,
  input: { bytes: Uint8Array; version: string | null; mime?: string; logicalName?: string },
): ProvenanceItem<Uint8Array> => ({
  availability: "retained",
  role,
  content: input.bytes,
  version: input.version,
  mime: input.mime ?? "application/json",
  logicalName: input.logicalName ?? role,
});

const json = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value, null, 2), "utf8");

/**
 * Decides everything that shaped this conversation, to be retained immutably, except the runtime and build
 * identity, which record the server as it was at startup (see `ServerIdentity`). Later edits to the prompt,
 * configuration or source tree do not change retained objects. Pure: the files were read beforehand, and
 * `storeProvenance` does the I/O, and `provenanceRecords` builds the rows.
 */
export const planConversationProvenance = (input: {
  profile: Profile;
  /** Client build as reported at connection time. */
  clientBuild: unknown;
  identity: ServerIdentity;
  files: ConversationFiles;
}): ProvenancePlan<Uint8Array> => {
  const { profile, clientBuild, identity, files } = input;
  const items: ProvenanceItem<Uint8Array>[] = [];

  // Mia-owned agent instructions.
  const prompt = files.agentPrompt;
  const promptVersion = prompt.bytes === null ? null : basename(prompt.path).replace(/\.md$/, "");
  items.push(
    prompt.bytes === null
      ? unavailable("agent_prompt", `agent prompt file missing: ${prompt.path}`)
      : retained("agent_prompt", {
          bytes: prompt.bytes,
          version: promptVersion,
          mime: "text/markdown",
          logicalName: basename(prompt.path),
        }),
  );
  // Exposed runtime instructions: the runtime does not expose its full system prompt over the stream.
  items.push(
    unavailable(
      "runtime_instructions",
      "Claude Code does not expose its effective system prompt or inherited CLAUDE.md content over stream-json",
    ),
  );

  // Effective configuration, redacted.
  const configText = JSON.stringify(redactValue(profile), null, 2);
  items.push(
    retained("configuration", { bytes: Buffer.from(configText, "utf8"), version: profile.profile }),
  );

  // Tool contracts: configured servers and per-tool policy (runtime-reported tool lists are recorded per execution).
  items.push(
    retained("tool_contracts", {
      bytes: json({
        mcpServers: redactValue(profile.runtime.mcpServers),
        toolPolicy: profile.runtime.toolPolicy,
        builtinTools: profile.runtime.builtinTools,
      }),
      version: "d1",
    }),
  );

  // Requested model identities and effort; reported values live on executions.
  items.push(
    retained("model_selection", {
      bytes: json({
        requested_model: profile.runtime.model,
        requested_effort: profile.runtime.effort,
        notes: profile.notes,
      }),
      version: "d1",
    }),
  );

  // Runtime and adapter identity.
  const staticCaps = identity.runtime;
  items.push(
    retained("runtime_identity", {
      bytes: json({
        runtime: "claude-code",
        runtime_version: staticCaps.runtime_version,
        executable: staticCaps.executable_resolved,
        adapter_version: ADAPTER_VERSION,
        protocol_version: PROTOCOL_VERSION,
        node: process.version,
      }),
      version: staticCaps.runtime_version ?? "unknown",
    }),
  );

  // Architecture document revision.
  const architecture = files.architecture;
  let architectureRevision: string | null = null;
  if (architecture.bytes === null) {
    items.push(unavailable("architecture", `architecture document missing: ${architecture.path}`));
  } else {
    architectureRevision = sha256Hex(architecture.bytes);
    items.push(
      retained("architecture", {
        bytes: architecture.bytes,
        version: architectureRevision.slice(0, 12),
        mime: "text/markdown",
        logicalName: basename(architecture.path),
      }),
    );
  }

  // Server build, plus retained local changes for dirty trees (recorded as a dependency of the build).
  const build = identity.build;
  const { local_changes: localChanges, ...buildSummary } = build;
  items.push(
    retained("server_build", { bytes: json(buildSummary), version: build.commit ?? "no-git" }),
  );
  if (localChanges)
    items.push(
      retained("server_local_changes", {
        bytes: Buffer.from(localChanges, "utf8"),
        version: build.local_changes_digest,
        mime: "text/x-diff",
        logicalName: "server-local-changes.diff",
      }),
    );

  // Client build as reported at connection time.
  items.push(
    retained("client_build", {
      bytes: json(redactValue(clientBuild ?? null)),
      version: "reported",
    }),
  );

  return {
    description: `conversation provenance for profile ${profile.profile}`,
    items,
    summary: {
      agent_prompt_version: promptVersion,
      configuration_digest: sha256Hex(configText),
      architecture_revision: architectureRevision,
      server_build: buildSummary,
      runtime_version: staticCaps.runtime_version,
    },
  };
};

/**
 * Stores every retained item's bytes before the transaction that records them opens, so the writes and fsyncs
 * stall only this start, never the other connections. A failed or aborted store rejects and no conversation
 * starts; objects already stored stay as unreferenced objects, never a row that points at missing bytes.
 */
export const storeProvenance = async (
  plan: ProvenancePlan<Uint8Array>,
  options: { objects: ObjectStore; signal: AbortSignal },
): Promise<ProvenancePlan<StoredObject>> => {
  const items: ProvenanceItem<StoredObject>[] = [];
  for (const item of plan.items)
    items.push(
      item.availability === "unavailable"
        ? item
        : { ...item, content: await options.objects.put(item.content, { signal: options.signal }) },
    );
  return { ...plan, items };
};

/** A stored plan item with the ids of the rows it records: its entry, and for a retained one its artifact and link. */
export type NamedProvenanceItem =
  | (Extract<ProvenanceItem<StoredObject>, { availability: "unavailable" }> & { entryId: string })
  | (Extract<ProvenanceItem<StoredObject>, { availability: "retained" }> & {
      entryId: string;
      artifactId: string;
      linkId: string;
    });

/** A stored plan with the ids of every row it records, drawn before the start's transaction opens. */
export interface NamedProvenancePlan extends Omit<ProvenancePlan<StoredObject>, "items"> {
  setId: string;
  items: NamedProvenanceItem[];
}

/**
 * Draws the ids a stored plan's rows take, before the transaction that records them, so recording it only writes
 * rows named up front, as a pure `decide` will.
 */
export const nameProvenance = (
  plan: ProvenancePlan<StoredObject>,
  newId: NewId,
): NamedProvenancePlan => ({
  ...plan,
  setId: newId("prov"),
  items: plan.items.map((item) =>
    match(item)
      .with({ availability: "unavailable" }, (unavailable): NamedProvenanceItem => ({
        ...unavailable,
        entryId: newId("pe"),
      }))
      .with({ availability: "retained" }, (retained): NamedProvenanceItem => ({
        ...retained,
        entryId: newId("pe"),
        artifactId: newId("art"),
        linkId: newId("link"),
      }))
      .exhaustive(),
  ),
});

/**
 * The records of a stored, named provenance plan, stamped `createdAt`, and the summary they record. Pure: the bytes
 * were stored and the ids drawn beforehand, so the start's transaction commits these rows and does no file I/O.
 */
export const provenanceRecords = (
  plan: NamedProvenancePlan,
  createdAt: string,
): { records: EngineRecord[]; summary: ProvenanceSummary } => {
  const { setId } = plan;
  const records: EngineRecord[] = [
    {
      kind: "create_provenance_set",
      input: { id: setId, createdAt, description: plan.description },
    },
  ];
  const entries: ProvenanceSummary["entries"] = [];
  const artifacts = new Map<ProvenanceRole, string>();
  let promptDigest: string | null = null;
  for (const item of plan.items) {
    if (item.availability === "unavailable") {
      records.push({
        kind: "add_provenance_entry",
        input: {
          id: item.entryId,
          provenanceSetId: setId,
          role: item.role,
          availability: "unavailable",
          reason: item.reason,
        },
      });
      entries.push({
        role: item.role,
        availability: "unavailable",
        artifact_id: null,
        reason: item.reason,
      });
      continue;
    }
    const { artifactId } = item;
    records.push(
      {
        kind: "register_artifact",
        input: {
          id: artifactId,
          createdAt,
          kind: "snapshot",
          logicalName: item.logicalName,
          mimeType: item.mime,
          schemaVersion: item.version,
          stored: item.content,
        },
      },
      {
        kind: "add_provenance_entry",
        input: {
          id: item.entryId,
          provenanceSetId: setId,
          role: item.role,
          version: item.version,
          artifactId,
          availability: "retained",
        },
      },
    );
    entries.push({
      role: item.role,
      availability: "retained",
      artifact_id: artifactId,
      reason: null,
    });
    artifacts.set(item.role, artifactId);
    // The digest the object was stored under, so the engine can hand the runtime that very object.
    if (item.role === "agent_prompt") promptDigest = item.content.digest;
  }
  const build = artifacts.get("server_build");
  const localChanges = artifacts.get("server_local_changes");
  if (build !== undefined && localChanges !== undefined)
    records.push({
      kind: "add_dependency",
      parentArtifactId: build,
      requiredArtifactId: localChanges,
      relation: "local_changes",
    });
  return {
    records,
    summary: {
      provenance_set_id: setId,
      agent_prompt_digest: promptDigest,
      ...plan.summary,
      entries,
    },
  };
};

/** The records linking every artifact a provenance plan retains into its conversation. */
export const provenanceLinks = (input: {
  conversationId: string;
  plan: NamedProvenancePlan;
}): EngineRecord[] => {
  const { conversationId, plan } = input;
  return plan.items.flatMap((item): EngineRecord[] =>
    item.availability === "retained"
      ? [
          {
            kind: "link_artifact",
            input: {
              id: item.linkId,
              conversationId,
              artifactId: item.artifactId,
              relation: "provenance",
              provenanceSetId: plan.setId,
            },
          },
        ]
      : [],
  );
};
