import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { match, P } from "ts-pattern";
import { z } from "zod";
import { errorMessage, type EventPayload, type ServerEventOf } from "@mia/protocol";
import { MiaClient } from "./client.ts";

const USAGE =
  "usage: mia-client --config <profile.json> | --url ws://127.0.0.1:PORT --secret-file <path>";

const program = new Command()
  .name("mia-client")
  .usage("--config <profile.json> | --url ws://127.0.0.1:PORT --secret-file <path>")
  .option("--url <ws-url>", "server WebSocket URL")
  .option("--secret-file <path>", "file holding the client secret the server created")
  .option("--config <profile.json>", "server profile to read the connection from")
  .exitOverride((error) => {
    if (error.exitCode === 0) process.exit(0);
    console.error(USAGE);
    process.exit(2);
  })
  .configureOutput({ writeErr: () => undefined });
program.parse();
const values = program.opts<{ url?: string; secretFile?: string; config?: string }>();

const ProfileConnectionSchema = z.object({
  server: z.object({ host: z.string(), port: z.number(), secretFile: z.string() }),
});

const resolveConnection = (): { url: string; secretFile: string } => {
  if (values.config) {
    const profile = ProfileConnectionSchema.parse(JSON.parse(readFileSync(values.config, "utf8")));
    const base = resolve(values.config, "..");
    return {
      url: `ws://${profile.server.host}:${profile.server.port}`,
      secretFile: resolve(base, profile.server.secretFile),
    };
  }
  if (!values.url || !values.secretFile) {
    console.error(USAGE);
    process.exit(2);
  }
  return { url: values.url, secretFile: values.secretFile };
};

const { url, secretFile } = resolveConnection();
if (!existsSync(secretFile)) {
  console.error(
    `secret file ${secretFile} not found; start the server first (it creates the secret)`,
  );
  process.exit(1);
}
const commit =
  spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim() || null;
const client = new MiaClient({
  url,
  secret: MiaClient.readSecret(secretFile),
  build: { name: "mia-text-client", version: "0.1.0", commit, dirty: null },
});

// Server events arrive while the person may be mid-line. Every write first clears the prompt line and, once the
// output is complete, redraws the prompt with whatever they had typed, so events never land inside their input.
let rl: Interface | null = null;
let streaming = false;
const interactive = Boolean(process.stdout.isTTY);
const clearPromptLine = () => {
  if (rl && interactive) {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
  }
};
const redrawPrompt = () => rl?.prompt(true);
const endStream = () => {
  if (!streaming) return;
  process.stdout.write("\n");
  streaming = false;
  redrawPrompt();
};
const out = (line: string) => {
  endStream();
  clearPromptLine();
  process.stdout.write(line + "\n");
  redrawPrompt();
};

let currentTask: string | null = null;
const pendingApprovals = new Map<string, EventPayload<"approval_requested">>();

