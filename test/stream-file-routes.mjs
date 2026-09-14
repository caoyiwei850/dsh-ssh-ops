import assert from "node:assert/strict";
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
