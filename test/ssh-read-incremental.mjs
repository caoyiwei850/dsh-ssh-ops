import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";

// ssh_read 增量读（issue #36-4）：默认（mode "new"）只返回上次读取之后
// 新到达的输出——上下文里已有的历史不重复吐；"tail" 保留旧行为且不推进
// 游标（旁观性回看）；capture 被 tail-cap 丢头后游标失效，退化为尾部全量。

const service = Object.create(SshOpsService.prototype);
service.config = {
  maxBufferBytes: 1024,
  maxCaptureBytes: 512,
  maxCommandOutputBytes: 128,
  sessionLogEnabled: false
};
service.wakeWaiters = () => {};

function wireSession() {
  const session = { buffer: "", captureBuffer: "", lastReadRedacted: undefined, exited: null };
  const conn = { host: "192.0.2.10", username: "root", sessions: new Set(["s1"]) };
  service.connections = new Map([["conn1", conn]]);
  service.sessions = new Map([["s1", session]]);
  return session;
}

{
  const session = wireSession();
  service.appendSessionOutput(session, "$ echo one\r\none\r\n");

  // 首次读取（默认 new）：此前什么都没读过，返回全量。
  const first = service.readCurrentConnection({ connectionId: "conn1" });
  assert.equal(first.ok, true);
  assert.match(first.value.data, /one/);
  assert.equal(first.value.hasSession, true);
  assert.equal(first.value.truncated, false);
  assert.equal(session.lastReadRedacted, first.value.data);

  // 后续新输出：new 模式只吐增量，tail 吐全量且不推进游标。
  service.appendSessionOutput(session, "$ echo two\r\ntwo\r\n");
  const second = service.readCurrentConnection({ connectionId: "conn1" });
  assert.doesNotMatch(second.value.data, /one/, "已读过的旧输出不得重复返回");
  assert.match(second.value.data, /two/);

  const redactedBeforeTail = session.lastReadRedacted;
  const tail = service.readCurrentConnection({ connectionId: "conn1", mode: "tail" });
  assert.match(tail.value.data, /one/);
  assert.match(tail.value.data, /two/);
  assert.equal(session.lastReadRedacted, redactedBeforeTail, "tail 回看不得推进游标");

  // tail 之后再读：仍从上次 new 的游标继续，只给新到的。
  service.appendSessionOutput(session, "$ echo three\r\nthree\r\n");
  const third = service.readCurrentConnection({ connectionId: "conn1" });
  assert.doesNotMatch(third.value.data, /one|two/);
  assert.match(third.value.data, /three/);
}

{
  // A credential split across two output writes must never leak its tail.
  const session = wireSession();
  service.appendSessionOutput(session, "PASSWORD=top-se");
  const first = service.readCurrentConnection({ connectionId: "conn1" });
  assert.equal(first.value.data, "PASSWORD=***");
  service.appendSessionOutput(session, "cret\n");
  const second = service.readCurrentConnection({ connectionId: "conn1" });
  assert.doesNotMatch(first.value.data + second.value.data, /top-secret/);
  assert.equal(second.value.data, "\n", "only the safe line boundary is visible; the secret tail stays hidden");
  service.appendSessionOutput(session, "$ next\n");
  const third = service.readCurrentConnection({ connectionId: "conn1" });
  assert.match(third.value.data, /\$ next/);
  assert.doesNotMatch(third.value.data, /top-secret/);
}

{
  // tail-cap 丢头后游标指向缓冲之外：退化为尾部全量而非空串。
  const session = wireSession();
  service.appendSessionOutput(session, "x".repeat(600));
  assert.ok(session.captureBuffer.length < 600, "capture 应已被 tail-cap 截短");
  service.readCurrentConnection({ connectionId: "conn1" });
  service.appendSessionOutput(session, "y".repeat(400));
  const capped = service.readCurrentConnection({ connectionId: "conn1" });
  assert.equal(capped.value.truncated, true);
  assert.equal(capped.value.data, session.captureBuffer, "游标失效时必须回落为尾部全量");
}

{
  // 无活会话：行为与旧版一致（空 data、hasSession false）。
  wireSession();
  service.sessions.get("s1").exited = { code: 0 };
  const empty = service.readCurrentConnection({ connectionId: "conn1" });
  assert.equal(empty.value.hasSession, false);
  assert.equal(empty.value.data, "");
}

{
  // 未连接：错误路径不受影响。
  service.connections = new Map();
  const missing = service.readCurrentConnection({ connectionId: "nope" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "no-connection");
}

console.log("ssh-read-incremental ok");
