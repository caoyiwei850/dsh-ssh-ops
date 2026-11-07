import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { saveEditorFile } from "../src/sftp-editor-save.js";

function fixture() {
  const files = new Map([["/config", Buffer.from("old")]]);
  const sftp = {
    stat(_path, callback) { callback(null, { mode: 0o100600 }); },
    createReadStream(path) { if (!files.has(path)) throw new Error("missing"); return Readable.from([files.get(path)]); },
    createWriteStream(path, options) {
      const chunks = [];
      return new Writable({
        write(chunk, _, callback) { chunks.push(Buffer.from(chunk)); callback(); },
        final(callback) {
          if (options?.flags === "wx" && files.has(path)) return callback(new Error("exists"));
          files.set(path, Buffer.concat(chunks));
          callback();
        }
      });
    }
  };
  return { files, sftp };
}

test("save preserves a private backup and rejects stale content", async () => {
  const { files, sftp } = fixture();
  const result = await saveEditorFile(sftp, "/config", Buffer.from("old"), Buffer.from("new"));
  assert.equal(files.get(result.backup).toString(), "old");
  assert.equal(files.get("/config").toString(), "new");
  await assert.rejects(saveEditorFile(sftp, "/config", Buffer.from("old"), Buffer.from("bad")), /changed/);
  assert.equal(files.get("/config").toString(), "new");
  const restore = await saveEditorFile(sftp, "/config", Buffer.from("new"), files.get(result.backup));
  assert.equal(files.get("/config").toString(), "old");
  assert.equal(files.get(restore.backup).toString(), "new");
});

test("a change after backup prevents overwriting and reports backup path", async () => {
  const { files, sftp } = fixture();
  const read = sftp.createReadStream;
  let reads = 0;
  sftp.createReadStream = (path) => { if (++reads === 3) files.set(path, Buffer.from("other")); return read(path); };
  await assert.rejects(saveEditorFile(sftp, "/config", Buffer.from("old"), Buffer.from("new")), /changed during save;.*backup:/);
  assert.equal(files.get("/config").toString(), "other");
});

test("backup verification failure leaves original untouched", async () => {
  const { files, sftp } = fixture();
  const read = sftp.createReadStream;
  sftp.createReadStream = (path) => path.includes(".dsh-backup-") ? Readable.from([Buffer.from("bad")]) : read(path);
  await assert.rejects(saveEditorFile(sftp, "/config", Buffer.from("old"), Buffer.from("new")), /Backup verification failed/);
  assert.equal(files.get("/config").toString(), "old");
});

test("unprotected backup prevents replacing the original", async () => {
  const { files, sftp } = fixture();
  sftp.stat = (_path, callback) => callback(null, { mode: 0o100644 });
  await assert.rejects(saveEditorFile(sftp, "/config", Buffer.from("old"), Buffer.from("new")), /permissions are not private/);
  assert.equal(files.get("/config").toString(), "old");
});
