import { parseArgs } from "node:util";
import { startServer } from "./server.ts";

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) {
  console.error("usage: mia-server --config <profile.json>");
  process.exit(2);
}
try {
  const server = await startServer({ profilePath: values.config });
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  console.error(`mia-server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
