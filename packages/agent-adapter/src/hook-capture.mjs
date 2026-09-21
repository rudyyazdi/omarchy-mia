// Claude Code hook: append the hook input JSON (which carries the effective effort for tool-use hooks)
// to the evidence file given as argv[2]. Plain JS so the runtime can execute it without a TS loader.
import { appendFileSync } from "node:fs";
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  const out = process.argv[2];
  try {
    const parsed = JSON.parse(data);
    const record = {
      received_at: new Date().toISOString(),
      hook_event_name: parsed.hook_event_name,
      session_id: parsed.session_id,
      tool_name: parsed.tool_name,
      tool_use_id: parsed.tool_use_id,
      effort: parsed.effort,
      model: parsed.model,
      env_claude_effort: process.env.CLAUDE_EFFORT ?? null,
    };
    if (out) appendFileSync(out, JSON.stringify(record) + "\n");
  } catch {
    if (out)
      appendFileSync(
        out,
        JSON.stringify({ received_at: new Date().toISOString(), malformed: true }) + "\n",
      );
  }
  process.stdout.write("{}");
  process.exit(0);
});
