import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";

// ssh_read 增量读（issue #36-4）：默认（mode "new"）只返回上次读取之后
// 新到达的输出——上下文里已有的历史不重复吐；"tail" 保留旧行为且不推进
// 游标（旁观性回看）；漏读超过 pending 上限时只恢复一次尾部，之后继续增量。

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
  // captureBuffer 滚动后仍只返回新输出，不重复整段尾部。
  const session = wireSession();
  service.appendSessionOutput(session, "x".repeat(600));
  assert.ok(session.captureBuffer.length < 600, "capture 应已被 tail-cap 截短");
  const initial = service.readCurrentConnection({ connectionId: "conn1" });
  assert.equal(initial.value.truncated, true);
  service.appendSessionOutput(session, "y".repeat(400));
  const incremental = service.readCurrentConnection({ connectionId: "conn1" });
  assert.equal(incremental.value.truncated, false);
  assert.equal(incremental.value.data, "y".repeat(400));
  service.appendSessionOutput(session, "z".repeat(20));
  const afterRollover = service.readCurrentConnection({ connectionId: "conn1" });
  assert.equal(afterRollover.value.data, "z".repeat(20), "滚动缓冲区后续仍应保持增量");

  // Redaction also spans reads after the raw baseline itself has rolled.
  service.appendSessionOutput(session, "\nPASSWORD=top-se");
  const secretPrefix = service.readCurrentConnection({ connectionId: "conn1" });
  assert.doesNotMatch(secretPrefix.value.data, /top-se/);
  service.appendSessionOutput(session, "cret\n");
  const secretSuffix = service.readCurrentConnection({ connectionId: "conn1" });
  assert.equal(secretSuffix.value.data, "\n");
  assert.doesNotMatch(secretPrefix.value.data + secretSuffix.value.data, /top-secret/);

  // 如果两次读取之间丢失的输出超过 pending 上限，尾部只补发一次。
  service.appendSessionOutput(session, "q".repeat(700));
  const recovered = service.readCurrentConnection({ connectionId: "conn1" });
  assert.equal(recovered.value.truncated, true);
  assert.equal(recovered.value.data, session.captureBuffer);
  service.appendSessionOutput(session, "r".repeat(10));
  const recoveredIncremental = service.readCurrentConnection({ connectionId: "conn1" });
  assert.equal(recoveredIncremental.value.truncated, false);
  assert.equal(recoveredIncremental.value.data, "r".repeat(10));
}

{
  // 精确达到上限但没有丢字节，不应误报 truncated。
  const session = wireSession();
  service.appendSessionOutput(session, "a".repeat(512));
  const exactLimit = service.readCurrentConnection({ connectionId: "conn1" });
  assert.equal(exactLimit.value.data, "a".repeat(512));
  assert.equal(exactLimit.value.truncated, false);
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
