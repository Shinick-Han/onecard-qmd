/** One JSON request on stdin, one response on stdout. No source commands. */
import { readFileSync } from "node:fs";
import { AdapterError, handleRequest } from "./bridge.js";

try {
  const raw = readFileSync(0, "utf8");
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new AdapterError("request_too_large", "Request exceeds the protocol budget.");
  console.log(JSON.stringify(await handleRequest(JSON.parse(raw))));
} catch (error) {
  console.log(JSON.stringify({ schema_version: 1, error: {
    code: error instanceof AdapterError ? error.code : "qmd_operation_failed",
    message: error instanceof AdapterError ? error.message : "QMD operation failed; local files were preserved.",
  } }));
  process.exitCode = 1;
}
