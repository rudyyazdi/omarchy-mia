import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { ADAPTER_VERSION, type Profile, type StaticCapabilities } from "@mia/agent-adapter";
import { PROTOCOL_VERSION, redactValue, sha256Hex } from "@mia/protocol";
import type { ProvenanceEntryRow, ProvenanceRole, RecordWriter } from "@mia/records";
import type { BuildInfo } from "./build-info.ts";

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

/**
 * Snapshot everything that shaped this conversation, immutably, at creation time. Later edits to the
 * prompt, configuration or source tree do not change retained objects.
 */
export const createConversationProvenance = (input: {
  writer: RecordWriter;
  profile: Profile;
  /** Client build as reported at connection time. */
  clientBuild: unknown;
  identity: ServerIdentity;
}): ProvenanceSummary => {
  const { writer, profile, clientBuild, identity } = input;
  const setId = writer.createProvenanceSet(
    `conversation provenance for profile ${profile.profile}`,
  );
  const entries: ProvenanceSummary["entries"] = [];
  const add = (
    role: ProvenanceRole,
    input: {
      text?: string;
      bytes?: Uint8Array;
      version?: string | null;
      mime?: string;
      logicalName?: string;
    } | null,
    reason?: string,
  ) => {
    if (!input) {
      writer.addProvenanceEntry({
        provenanceSetId: setId,
        role,
        availability: "unavailable",
        reason: reason ?? "not exposed",
      });
      entries.push({
        role,
        availability: "unavailable",
        artifact_id: null,
        reason: reason ?? "not exposed",
      });
      return null;
    }
    const bytes = input.bytes ?? Buffer.from(input.text ?? "", "utf8");
    const art = writer.registerArtifact({
      kind: "snapshot",
      logicalName: input.logicalName ?? role,
      mimeType: input.mime ?? "application/json",
      schemaVersion: input.version ?? null,
      bytes,
      captureStatus: "retained",
    });
    writer.addProvenanceEntry({
      provenanceSetId: setId,
      role,
      version: input.version ?? null,
      artifactId: art.artifactId,
      availability: "retained",
    });
    entries.push({ role, availability: "retained", artifact_id: art.artifactId, reason: null });
    return art;
  };

  // Mia-owned agent instructions.
  let promptDigest: string | null = null;
  let promptVersion: string | null = null;
  if (existsSync(profile.runtime.agentPromptFile)) {
    const bytes = readFileSync(profile.runtime.agentPromptFile);
    promptDigest = sha256Hex(bytes);
    promptVersion = basename(profile.runtime.agentPromptFile).replace(/\.md$/, "");
    add("agent_prompt", {
      bytes,
      version: promptVersion,
      mime: "text/markdown",
      logicalName: basename(profile.runtime.agentPromptFile),
    });
  } else {
    add("agent_prompt", null, `agent prompt file missing: ${profile.runtime.agentPromptFile}`);
  }
  // Exposed runtime instructions: the runtime does not expose its full system prompt over the stream.
  add(
    "runtime_instructions",
    null,
    "Claude Code does not expose its effective system prompt or inherited CLAUDE.md content over stream-json",
  );

  // Effective configuration, redacted.
  const configText = JSON.stringify(redactValue(profile), null, 2);
  add("configuration", { text: configText, version: profile.profile });

  // Tool contracts: configured servers and per-tool policy (runtime-reported tool lists are recorded per execution).
  add("tool_contracts", {
    text: JSON.stringify(
      {
        mcpServers: redactValue(profile.runtime.mcpServers),
        toolPolicy: profile.runtime.toolPolicy,
        builtinTools: profile.runtime.builtinTools,
      },
      null,
      2,
    ),
    version: "d1",
  });

  // Requested model identities and effort; reported values live on executions.
  add("model_selection", {
    text: JSON.stringify(
      {
        requested_model: profile.runtime.model,
        requested_effort: profile.runtime.effort,
        notes: profile.notes,
      },
      null,
      2,
    ),
    version: "d1",
  });

  // Runtime and adapter identity.
  const staticCaps = identity.runtime;
  add("runtime_identity", {
    text: JSON.stringify(
      {
        runtime: "claude-code",
        runtime_version: staticCaps.runtime_version,
        executable: staticCaps.executable_resolved,
        adapter_version: ADAPTER_VERSION,
        protocol_version: PROTOCOL_VERSION,
        node: process.version,
      },
      null,
      2,
    ),
    version: staticCaps.runtime_version ?? "unknown",
  });

  // Architecture document revision.
  let architectureRevision: string | null = null;
  if (existsSync(profile.architectureDocument)) {
    const bytes = readFileSync(profile.architectureDocument);
    architectureRevision = sha256Hex(bytes);
    add("architecture", {
      bytes,
      version: architectureRevision.slice(0, 12),
      mime: "text/markdown",
      logicalName: basename(profile.architectureDocument),
    });
  } else {
    add("architecture", null, `architecture document missing: ${profile.architectureDocument}`);
  }

  // Server build, plus retained local changes for dirty trees.
  const build = identity.build;
  const { local_changes: localChanges, ...buildSummary } = build;
  const buildArt = add("server_build", {
    text: JSON.stringify(buildSummary, null, 2),
    version: build.commit ?? "no-git",
  });
  if (localChanges && buildArt) {
    const diffArt = add("server_local_changes", {
      text: localChanges,
      version: build.local_changes_digest,
      mime: "text/x-diff",
      logicalName: "server-local-changes.diff",
    });
    if (diffArt) writer.addDependency(buildArt.artifactId, diffArt.artifactId, "local_changes");
  }

  // Client build as reported at connection time.
  add("client_build", {
    text: JSON.stringify(redactValue(clientBuild ?? null), null, 2),
    version: "reported",
  });

  return {
    provenance_set_id: setId,
    agent_prompt_digest: promptDigest,
    agent_prompt_version: promptVersion,
    configuration_digest: sha256Hex(configText),
    architecture_revision: architectureRevision,
    server_build: buildSummary,
    runtime_version: staticCaps.runtime_version,
    entries,
  };
};
