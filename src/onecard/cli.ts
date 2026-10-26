/** One JSON request on stdin, or a loopback resident server. No source commands. */
import { readFileSync } from "node:fs";
import { AdapterError, MAX_REQUEST_BYTES, handleRequest } from "./bridge.js";
import { startResident } from "./server.js";

async function stdinRequest(): Promise<void> {
  const raw = readFileSync(0, "utf8");
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) throw new AdapterError("request_too_large", "Request exceeds the protocol budget.");
  console.log(JSON.stringify(await handleRequest(JSON.parse(raw))));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    await stdinRequest();
    return;
  }
  const configPath = argv[2];
  if (argv.length === 3 && argv[0] === "--serve" && argv[1] === "--config" && configPath) {
    const resident = await startResident(configPath);
    const shutdown = () => { void resident.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  throw new AdapterError("invalid_request", "Use stdin for one request, or --serve --config ABS.");
}

try {
  await main();
} catch (error) {
  console.log(JSON.stringify({ schema_version: 1, error: {
    code: error instanceof AdapterError ? error.code : "qmd_operation_failed",
    message: error instanceof AdapterError ? error.message : "QMD operation failed; local files were preserved.",
  } }));
  process.exitCode = 1;
}
