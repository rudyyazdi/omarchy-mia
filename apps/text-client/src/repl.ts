import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import { resolve } from "node:path";
import { match, P } from "ts-pattern";
import { z } from "zod";
import { errorMessage, type EventPayload, type ServerEventOf } from "@mia/protocol";
import { MiaClient } from "./client.ts";

/** Where to connect: read from a server profile, or given directly. */
export type ConnectionOptions = { config: string } | { url: string; secretFile: string };

/** The streams the person types into and reads from; main.ts passes process.stdin and process.stdout. */
export interface TextClientIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream & { isTTY?: boolean };
}

const ProfileConnectionSchema = z.object({
  server: z.object({ host: z.string(), port: z.number(), secretFile: z.string() }),
});

const resolveConnection = (options: ConnectionOptions): { url: string; secretFile: string } => {
  if (!("config" in options)) return options;
  const profile = ProfileConnectionSchema.parse(JSON.parse(readFileSync(options.config, "utf8")));
  const base = resolve(options.config, "..");
  return {
    url: `ws://${profile.server.host}:${profile.server.port}`,
    secretFile: resolve(base, profile.server.secretFile),
  };
};

/**
 * Server events arrive while the person may be mid-line. Every write first clears the prompt line and, once the
 * output is complete, redraws the prompt with whatever they had typed, so events never land inside their input.
 */
class Terminal {
  #rl: Interface | null = null;
  #streaming = false;
  readonly #output: TextClientIo["output"];
  readonly #interactive: boolean;

  constructor(output: TextClientIo["output"]) {
    this.#output = output;
    this.#interactive = output.isTTY === true;
  }

  /**
   * Owns the prompt only while the interface is open: a closed interface throws on prompt(), and events and
   * in-flight lines still report after it closes, so from then on writes go to the output alone.
   */
  attach(rl: Interface): void {
    this.#rl = rl;
    rl.once("close", () => {
      this.#rl = null;
    });
  }

  prompt(): void {
    this.#rl?.prompt();
  }

  stream(text: string): void {
    if (!this.#streaming) {
      this.#clearPromptLine();
      this.#streaming = true;
    }
    this.#output.write(text);
  }

  out(line: string): void {
    this.#endStream();
    this.#clearPromptLine();
    this.#output.write(line + "\n");
    this.#redrawPrompt();
  }

  #clearPromptLine(): void {
    if (this.#rl && this.#interactive) {
      clearLine(this.#output, 0);
      cursorTo(this.#output, 0);
    }
  }

  #redrawPrompt(): void {
    this.#rl?.prompt(true);
  }

  #endStream(): void {
    if (!this.#streaming) return;
    this.#output.write("\n");
    this.#streaming = false;
    this.#redrawPrompt();
  }
}

interface Session {
  client: MiaClient;
  terminal: Terminal;
  currentTask: string | null;
  pendingApprovals: Map<string, EventPayload<"approval_requested">>;
}

const renderEvents = (session: Session): void => {
  const { client, terminal } = session;
  const out = (line: string) => terminal.out(line);
  client.on("text_delta", (event: ServerEventOf<"text_delta">) =>
    terminal.stream(event.payload.text),
  );
  client.on("task_started", (event: ServerEventOf<"task_started">) => {
    session.currentTask = event.payload.task_id;
    out(`▶ task ${event.payload.task_id} started (epoch ${event.payload.execution_epoch})`);
  });
  client.on("approval_requested", (event: ServerEventOf<"approval_requested">) => {
    session.pendingApprovals.set(event.payload.approval_id, event.payload);
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
    session.pendingApprovals.delete(event.payload.approval_id);
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
    session.currentTask = null;
    out(
      `■ task ${event.payload.task_id} ${event.payload.status}${event.payload.error ? `: ${event.payload.error}` : ""}`,
    );
  });
  client.on("server_error", (event: ServerEventOf<"error">) =>
    out(`✗ error ${event.payload.code}: ${event.payload.message}`),
  );
  client.on("client_error", (message: string) => out(`✗ client: ${message}`));
};

