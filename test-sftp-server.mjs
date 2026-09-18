/**
 * A small, sandboxed SFTP subsystem for test-sshd.mjs: enough of the protocol
 * for the plugin's file manager, editor and export paths to run against a real
 * SFTP server offline. Every path is resolved inside one root directory, so a
 * test client can never touch the rest of the disk.
 *
 * ssh2 ships the framing but no filesystem backend, so the request handlers
 * live here. Anything not implemented answers a status code instead of staying
 * silent — a client that waits forever is much harder to debug than `FAILURE`.
 */
import fs from "node:fs";
import path from "node:path";

const STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 };

// SSH_FXF_* flags from the SFTP draft (what OpenSSH sends).
const FXF = { READ: 0x01, WRITE: 0x02, APPEND: 0x04, CREAT: 0x08, TRUNC: 0x10, EXCL: 0x20 };

function nodeFlags(flags) {
  const read = (flags & FXF.READ) !== 0;
  const write = (flags & FXF.WRITE) !== 0;
  if (!write) return "r";
  if (flags & FXF.APPEND) return read ? "a+" : "a";
  if (read) return (flags & FXF.CREAT) ? "r+" : "r+";
  if ((flags & FXF.CREAT) && (flags & FXF.TRUNC)) return "w";
  if (flags & FXF.CREAT) return "w";
  return "r+";
}

function toAttrs(stat) {
  return {
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000)
  };
}

/** A crude `ls -l` line; clients that parse it (and ours does not) see a sane shape. */
function longName(name, stat) {
  const kind = stat.isDirectory() ? "d" : "-";
  return `${kind}rw-r--r-- 1 test test ${String(stat.size).padStart(8)} ${name}`;
}

/**
 * Serve one accepted SFTP session.
 * @param sftp - the server-side SFTPStream (from `session.on("sftp", accept)`).
 * @param options - `{ root }`: the only directory this server exposes.
 */
