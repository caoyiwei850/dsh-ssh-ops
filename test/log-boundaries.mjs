import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SshOpsService from "../src/index.js";
import { registerSessionLogTools } from "../src/tools/session-log.js";

async function fixture(body, fn) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-log-boundary-"));
  const service = Object.create(SshOpsService.prototype); service.config = { sessionLogEnabled: true, sessionLogDir: dir }; service.ctx = {};
  const store = service.sessionLogStore();
  try {
    await store.begin({ sessionId: "one" }); if (body) store.append("one", body); await store.end("one");
    const tools = []; registerSessionLogTools({ tools: { register: (tool) => tools.push(tool) } }, service);
    await fn({ store, read: tools.find((tool) => tool.name === "ssh_session_log_read"), search: tools.find((tool) => tool.name === "ssh_session_log_search") });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("arbitrary page offsets cannot reveal credentials and search offsets use the same safe view", async () => {
  await fixture("PASSWORD=example_secret\nordinary needle\n", async ({ read, search }) => {
    for (let offset = 0; offset < 24; offset += 1) {
      const page = await read.execute({ session_id: "one", offset });
      assert.doesNotMatch(page.data, /example_secret|example_se|xample_secret/);
    }
    const found = await search.execute({ session_id: "one", query: "needle" });
    assert.equal(found.hits.length, 1);
    const page = await read.execute({ session_id: "one", offset: found.hits[0].offset });
    assert.match(page.data, /^ordinary needle/);
    assert.equal((await search.execute({ session_id: "one", query: "example_secret" })).hits.length, 0);
  });
});

test("empty logs search successfully", async () => {
  await fixture("", async ({ store, search }) => {
    assert.deepEqual(await store.search("one", { query: "x" }), { ok: true, hits: [], scannedBytes: 0, stoppedEarly: false });
    assert.deepEqual((await search.execute({ session_id: "one", query: "x" })).hits, []);
  });
});

test("search byte offsets remain correct when UTF-8 characters straddle stream chunks", async () => {
  const prefix = "x".repeat(65535) + "中\n";
  await fixture(prefix + "needle\n", async ({ store }) => {
    const result = await store.search("one", { query: "needle" });
    assert.equal(result.hits[0].offset, Buffer.byteLength(prefix));
  });
});


test("partial private keys and quoted credentials are not exposed", async () => {
  await fixture('PASSWORD="quotedsecret"\nAPI_TOKEN="unfinishedsecret\n-----BEGIN RSA PRIVATE KEY-----\ntruncatedkey', async ({ read }) => {
    for (const offset of [0, 10, 20, 35, 50]) {
      const page = await read.execute({ session_id: "one", offset });
      assert.doesNotMatch(page.data, /quotedsecret|unfinishedsecret|truncatedkey/);
    }
  });
});


test("model pages preserve UTF-8 characters across page boundaries", async () => {
  await fixture("x".repeat(1023) + "中文 tail", async ({ read }) => {
    const first = await read.execute({ session_id: "one", max_bytes: 1024 });
    const second = await read.execute({ session_id: "one", offset: first.nextOffset, max_bytes: 1024 });
    assert.equal(first.data + second.data, "x".repeat(1023) + "中文 tail");
    assert.doesNotMatch(first.data + second.data, /�/);
  });
});

test("an incomplete connection URL is redacted before paging", async () => {
  await fixture("mysql://operator:secretpass", async ({ read }) => {
    const page = await read.execute({ session_id: "one", offset: 0 });
    assert.doesNotMatch(page.data, /secretpass/);
  });
});
