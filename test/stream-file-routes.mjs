import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import SshOpsService from "../src/index.js";

function response() {
  return {
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body = "") {
      this.body += body;
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
    }
  };
}

// An SFTP path is not proof that the same absolute path in an SSH exec channel
// is safe: chrooted SFTP and shell namespaces may resolve it differently. The
// emergency mitigation must reject archive requests before any exec path runs.
{
  const service = Object.create(SshOpsService.prototype);
  let archiveCalled = false;
  service.streamDownloadArchive = async () => { archiveCalled = true; };
  const res = response();
  service.handleStreamRoute(
    { method: "GET", url: "/ssh-ops/stream/archive?connectionId=c1&path=%2Fdata", socket: {} },
    res,
    { requestRejection: () => undefined }
  );

  assert.equal(archiveCalled, false, "archive must never enter the SSH exec implementation");
  assert.equal(res.status, 501);
  assert.deepEqual(JSON.parse(res.body), {
    ok: false,
    error: {
      code: "archive-unavailable",
      message: "archive streaming is disabled until SFTP namespace-safe archiving is available"
    }
  });
}

console.log("stream routes: archive namespace guard passed");

// A browser disconnect must stop the upstream SFTP stream, even if the peer
// would otherwise continue producing data indefinitely.
{
  const service = Object.create(SshOpsService.prototype);
  const upstream = new PassThrough();
  service.ctx = { logger: { warn() {} } };
  service.streamPrepareSftp = async () => ({ sftp: {
    stat(_path, cb) { cb(null, { size: 1024, mode: 0o100600 }); },
    createReadStream() { queueMicrotask(() => upstream.emit("open")); return upstream; }
  } });
  const res = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  res.writeHead = () => {};
  await service.streamDownloadFile({}, res, new URL("http://localhost/?path=%2Flarge"), "c1");
  res.destroy();
  await new Promise((resolve) => res.once("close", resolve));
  assert.equal(upstream.destroyed, true, "closing the HTTP response destroys the SFTP reader");
}

{
  const service = Object.create(SshOpsService.prototype);
  const upstream = new PassThrough();
  service.streamPrepareSftp = async () => ({ sftp: {
    stat(_path, cb) { cb(null, { size: 1024, mode: 0o100600 }); },
    createReadStream() { return upstream; }
  } });
  const res = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  const id = "3d706ab7-640f-49bf-9a09-6bce2a82110a";
  const pending = service.streamDownloadFile({}, res, new URL(`http://localhost/?path=%2Flarge&verify=sha256&verificationId=${id}`), "c1");
  await new Promise((resolve) => setImmediate(resolve));
  upstream.write(Buffer.alloc(256));
  await new Promise((resolve) => setImmediate(resolve));
  const poll = (connectionId) => {
    const reply = response();
    service.handleStreamRoute({ method: "GET", url: `/ssh-ops/stream/verification?connectionId=${connectionId}&id=${id}` }, reply, { requestRejection: () => undefined });
    return reply;
  };
  assert.deepEqual(JSON.parse(poll("c1").body), { bytes: 256, total: 1024 });
  assert.equal(poll("c2").status, 404);
  res.destroy();
  await pending;
  assert.equal(upstream.destroyed, true, "cancelling during hashing destroys the SFTP reader");
  assert.equal(poll("c1").status, 404, "progress is removed when cancelled");
}

// A browser upload must never truncate or delete an existing destination when
// the request is cancelled. Only a completed temporary file may replace it.
async function uploadFixture(cancel) {
  const files = new Map([["/data/config", Buffer.from("original")]]);
  const sftp = {
    createWriteStream(path) {
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), chunk]));
          callback();
        }
      });
      queueMicrotask(() => stream.emit("open"));
      return stream;
    },
    stat(path, callback) { callback(files.has(path) ? null : new Error("missing"), files.has(path) ? { size: files.get(path).length } : undefined); },
    unlink(path, callback) { files.delete(path); callback(null); },
    ext_openssh_rename(from, to, callback) {
      if (!files.has(from)) return callback(new Error("temporary file missing"));
      files.set(to, files.get(from));
      files.delete(from);
      callback(null);
    }
  };
  const service = Object.create(SshOpsService.prototype);
  const connection = { client: new EventEmitter() };
  service.streamPrepareSftp = async () => ({ connection, sftp });
  const req = new EventEmitter();
  req.socket = { setTimeout() {}, removeListener() {} };
  req.pause = () => {};
  req.resume = () => {};
  const res = Object.assign(new EventEmitter(), response());
  const finished = new Promise((resolve) => {
    const end = res.end.bind(res);
    res.end = (body) => { end(body); resolve(); };
  });
  await service.streamUploadFile(req, res, new URL("http://localhost/ssh-ops/stream/file?path=%2Fdata%2Fconfig"), "c1");
  req.emit("data", Buffer.from("replacement"));
  if (cancel) req.emit("aborted");
  else req.emit("end");
  await finished;
  assert.equal(files.get("/data/config").toString(), cancel ? "original" : "replacement");
  assert.equal([...files.keys()].some((path) => path.includes(".dsh-upload-")), false);
  assert.equal(res.status, cancel ? 502 : 200);
}

await uploadFixture(true);
await uploadFixture(false);
console.log("stream routes: cancelled upload preserves target; completed upload replaces it");
