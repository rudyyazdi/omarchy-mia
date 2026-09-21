import { parseArgs } from "node:util";
import { startFixture } from "./fixture.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    "mcp-port": { type: "string", default: "0" },
    "harness-port": { type: "string", default: "0" },
  },
});
if (!values.dir) {
  console.error("usage: fixture --dir <disposable-dir> [--mcp-port N] [--harness-port N]");
  process.exit(2);
}
const handle = await startFixture({
  dir: values.dir,
  mcpPort: Number(values["mcp-port"]),
  harnessPort: Number(values["harness-port"]),
});
console.log(JSON.stringify({ mcp_url: handle.mcpUrl, harness_url: handle.harnessUrl, dir: values.dir }));
const shutdown = async () => {
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
