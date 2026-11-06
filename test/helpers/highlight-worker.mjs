import { Worker } from "node:worker_threads";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRegexRunner } from "../../src/client/terminal-display/regex-runner.js";

const bundle = buildSync({ entryPoints: [fileURLToPath(new URL("../../src/client/terminal-display/highlight-worker.js", import.meta.url))], bundle: true,
  write: false, platform: "browser", format: "iife", target: "es2022" }).outputFiles[0].text;
export function createNodeHighlightWorker() {
  const worker = new Worker(`const {parentPort} = require('node:worker_threads');
    globalThis.self = { postMessage: (data) => parentPort.postMessage(data) };
    parentPort.on('message', (data) => self.onmessage({data}));\n${bundle}`, { eval: true });
  const adapter = { postMessage: (data) => worker.postMessage(data), terminate: () => worker.terminate(), onmessage: null, onerror: null };
  worker.on("message", (data) => adapter.onmessage?.({ data }));
  worker.on("error", (error) => adapter.onerror?.(error));
  return adapter;
}
const runner = createRegexRunner({ createWorker: createNodeHighlightWorker, timeoutMs: 300, startupMs: 5000 });
export const acquireTestMatcher = () => runner.acquire();
