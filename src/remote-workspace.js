/**
 * Remote workspaces: one DSH workspace directory bound to a saved SSH resource
 * and one absolute remote root (issue #38).
 *
 * The binding never rewrites DSH itself. A Workspace stays the host directory
 * DSH already canonicalized, so every core facility keeps working untouched:
 * `read`/`write`/`edit` keep addressing the local filesystem, `glob`/`grep`
 * keep spawning the packaged local ripgrep, and the native bash tool keeps
 * running on the operator's machine. What the binding buys is (a) a model-
 * visible declaration that names the remote root and the tools that actually
 * reach it, and (b) workspace-relative path resolution plus an implicit
 * connection for this plugin's own SFTP tools — "file work lands on the remote
 * by default" without pretending the local filesystem is the remote one.
 *
 * Remote paths are POSIX regardless of the host platform, so every remote path
 * helper here uses `node:path`'s posix API; only the local side uses the host
 * separator.
 */
import { isAbsolute, relative as hostRelative, sep } from "node:path";
import { posix } from "node:path";
import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";

/** Typed code for a path that resolves outside the bound remote root. */
export const REMOTE_WORKSPACE_OUTSIDE = "remote-workspace-outside";
/** Typed code for a workspace whose bound SSH resource is not connected. */
export const REMOTE_WORKSPACE_OFFLINE = "remote-workspace-offline";

/**
 * One persisted binding. `workspacePath` is the row id (the canonical host
 * directory DSH itself stores for the Workspace), so a re-bind replaces the
 * previous row instead of accumulating duplicates.
 */
export const remoteWorkspaceRecordSchema = z.object({
  workspacePath: z.string(),
  profileId: z.string().uuid(),
  // Absolute POSIX root on the server, e.g. "/srv/app". Never host-ish.
  remotePath: z.string(),
  // Whether this workspace may bring its resource up by itself. Still gated by
  // the operator-wide agentAutoConnect switch in the service.
  autoConnect: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const remoteWorkspaceDomainSpec = defineDomain({
  name: "ssh_ops_workspaces",
  version: 1,
  tables: { workspaces: domainTable(remoteWorkspaceRecordSchema) }
});

/** A refusal a caller turns into a tool error, carrying a machine-readable code. */
export class RemoteWorkspacePathError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RemoteWorkspacePathError";
    this.code = code;
  }
}

/** Reject every C0 control byte plus DEL, matching the operator documentation. */
function assertNoControlCharacters(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new RemoteWorkspacePathError("remote path must not contain control characters", REMOTE_WORKSPACE_OUTSIDE);
  }
}

/**
 * Canonicalize one absolute remote path: reject non-strings, empty values and
 * control characters, then collapse `.`/`..`/duplicate slashes. A relative value throws
 * because "relative to what" is exactly the ambiguity this module exists to
 * remove; callers resolve against the root with {@link resolveRemotePath}.
 * @param {unknown} input - candidate remote path.
 * @returns {string} the normalized absolute POSIX path.
 */
export function normalizeRemoteRoot(input) {
  if (typeof input !== "string") throw new RemoteWorkspacePathError("remote path must be a string", REMOTE_WORKSPACE_OUTSIDE);
  assertNoControlCharacters(input);
  const raw = input.trim();
  if (raw.length === 0) throw new RemoteWorkspacePathError("remote path must not be empty", REMOTE_WORKSPACE_OUTSIDE);
  if (!raw.startsWith("/")) throw new RemoteWorkspacePathError(`remote path must be absolute: ${JSON.stringify(raw)}`, REMOTE_WORKSPACE_OUTSIDE);
  const normalized = posix.normalize(raw);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * Whether `candidate` is the root itself or lives below it. `/` contains
 * everything, which is the one case where containment is trivially true.
 * @param {string} root - normalized absolute remote root.
 * @param {string} candidate - normalized absolute remote path.
 * @returns {boolean} containment verdict.
 */
export function isRemotePathInside(root, candidate) {
  const base = normalizeRemoteRoot(root);
  const target = normalizeRemoteRoot(candidate);
  if (base === "/") return true;
  return target === base || target.startsWith(`${base}/`);
}

/**
 * Resolve one model-supplied path against the bound remote root: a relative
 * value joins the root, an absolute value is taken as-is, and the result must
 * stay inside the root — the remote analogue of the local workspace-write
 * sandbox. Rejecting the escape here (rather than after the write) is what
 * keeps `sftp_write ../../etc/passwd` from being a policy bypass.
 * @param {string} root - normalized absolute remote root.
 * @param {string} input - model-supplied path, absolute or root-relative.
 * @returns {string} the normalized absolute remote path inside the root.
 * @throws {RemoteWorkspacePathError} when the value escapes the root.
 */
export function resolveRemotePath(root, input) {
  const base = normalizeRemoteRoot(root);
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new RemoteWorkspacePathError("path must not be empty", REMOTE_WORKSPACE_OUTSIDE);
  }
  assertNoControlCharacters(input);
  const raw = input.trim();
  const joined = raw.startsWith("/") ? raw : posix.join(base, raw);
  const normalized = posix.normalize(joined);
  if (!isRemotePathInside(base, normalized)) {
    throw new RemoteWorkspacePathError(`path escapes the remote workspace root ${JSON.stringify(base)}: ${JSON.stringify(raw)}`, REMOTE_WORKSPACE_OUTSIDE);
  }
  return normalized;
}

