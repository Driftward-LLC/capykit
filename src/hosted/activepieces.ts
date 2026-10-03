import { fork } from "node:child_process";
import { ConnectionError } from "./connections.js";

export type ConnectorInput = { action: "github.get-issue"; resource: string; issueNumber: number } | { action: "drive.get-file"; resource: string } | { action: "drive.search-files"; resource: string; name: string; folderId?: string; pageToken?: string };
let running = 0;
/** Trusted connector code only. All provider I/O is mediated by the parent;
 * no user code, tokens or ambient host environment is passed to the worker. */
export async function runConnector(input: ConnectorInput, request: (signal: AbortSignal) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.resource) && !(input.action === "github.get-issue" && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(input.resource))) throw new ConnectionError("INVALID_REQUEST", 400);
  if (input.action === "github.get-issue" && (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1)) throw new ConnectionError("INVALID_REQUEST", 400);
  if (input.action === "drive.search-files" && (input.name.length > 120 || /['\\\u0000-\u001f]/u.test(input.name) || (input.folderId !== undefined && !/^[A-Za-z0-9_-]{1,200}$/u.test(input.folderId)))) throw new ConnectionError("INVALID_REQUEST",400);
  // ponytail: two trusted actions per API process; durable uploaded-code admission belongs to ENG-125.
  if (running >= 2) throw new ConnectionError("CONNECTOR_BUSY", 429);
  running++;
  const controller = new AbortController();
  try {
    return await new Promise((resolve, reject) => {
      const child = fork(new URL("./activepieces-worker.mjs", import.meta.url), [], { env: {}, execArgv: ["--max-old-space-size=128"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let done = false;
      let requested = false;
      let responded = false;
      const finish = (error?: Error, result?: Record<string, unknown>) => {
        if (done) return;
        done = true; clearTimeout(timer); controller.abort(); child.kill("SIGKILL");
        if (error) reject(error); else resolve(result ?? {});
      };
      const timer = setTimeout(() => { finish(new ConnectionError("CONNECTOR_TIMEOUT", 504)); }, 15_000);
      child.on("error", () => { finish(new ConnectionError("CONNECTOR_FAILED", 502)); });
      child.on("exit", () => { finish(new ConnectionError("CONNECTOR_FAILED", 502)); });
      child.on("message", (message: unknown) => {
        if (done || !message || typeof message !== "object") return;
        const data = message as { type?: string; result?: Record<string, unknown> };
        if (data.type === "request" && !requested) {
          requested = true;
          void request(controller.signal).then(body => {
            if (!done) { responded = true; child.send({ type: "response", body }); }
          }).catch((error: unknown) => { finish(error instanceof ConnectionError ? error : new ConnectionError("CONNECTOR_FAILED", 502)); });
        } else if (data.type === "result" && responded && data.result && Buffer.byteLength(JSON.stringify(data.result)) <= 32_768) finish(undefined, data.result);
        else finish(new ConnectionError("CONNECTOR_FAILED", 502));
      });
      child.send(input);
    });
  } finally { running--; controller.abort(); }
}
