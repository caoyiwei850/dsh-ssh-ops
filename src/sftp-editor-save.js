import { randomUUID } from "node:crypto";

const LIMIT = 10 * 1024 * 1024;

async function readBounded(sftp, path) {
  const stream = sftp.createReadStream(path);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > LIMIT) { stream.destroy(); throw new Error("Remote file exceeds the editor size limit"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function write(sftp, path, bytes, options) {
  await new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(path, options);
    stream.once("error", reject);
    stream.once("close", resolve);
    stream.end(bytes);
  });
}

/** Best-effort conflict detection; SFTP has no atomic compare-and-swap. */
export async function saveEditorFile(sftp, path, expected, replacement) {
  if (expected.length > LIMIT || replacement.length > LIMIT) throw new Error("File exceeds the editor size limit");
  const current = await readBounded(sftp, path);
  if (!current.equals(expected)) throw new Error("Remote file changed since it was opened; reload before saving");
  const backup = `${path}.dsh-backup-${randomUUID()}`;
  await write(sftp, backup, current, { flags: "wx", mode: 0o600 });
  try {
    const attrs = await new Promise((resolve, reject) => sftp.stat(backup, (error, value) => error ? reject(error) : resolve(value)));
    if (!Number.isInteger(attrs?.mode) || (attrs.mode & 0o077) !== 0) throw new Error("Backup permissions are not private");
    const backupBytes = await readBounded(sftp, backup);
    if (!backupBytes.equals(current)) throw new Error("Backup verification failed");
    const again = await readBounded(sftp, path);
    if (!again.equals(current)) throw new Error("Remote file changed during save; reload before saving");
    await write(sftp, path, replacement);
    return { backup, bytes: replacement.length };
  } catch (error) {
    throw new Error(`${error.message}; backup: ${backup}`);
  }
}