/**
 * The workspace-relative part of a local path, or `null` when the path is not
 * inside that workspace. Compared lexically: DSH stores both the workspace
 * path and a session's cwd after `realpath`, so string prefixes are the same
 * identity. `""` means the path IS the workspace root.
 * @param {string} workspacePath - canonical host workspace directory.
 * @param {string} candidatePath - canonical host path to classify.
 * @returns {string|null} "/"-joined relative part, `""` for the root itself.
 */
export function workspaceRelativePart(workspacePath, candidatePath) {
  if (typeof workspacePath !== "string" || typeof candidatePath !== "string") return null;
  const rel = hostRelative(workspacePath, candidatePath);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * The model-visible declaration of a bound workspace. Written as facts and
 * prohibitions rather than a tutorial: the native file tools and the native
 * bash tool are NOT remote, and a model that assumes otherwise silently edits
 * the operator's empty local mirror — the failure mode this paragraph exists
 * to prevent.
 * @param {object} fact - resolved binding facts.
 * @param {string} fact.workspacePath - canonical host workspace directory.
 * @param {string} fact.remotePath - absolute remote root.
 * @param {string} fact.resourceName - human name of the SSH resource.
 * @param {string} fact.username - SSH username.
 * @param {string} fact.host - SSH host.
 * @param {number} fact.port - SSH port.
 * @param {string} [fact.relative] - current cwd relative to the workspace root.
 * @returns {string} one prompt-context paragraph, empty when nothing to say.
 */
export function remoteWorkspacePromptText(fact) {
  if (fact === undefined || fact === null) return "";
  const { workspacePath, remotePath, resourceName, username, host, port, relative } = fact;
  if (typeof workspacePath !== "string" || typeof remotePath !== "string") return "";
  const where = relative === undefined || relative === "" ? remotePath : posix.join(remotePath, relative);
  const lines = [
    `Remote workspace (dsh-ssh-ops): the working directory ${JSON.stringify(workspacePath)} is a workspace identity only.`,
    `- The project's files live on ${resourceName} (${username}@${host}:${port}) under ${JSON.stringify(remotePath)}; the current directory there is ${JSON.stringify(where)}.`,
    `- Read, write, list, create and rename files with the sftp_* tools. A relative path resolves under ${JSON.stringify(remotePath)}; an absolute path must also stay inside it, and the sftp_* tools default to this server when connection_id is omitted.`,
    `- Run commands with ssh_exec (or the SSH panel terminal). The native bash/terminal tools run on the operator's machine, not on ${host}.`,
    `- The native read/write/edit/glob/grep tools address the local filesystem (this workspace directory is essentially empty), so they do not see this project. Do not use them for it, and do not report "file not found" from them as a missing remote file.`,
    `- Writes outside ${JSON.stringify(remotePath)} are refused; sftp_delete moves files to ~/.dsh-trash on the server and stays recoverable.`
  ];
  return lines.join("\n");
}

/**
 * Table-backed bindings. Deliberately thin: the service owns profile lookups,
 * connection reuse and prompts; this class only maps host paths to records.
 */
export class RemoteWorkspaceStore {
  /** @param {{get:Function, put:Function, delete:Function, entries:Function}} table - storage table. */
  constructor(table) {
    this.table = table;
  }

  /**
   * Every binding in workspace-path order. Read-only snapshots, never live rows.
   * @returns {object[]} records including `workspacePath`.
   */
  list() {
    return [...this.table.entries()]
      .map(([workspacePath, record]) => ({ ...record, workspacePath }))
      .sort((left, right) => left.workspacePath.localeCompare(right.workspacePath));
  }

  /**
   * One binding by canonical workspace path.
   * @param {string} workspacePath - canonical host workspace directory.
   * @returns {object|undefined} the record, or undefined when unbound.
   */
  get(workspacePath) {
    const record = this.table.get(workspacePath);
    return record === undefined ? undefined : { ...record, workspacePath };
  }

  /**
   * The binding whose workspace contains `candidatePath`, deepest win. Nested
   * workspaces are legal in DSH, so the longest matching root is the only
   * answer that keeps a sub-workspace from inheriting its parent's server.
   * @param {string} candidatePath - canonical host path (a session cwd).
   * @returns {{record: object, relative: string}|undefined} binding and relative part.
   */
  findForPath(candidatePath) {
    let best;
    for (const record of this.list()) {
      const relative = workspaceRelativePart(record.workspacePath, candidatePath);
      if (relative === null) continue;
      if (best === undefined || record.workspacePath.length > best.record.workspacePath.length) {
        best = { record, relative };
      }
    }
    return best;
  }

  /**
   * Insert or replace one binding.
   * @param {object} input - validated request fields.
   * @returns {Promise<object>} the stored record.
   */
  async save(input) {
    const now = new Date().toISOString();
    const previous = this.table.get(input.workspacePath);
    const record = {
      workspacePath: input.workspacePath,
      profileId: input.profileId,
      remotePath: normalizeRemoteRoot(input.remotePath),
      autoConnect: input.autoConnect === true,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    };
    await this.table.put(input.workspacePath, record);
    return record;
  }

  /**
   * Drop one binding. Unknown paths are an idempotent no-op.
   * @param {string} workspacePath - canonical host workspace directory.
   * @returns {Promise<boolean>} whether a row was removed.
   */
  async remove(workspacePath) {
    if (this.table.get(workspacePath) === undefined) return false;
    await this.table.delete(workspacePath);
    return true;
  }
}
