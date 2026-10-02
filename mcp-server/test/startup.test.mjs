import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs against the compiled server: npm run build first (npm test does).
const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/** Starts the stdio server; `ready` resolves with its log once the transport is up. */
function startServer(env) {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const ready = new Promise((resolve, reject) => {
    let log = "";
    child.stderr.on("data", (chunk) => {
      log += chunk;
      if (log.includes("transport ready")) resolve(log);
    });
    child.on("exit", (code) => reject(new Error(`server exited (${code}): ${log}`)));
  });
  return { child, ready };
}

test("starting the server with the agent runtime on creates no database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpfabric-startup-"));
  const { child, ready } = startServer({
    MCPFABRIC_AGENT: "1",
    MCPFABRIC_DATA_DIR: dir,
    MCPFABRIC_TRANSPORT: "stdio",
    MCPFABRIC_URL: "http://127.0.0.1:9", // nothing listens there; no game is needed
  });
  try {
    assert.match(await ready, /agent runtime ready/);
    assert.equal(existsSync(join(dir, "agent.db")), false, "agent.db must wait for the first agent tool call");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
