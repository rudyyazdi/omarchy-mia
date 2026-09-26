import { describe, expect, it } from "vitest";
import type { ProvenanceRole } from "@mia/records";
import {
  provenanceRecords,
  type NamedProvenanceItem,
  type NamedProvenancePlan,
} from "./provenance.ts";

const AT = "2026-01-01T00:00:00.000Z";

const retainedItem = (role: ProvenanceRole): NamedProvenanceItem => ({
  availability: "retained",
  role,
  content: { digest: `digest-${role}`, byteCount: 1, storageKey: `key-${role}` },
  version: null,
  mime: "application/json",
  logicalName: role,
  entryId: `pe-${role}`,
  artifactId: `art-${role}`,
  linkId: `link-${role}`,
});

const planOf = (items: NamedProvenanceItem[]): NamedProvenancePlan => ({
  setId: "prov-1",
  description: "test",
  items,
  summary: {
    agent_prompt_version: null,
    configuration_digest: "config",
    architecture_revision: null,
    server_build: {
      name: "mia",
      version: "0",
      commit: null,
      dirty: null,
      local_changes_digest: null,
      source_root: "/",
    },
    runtime_version: null,
  },
});

const unavailablePrompt: NamedProvenanceItem = {
  availability: "unavailable",
  role: "agent_prompt",
  reason: "missing",
  entryId: "pe-agent_prompt",
};

describe("provenanceRecords", () => {
  it("records an unavailable entry without an artifact, and no prompt digest", () => {
    const { records, summary } = provenanceRecords(planOf([unavailablePrompt]), AT);
    expect(records.map((record) => record.kind)).toEqual([
      "create_provenance_set",
      "add_provenance_entry",
    ]);
    expect(summary).toMatchObject({
      provenance_set_id: "prov-1",
      agent_prompt_digest: null,
      entries: [
        { role: "agent_prompt", availability: "unavailable", artifact_id: null, reason: "missing" },
      ],
    });
  });

  it("names the retained prompt's digest and makes local changes a dependency of the build", () => {
    const { records, summary } = provenanceRecords(
      planOf([
        retainedItem("agent_prompt"),
        retainedItem("server_build"),
        retainedItem("server_local_changes"),
      ]),
      AT,
    );
    expect(summary.agent_prompt_digest).toBe("digest-agent_prompt");
    expect(records.at(-1)).toEqual({
      kind: "add_dependency",
      parentArtifactId: "art-server_build",
      requiredArtifactId: "art-server_local_changes",
      relation: "local_changes",
    });
  });

  it("records no dependency for a build without retained local changes", () => {
    const { records } = provenanceRecords(planOf([retainedItem("server_build")]), AT);
    expect(records.some((record) => record.kind === "add_dependency")).toBe(false);
  });
});