export function attachSftp(sftp, { root }) {
  const realRoot = fs.realpathSync(root);
  /** handle -> { kind: 'file', fd } | { kind: 'dir', entries, index } */
  const handles = new Map();
  let counter = 0;

  const fail = (reqid, code) => { try { sftp.status(reqid, code); } catch { /* stream gone */ } };

  /** Resolve a client path inside the sandbox; throws for escapes. */
  const resolve = (clientPath) => {
    const raw = String(clientPath ?? "");
    const normalized = path.posix.normalize(raw.startsWith("/") ? raw : `/${raw}`);
    const abs = path.resolve(realRoot, `.${normalized}`);
    if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) {
      throw new Error(`path escapes sandbox: ${raw}`);
    }
    return abs;
  };

  const newHandle = () => {
    counter += 1;
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(counter);
    return buffer;
  };

  const handleKey = (handle) => Buffer.from(handle).readUInt32BE(0);

  sftp.on("REALPATH", (reqid, clientPath) => {
    try {
      const abs = resolve(clientPath);
      const shown = abs === realRoot ? "/" : `/${path.relative(realRoot, abs).split(path.sep).join("/")}`;
      sftp.name(reqid, [{ filename: shown, longname: shown, attrs: {} }]);
    } catch {
      fail(reqid, STATUS.PERMISSION_DENIED);
    }
  });

  sftp.on("STAT", (reqid, clientPath) => {
    try { sftp.attrs(reqid, toAttrs(fs.statSync(resolve(clientPath)))); }
    catch (error) { fail(reqid, error.code === "ENOENT" ? STATUS.NO_SUCH_FILE : STATUS.FAILURE); }
  });

  sftp.on("LSTAT", (reqid, clientPath) => {
    try { sftp.attrs(reqid, toAttrs(fs.lstatSync(resolve(clientPath)))); }
    catch (error) { fail(reqid, error.code === "ENOENT" ? STATUS.NO_SUCH_FILE : STATUS.FAILURE); }
  });

  sftp.on("FSTAT", (reqid, handle) => {
    const entry = handles.get(handleKey(handle));
    if (entry?.kind !== "file") { fail(reqid, STATUS.FAILURE); return; }
    try { sftp.attrs(reqid, toAttrs(fs.fstatSync(entry.fd))); }
    catch { fail(reqid, STATUS.FAILURE); }
  });

  sftp.on("OPEN", (reqid, filename, flags) => {
    try {
      const fd = fs.openSync(resolve(filename), nodeFlags(Number(flags)));
      const handle = newHandle();
      handles.set(handleKey(handle), { kind: "file", fd });
      sftp.handle(reqid, handle);
    } catch (error) {
      fail(reqid, error.code === "ENOENT" ? STATUS.NO_SUCH_FILE
        : error.code === "EACCES" ? STATUS.PERMISSION_DENIED : STATUS.FAILURE);
    }
  });

  sftp.on("READ", (reqid, handle, offset, length) => {
    const entry = handles.get(handleKey(handle));
    if (entry?.kind !== "file") { fail(reqid, STATUS.FAILURE); return; }
    try {
      const buffer = Buffer.alloc(Number(length));
      const read = fs.readSync(entry.fd, buffer, 0, buffer.length, Number(offset));
      if (read <= 0) { fail(reqid, STATUS.EOF); return; }
      sftp.data(reqid, buffer.subarray(0, read));
    } catch { fail(reqid, STATUS.FAILURE); }
  });

  sftp.on("WRITE", (reqid, handle, offset, data) => {
    const entry = handles.get(handleKey(handle));
    if (entry?.kind !== "file") { fail(reqid, STATUS.FAILURE); return; }
    try {
      const at = Number(offset) < 0 ? null : Number(offset);
      fs.writeSync(entry.fd, data, 0, data.length, at);
      sftp.status(reqid, STATUS.OK);
    } catch { fail(reqid, STATUS.FAILURE); }
  });

  sftp.on("OPENDIR", (reqid, clientPath) => {
    try {
      const abs = resolve(clientPath);
      const names = fs.readdirSync(abs, { withFileTypes: true });
      const entries = names.map((dirent) => {
        const entryPath = path.join(abs, dirent.name);
        const stat = fs.lstatSync(entryPath);
        return {
          filename: dirent.name,
          longname: longName(dirent.name, stat),
          attrs: toAttrs(stat),
          isDirectory: stat.isDirectory()
        };
      });
      const handle = newHandle();
      handles.set(handleKey(handle), { kind: "dir", entries, index: 0 });
      sftp.handle(reqid, handle);
    } catch (error) {
      fail(reqid, error.code === "ENOENT" ? STATUS.NO_SUCH_FILE : STATUS.FAILURE);
    }
  });

  sftp.on("READDIR", (reqid, handle) => {
    const entry = handles.get(handleKey(handle));
    if (entry?.kind !== "dir") { fail(reqid, STATUS.FAILURE); return; }
    // The wire listing carries filename/longname/attrs only; isDirectory was
    // an internal convenience for callers of this server, not a protocol field.
    const page = entry.entries.slice(entry.index, entry.index + 100)
      .map((item) => ({ filename: item.filename, longname: item.longname, attrs: item.attrs }));
    entry.index += page.length;
    if (page.length === 0) { fail(reqid, STATUS.EOF); return; }
    sftp.name(reqid, page);
  });

  sftp.on("CLOSE", (reqid, handle) => {
    const key = handleKey(handle);
    const entry = handles.get(key);
    handles.delete(key);
    if (entry?.kind === "file") { try { fs.closeSync(entry.fd); } catch { /* already gone */ } }
    sftp.status(reqid, STATUS.OK);
  });

  sftp.on("MKDIR", (reqid, clientPath) => {
    try { fs.mkdirSync(resolve(clientPath)); sftp.status(reqid, STATUS.OK); }
    catch (error) { fail(reqid, error.code === "EEXIST" ? STATUS.FAILURE : STATUS.FAILURE); }
  });

  sftp.on("RMDIR", (reqid, clientPath) => {
    try { fs.rmdirSync(resolve(clientPath)); sftp.status(reqid, STATUS.OK); }
    catch (error) { fail(reqid, error.code === "ENOENT" ? STATUS.NO_SUCH_FILE : STATUS.FAILURE); }
  });

  sftp.on("REMOVE", (reqid, clientPath) => {
    try { fs.unlinkSync(resolve(clientPath)); sftp.status(reqid, STATUS.OK); }
    catch (error) { fail(reqid, error.code === "ENOENT" ? STATUS.NO_SUCH_FILE : STATUS.FAILURE); }
  });

  sftp.on("RENAME", (reqid, from, to) => {
    try { fs.renameSync(resolve(from), resolve(to)); sftp.status(reqid, STATUS.OK); }
    catch (error) { fail(reqid, error.code === "ENOENT" ? STATUS.NO_SUCH_FILE : STATUS.FAILURE); }
  });

  sftp.on("SETSTAT", (reqid, clientPath, attrs) => {
    try {
      const abs = resolve(clientPath);
      if (typeof attrs?.mode === "number") fs.chmodSync(abs, attrs.mode & 0o7777);
      if (typeof attrs?.size === "number") fs.truncateSync(abs, attrs.size);
      sftp.status(reqid, STATUS.OK);
    } catch { fail(reqid, STATUS.FAILURE); }
  });

  sftp.on("FSETSTAT", (reqid, handle, attrs) => {
    const entry = handles.get(handleKey(handle));
    if (entry?.kind !== "file") { fail(reqid, STATUS.FAILURE); return; }
    try {
      if (typeof attrs?.mode === "number") fs.fchmodSync(entry.fd, attrs.mode & 0o7777);
      sftp.status(reqid, STATUS.OK);
    } catch { fail(reqid, STATUS.FAILURE); }
  });

  sftp.on("READLINK", (reqid, clientPath) => {
    try {
      const target = fs.readlinkSync(resolve(clientPath));
      sftp.name(reqid, [{ filename: target, longname: target, attrs: {} }]);
    } catch { fail(reqid, STATUS.FAILURE); }
  });

  // Anything else (EXTENDED, SYMLINK, …) must still answer.
  sftp.on("EXTENDED", (reqid) => fail(reqid, STATUS.FAILURE));
  sftp.on("SYMLINK", (reqid) => fail(reqid, STATUS.FAILURE));
}