/** Runs one typed line: plain text becomes a task, a slash command acts on the session. */
const handleLine = async (session: Session, text: string, quit: () => void): Promise<void> => {
  const { client } = session;
  const out = (line: string) => session.terminal.out(line);
  const [cmd = "", ...rest] = text.startsWith("/") ? text.split(/\s+/) : [];
  const decideApproval = async (decision: "approve" | "reject") => {
    const id = rest[0];
    const pending = id ? session.pendingApprovals.get(id) : undefined;
    if (!id || !pending) {
      out(
        `unknown approval id; pending: ${[...session.pendingApprovals.keys()].join(", ") || "none"}`,
      );
      return;
    }
    const ack = await client.decide({
      taskId: pending.task_id,
      approvalId: id,
      decision: decision,
    });
    out(
      `decision ${ack.disposition}${ack.error ? `: ${ack.error.code}: ${ack.error.message}` : ""}`,
    );
  };
  await match(cmd)
    .with("", async () => {
      const ack = await client.submitText(text);
      if (ack.disposition !== "accepted")
        out(
          `submit ${ack.disposition}${ack.error ? `: ${ack.error.code}: ${ack.error.message}` : ""}`,
        );
    })
    .with("/quit", () => quit())
    .with("/interrupt", async () => {
      if (rest.length > 0) out(`/interrupt takes no argument (ignored: ${rest.join(" ")})`);
      if (!session.currentTask) {
        out("no running task");
        return;
      }
      const ack = await client.interrupt(session.currentTask);
      out(`interrupt ${ack.disposition}${ack.error ? `: ${ack.error.message}` : ""}`);
    })
    .with("/approve", () => decideApproval("approve"))
    .with("/reject", () => decideApproval("reject"))
    .with("/diag", async () => {
      out(JSON.stringify(client.diagnostics(), null, 2));
      await client.sendDiagnostics();
    })
    .with(P.string, () => {
      // A mistyped command must not become a task for the agent.
      out(
        `unknown command ${cmd}; commands: /approve <id>, /reject <id>, /interrupt, /diag, /quit`,
      );
    })
    .exhaustive();
};

const startSession = async (client: MiaClient): Promise<string> => {
  await client.connect();
  try {
    await client.sendDiagnostics();
    return await client.startConversation();
  } catch (error) {
    client.close();
    throw error;
  }
};

/**
 * Connects to the server, starts a conversation and handles typed lines, one at a time and in order, until the
 * person quits, the input ends or the connection closes. It resolves once the last line has been handled and the
 * connection is closed, and rejects if the session cannot start or the input fails; either way the connection is
 * closed, and the exit code is main.ts's to choose.
 */
export const runTextClient = async (
  options: ConnectionOptions,
  io: TextClientIo,
): Promise<void> => {
  const { url, secretFile } = resolveConnection(options);
  if (!existsSync(secretFile))
    throw new Error(
      `secret file ${secretFile} not found; start the server first (it creates the secret)`,
    );
  const commit =
    spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim() || null;
  const client = new MiaClient({
    url,
    secret: MiaClient.readSecret(secretFile),
    build: { name: "mia-text-client", version: "0.1.0", commit, dirty: null },
  });
  const session: Session = {
    client,
    terminal: new Terminal(io.output),
    currentTask: null,
    pendingApprovals: new Map(),
  };
  const out = (line: string) => session.terminal.out(line);
  renderEvents(session);
  // Listening before connecting means a close during setup is not missed. The promise never rejects.
  const closed = Promise.withResolvers<undefined>();
  client.once("disconnected", () => closed.resolve(undefined));

  const conversationId = await startSession(client);
  out(`connected to ${url}; conversation ${conversationId}`);
  out("type text to submit a task; /approve <id>, /reject <id>, /interrupt, /diag, /quit");
  const rl = createInterface({ input: io.input, output: io.output, prompt: "mia> " });
  session.terminal.attach(rl);
  const heartbeat = setInterval(() => void client.heartbeat().catch(() => undefined), 15_000);
  heartbeat.unref();
  // Ends the session at once, dropping lines read but not yet handled; safe to repeat. /quit and the connection
  // closing call it. The input ending does not: the lines it already delivered are handled first.
  const ending = new AbortController();
  const quit = () => {
    ending.abort();
    clearInterval(heartbeat);
    rl.close();
    client.close();
  };
  closed.promise
    .then(() => {
      quit();
      out("connection closed");
    })
    .catch((error: unknown) => console.error(`✗ ${errorMessage(error)}`));

  const onLine = async (line: string): Promise<void> => {
    const text = line.trim();
    try {
      if (text === "") return;
      await handleLine(session, text, quit);
    } catch (error) {
      out(`✗ ${errorMessage(error)}`);
    } finally {
      session.terminal.prompt();
    }
  };
  session.terminal.prompt();
  try {
    // Ends when the interface closes, after the lines it had already read, unless the session ended first.
    for await (const line of rl) {
      if (ending.signal.aborted) break;
      await onLine(line);
    }
  } finally {
    quit();
  }
  await closed.promise;
};
