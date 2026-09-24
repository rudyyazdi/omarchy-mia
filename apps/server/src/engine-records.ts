import { match } from "ts-pattern";
import type { RecordWriter } from "@mia/records";

/** A writer operation's name. */
type Operation = {
  [Key in keyof RecordWriter]: RecordWriter[Key] extends (...args: never[]) => unknown
    ? Key
    : never;
}[keyof RecordWriter];

/** The arguments writer operation `Name` takes. */
type ArgumentsOf<Name extends Operation> = Parameters<RecordWriter[Name]>;

/** The input a single-argument writer operation takes. */
type InputOf<Name extends Operation> = ArgumentsOf<Name>[0];

/** The id of the row an update writer operation changes. */
type IdOf<Name extends Operation> = ArgumentsOf<Name>[0];

/** The fields an update writer operation takes after the row's id. */
type FieldsOf<Name extends Operation> = ArgumentsOf<Name>[1];

/**
 * One write the engine commits, as data: each writer operation a transition performs. A transition builds its
 * records without touching the catalog, and `commitRecords` writes them together, so what a transition decides can be
 * returned by a pure `decide` and committed by the kernel. Records keep the order they were built in; that order is
 * the order the catalog numbers events in.
 */
export type EngineRecord =
  | { kind: "append_event"; input: InputOf<"appendEvent"> }
  | { kind: "create_provenance_set"; input: InputOf<"createProvenanceSet"> }
  | { kind: "add_provenance_entry"; input: InputOf<"addProvenanceEntry"> }
  | { kind: "register_artifact"; input: InputOf<"registerArtifact"> }
  | {
      kind: "add_dependency";
      parentArtifactId: ArgumentsOf<"addDependency">[0];
      requiredArtifactId: ArgumentsOf<"addDependency">[1];
      relation: ArgumentsOf<"addDependency">[2];
    }
  | { kind: "link_artifact"; input: InputOf<"linkArtifact"> }
  | { kind: "create_conversation"; input: InputOf<"createConversation"> }
  | {
      kind: "update_conversation";
      id: IdOf<"updateConversation">;
      fields: FieldsOf<"updateConversation">;
    }
  | { kind: "create_task"; input: InputOf<"createTask"> }
  | { kind: "update_task"; id: IdOf<"updateTask">; fields: FieldsOf<"updateTask"> }
  | { kind: "create_execution"; input: InputOf<"createExecution"> }
  | { kind: "update_execution"; id: IdOf<"updateExecution">; fields: FieldsOf<"updateExecution"> }
  | { kind: "create_tool_call"; input: InputOf<"createToolCall"> }
  | { kind: "update_tool_call"; id: IdOf<"updateToolCall">; fields: FieldsOf<"updateToolCall"> }
  | { kind: "create_approval"; input: InputOf<"createApproval"> }
  | { kind: "update_approval"; id: IdOf<"updateApproval">; fields: FieldsOf<"updateApproval"> }
  | { kind: "record_diagnostics"; input: InputOf<"recordDiagnostics"> };

/** What committing one record changed: an event, with the sequence the catalog gave it, or some other row. */
export type CommittedChange = { kind: "event"; id: string; sequence: number } | { kind: "row" };

const ROW: CommittedChange = { kind: "row" };

const writeRecord = (writer: RecordWriter, record: EngineRecord): CommittedChange =>
  match(record)
    .with({ kind: "append_event" }, ({ input }): CommittedChange => {
      const { id, sequence } = writer.appendEvent(input);
      return { kind: "event", id, sequence };
    })
    .with({ kind: "create_provenance_set" }, ({ input }) => {
      writer.createProvenanceSet(input);
      return ROW;
    })
    .with({ kind: "add_provenance_entry" }, ({ input }) => {
      writer.addProvenanceEntry(input);
      return ROW;
    })
    .with({ kind: "register_artifact" }, ({ input }) => {
      writer.registerArtifact(input);
      return ROW;
    })
    .with({ kind: "add_dependency" }, (dependency) => {
      writer.addDependency(
        dependency.parentArtifactId,
        dependency.requiredArtifactId,
        dependency.relation,
      );
      return ROW;
    })
    .with({ kind: "link_artifact" }, ({ input }) => {
      writer.linkArtifact(input);
      return ROW;
    })
    .with({ kind: "create_conversation" }, ({ input }) => {
      writer.createConversation(input);
      return ROW;
    })
    .with({ kind: "update_conversation" }, ({ id, fields }) => {
      writer.updateConversation(id, fields);
      return ROW;
    })
    .with({ kind: "create_task" }, ({ input }) => {
      writer.createTask(input);
      return ROW;
    })
    .with({ kind: "update_task" }, ({ id, fields }) => {
      writer.updateTask(id, fields);
      return ROW;
    })
    .with({ kind: "create_execution" }, ({ input }) => {
      writer.createExecution(input);
      return ROW;
    })
    .with({ kind: "update_execution" }, ({ id, fields }) => {
      writer.updateExecution(id, fields);
      return ROW;
    })
    .with({ kind: "create_tool_call" }, ({ input }) => {
      writer.createToolCall(input);
      return ROW;
    })
    .with({ kind: "update_tool_call" }, ({ id, fields }) => {
      writer.updateToolCall(id, fields);
      return ROW;
    })
    .with({ kind: "create_approval" }, ({ input }) => {
      writer.createApproval(input);
      return ROW;
    })
    .with({ kind: "update_approval" }, ({ id, fields }) => {
      writer.updateApproval(id, fields);
      return ROW;
    })
    .with({ kind: "record_diagnostics" }, ({ input }) => {
      writer.recordDiagnostics(input);
      return ROW;
    })
    .exhaustive();

/**
 * Writes `records` in order in one catalog transaction and returns what each committed, aligned by index with
 * `records`. A record that fails rolls the whole transaction back and throws, so either every record commits or
 * none does. No records open no transaction: a memory-only transition commits nothing, so a catalog that cannot
 * commit does not refuse it.
 */
export const commitRecords = (
  writer: RecordWriter,
  records: readonly EngineRecord[],
): CommittedChange[] =>
  records.length === 0
    ? []
    : writer.catalog.transaction(() => records.map((record) => writeRecord(writer, record)));

/** The sequence the catalog gave the committed event `eventId`; it throws when `changes` holds no such event. */
export const eventSequence = (changes: readonly CommittedChange[], eventId: string): number => {
  const change = changes.find(
    (committed) => committed.kind === "event" && committed.id === eventId,
  );
  if (change?.kind !== "event") throw new Error(`event ${eventId} was not committed`);
  return change.sequence;
};
