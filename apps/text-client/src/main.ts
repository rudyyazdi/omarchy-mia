import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { MiaClient } from "./client.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    "secret-file": { type: "string" },
    config: { type: "string" },
  },
});

function resolveConnection(): { url: string; secretFile: string } {
  if (values.config) {
    const profile = JSON.parse(readFileSync(values.config, "utf8")) as { server: { host: string; port: number; secretFile: string } };
    const base = resolve(values.config, "..");
    return { url: `ws://${profile.server.host}:${profile.server.port}`, secretFile: resolve(base, profile.server.secretFile) };
  }
  if (!values.url || !values["secret-file"]) {
    console.error("usage: mia-client --config <profile.json> | --url ws://127.0.0.1:PORT --secret-file <path>");
    process.exit(2);
  }
  return { url: values.url, secretFile: values["secret-file"] };
}

const { url, secretFile } = resolveConnection();
if (!existsSync(secretFile)) {
  console.error(`secret file ${secretFile} not found; start the server first (it creates the secret)`);
  process.exit(1);
}
const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim() || null;
const client = new MiaClient({ url, secret: MiaClient.readSecret(secretFile), build: { name: "mia-text-client", version: "0.1.0", commit, dirty: null } });

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
const out = (line: string) => {
  endStream();
  clearPromptLine();
  process.stdout.write(line + "\n");
  redrawPrompt();
};
const endStream = () => {
  if (!streaming) return;
  process.stdout.write("\n");
  streaming = false;
  redrawPrompt();
};

let currentTask: string | null = null;
const pendingApprovals = new Map<string, { task_id: string; tool_identity: string; intended_action: string; redacted_arguments: unknown }>();

client.on("text_delta", (e) => {
  if (!streaming) {
    clearPromptLine();
    streaming = true;
  }
  process.stdout.write(e.payload.text);
});
client.on("task_started", (e) => {
  currentTask = e.payload.task_id;
  out(`▶ task ${e.payload.task_id} started (epoch ${e.payload.execution_epoch})`);
});
client.on("approval_requested", (e) => {
  pendingApprovals.set(e.payload.approval_id, e.payload);
  out(
    [
      `┌─ APPROVAL REQUIRED  ${e.payload.approval_id}`,
      `│ tool:      ${e.payload.tool_identity}`,
      `│ action:    ${e.payload.intended_action}`,
      `│ arguments: ${JSON.stringify(e.payload.redacted_arguments)}`,
      `│ binding:   call ${e.payload.runtime_call_id} rev ${e.payload.binding_revision} epoch ${e.payload.execution_epoch} digest ${e.payload.argument_digest.slice(0, 12)}…`,
      `└─ type  /approve ${e.payload.approval_id}   or   /reject ${e.payload.approval_id}`,
    ].join("\n"),
  );
});
client.on("approval_resolved", (e) => {
  pendingApprovals.delete(e.payload.approval_id);
  out(`✓ approval ${e.payload.approval_id}: ${e.payload.status}${e.payload.reason ? ` (${e.payload.reason})` : ""}`);
});
client.on("tool_call", (e) => {
  // Arguments are shown once, when the call is first proposed, so a policy-allowed dispatch is never opaque.
  const args = e.payload.status === "proposed" && e.payload.redacted_arguments !== undefined ? ` ${JSON.stringify(e.payload.redacted_arguments)}` : "";
  out(`  · ${e.payload.tool_identity} → ${e.payload.status}${args}${e.payload.detail ? ` (${e.payload.detail})` : ""}`);
});
client.on("interruption_requested", () => out("⏹ interruption requested; action gate closed"));
client.on("interruption_outcome", (e) => {
  const lines = [`⏹ interruption outcome: task ${e.payload.task_status}; runtime ${e.payload.runtime_cancellation}`];
  for (const a of e.payload.actions) lines.push(`    ${a.tool_identity}: ${a.status}${a.detail ? ` — ${a.detail}` : ""}`);
  out(lines.join("\n"));
});
client.on("task_finished", (e) => {
  currentTask = null;
  out(`■ task ${e.payload.task_id} ${e.payload.status}${e.payload.error ? `: ${e.payload.error}` : ""}`);
});
client.on("server_error", (e) => out(`✗ error ${e.payload.code}: ${e.payload.message}`));
client.on("client_error", (m: string) => out(`✗ client: ${m}`));
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

rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "mia> " });
rl.prompt();
rl.on("line", async (line) => {
  const text = line.trim();
  try {
    if (text === "") return;
    const [cmd = "", ...rest] = text.startsWith("/") ? text.split(/\s+/) : [];
    switch (cmd) {
      case "":
        {
          const ack = await client.submitText(text);
          if (ack.disposition !== "accepted") out(`submit ${ack.disposition}${ack.error ? `: ${ack.error.code}: ${ack.error.message}` : ""}`);
        }
        break;
      case "/quit":
        clearInterval(heartbeat);
        client.close();
        break;
      case "/interrupt": {
        if (rest.length > 0) out(`/interrupt takes no argument (ignored: ${rest.join(" ")})`);
        if (!currentTask) out("no running task");
        else {
          const ack = await client.interrupt(currentTask);
          out(`interrupt ${ack.disposition}${ack.error ? `: ${ack.error.message}` : ""}`);
        }
        break;
      }
      case "/approve":
      case "/reject": {
        const id = rest[0];
        const pending = id ? pendingApprovals.get(id) : undefined;
        if (!id || !pending) out(`unknown approval id; pending: ${[...pendingApprovals.keys()].join(", ") || "none"}`);
        else {
          const ack = await client.decide(pending.task_id, id, cmd === "/approve" ? "approve" : "reject");
          out(`decision ${ack.disposition}${ack.error ? `: ${ack.error.code}: ${ack.error.message}` : ""}`);
        }
        break;
      }
      case "/diag":
        out(JSON.stringify(client.diagnostics(), null, 2));
        await client.sendDiagnostics();
        break;
      default:
        // A mistyped command must not become a task for the agent.
        out(`unknown command ${cmd}; commands: /approve <id>, /reject <id>, /interrupt, /diag, /quit`);
    }
  } catch (error) {
    out(`✗ ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rl?.prompt();
  }
});
rl.on("close", () => {
  clearInterval(heartbeat);
  client.close();
});