client.on("text_delta", (event: ServerEventOf<"text_delta">) => {
  if (!streaming) {
    clearPromptLine();
    streaming = true;
  }
  process.stdout.write(event.payload.text);
});
client.on("task_started", (event: ServerEventOf<"task_started">) => {
  currentTask = event.payload.task_id;
  out(`▶ task ${event.payload.task_id} started (epoch ${event.payload.execution_epoch})`);
});
client.on("approval_requested", (event: ServerEventOf<"approval_requested">) => {
  pendingApprovals.set(event.payload.approval_id, event.payload);
  out(
    [
      `┌─ APPROVAL REQUIRED  ${event.payload.approval_id}`,
      `│ tool:      ${event.payload.tool_identity}`,
      `│ action:    ${event.payload.intended_action}`,
      `│ arguments: ${JSON.stringify(event.payload.redacted_arguments)}`,
      `│ binding:   call ${event.payload.runtime_call_id} rev ${event.payload.binding_revision} epoch ${event.payload.execution_epoch} digest ${event.payload.argument_digest.slice(0, 12)}…`,
      `└─ type  /approve ${event.payload.approval_id}   or   /reject ${event.payload.approval_id}`,
    ].join("\n"),
  );
});
client.on("approval_resolved", (event: ServerEventOf<"approval_resolved">) => {
  pendingApprovals.delete(event.payload.approval_id);
  out(
    `✓ approval ${event.payload.approval_id}: ${event.payload.status}${event.payload.reason ? ` (${event.payload.reason})` : ""}`,
  );
});
client.on("tool_call", (event: ServerEventOf<"tool_call">) => {
  // Arguments are shown once, when the call is first proposed, so a policy-allowed dispatch is never opaque.
  const args =
    event.payload.status === "proposed" && event.payload.redacted_arguments !== undefined
      ? ` ${JSON.stringify(event.payload.redacted_arguments)}`
      : "";
  out(
    `  · ${event.payload.tool_identity} → ${event.payload.status}${args}${event.payload.detail ? ` (${event.payload.detail})` : ""}`,
  );
});
client.on("interruption_requested", () => out("⏹ interruption requested; action gate closed"));
client.on("interruption_outcome", (event: ServerEventOf<"interruption_outcome">) => {
  const lines = [
    `⏹ interruption outcome: task ${event.payload.task_status}; runtime ${event.payload.runtime_cancellation}`,
  ];
  for (const action of event.payload.actions)
    lines.push(
      `    ${action.tool_identity}: ${action.status}${action.detail ? ` — ${action.detail}` : ""}`,
    );
  out(lines.join("\n"));
});
client.on("task_finished", (event: ServerEventOf<"task_finished">) => {
  currentTask = null;
  out(
    `■ task ${event.payload.task_id} ${event.payload.status}${event.payload.error ? `: ${event.payload.error}` : ""}`,
  );
});
client.on("server_error", (event: ServerEventOf<"error">) =>
  out(`✗ error ${event.payload.code}: ${event.payload.message}`),
);
client.on("client_error", (message: string) => out(`✗ client: ${message}`));
client.on("disconnected", () => {
  out("connection closed");
  process.exit(0);
});

await client.connect();
await client.sendDiagnostics();
const conversationId = await client.startConversation();
out(`connected to ${url}; conversation ${conversationId}`);
out("type text to submit a task; /approve <id>, /reject <id>, /interrupt, /diag, /quit");
const heartbeat = setInterval(() => void client.heartbeat().catch(() => undefined), 15_000);

const submitTask = async (text: string) => {
  const ack = await client.submitText(text);
  if (ack.disposition !== "accepted")
    out(`submit ${ack.disposition}${ack.error ? `: ${ack.error.code}: ${ack.error.message}` : ""}`);
};

const quit = () => {
  clearInterval(heartbeat);
  client.close();
};

const interruptTask = async (rest: string[]) => {
  if (rest.length > 0) out(`/interrupt takes no argument (ignored: ${rest.join(" ")})`);
  if (!currentTask) {
    out("no running task");
    return;
  }
  const ack = await client.interrupt(currentTask);
  out(`interrupt ${ack.disposition}${ack.error ? `: ${ack.error.message}` : ""}`);
};

const decideApproval = async (decision: "approve" | "reject", rest: string[]) => {
  const id = rest[0];
  const pending = id ? pendingApprovals.get(id) : undefined;
  if (!id || !pending) {
    out(`unknown approval id; pending: ${[...pendingApprovals.keys()].join(", ") || "none"}`);
    return;
  }
  const ack = await client.decide({ taskId: pending.task_id, approvalId: id, decision: decision });
  out(`decision ${ack.disposition}${ack.error ? `: ${ack.error.code}: ${ack.error.message}` : ""}`);
};

const showDiagnostics = async () => {
  out(JSON.stringify(client.diagnostics(), null, 2));
  await client.sendDiagnostics();
};

rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "mia> " });
rl.prompt();
rl.on("line", async (line) => {
  const text = line.trim();
  try {
    if (text === "") return;
    const [cmd = "", ...rest] = text.startsWith("/") ? text.split(/\s+/) : [];
    await match(cmd)
      .with("", () => submitTask(text))
      .with("/quit", () => quit())
      .with("/interrupt", () => interruptTask(rest))
      .with("/approve", () => decideApproval("approve", rest))
      .with("/reject", () => decideApproval("reject", rest))
      .with("/diag", () => showDiagnostics())
      .with(P.string, () => {
        // A mistyped command must not become a task for the agent.
        out(
          `unknown command ${cmd}; commands: /approve <id>, /reject <id>, /interrupt, /diag, /quit`,
        );
      })
      .exhaustive();
  } catch (error) {
    out(`✗ ${errorMessage(error)}`);
  } finally {
    rl?.prompt();
  }
});
rl.on("close", () => {
  clearInterval(heartbeat);
  client.close();
});
