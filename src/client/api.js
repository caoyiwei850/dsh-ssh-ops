/**
 * Browser-side client for the `sshOps` Remote namespace. The namespace service
 * is mounted by apply() through ctx.remote.$mount(TYPERT_REMOTE); this class
 * unwraps the { ok, value | error } envelope into values or thrown errors and
 * converts base64 wire payloads (file contents are binary bytes, other fields
 * UTF-8 strings).
 */
export class SshApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SshApiError";
    this.code = code;
  }
}

function encodeBase64(text) {
  return encodeBase64Bytes(new TextEncoder().encode(text));
}

function encodeBase64Bytes(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function decodeBase64(data) {
  return new TextDecoder().decode(decodeBase64Bytes(data));
}

function decodeBase64Bytes(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class SshApi {
  /** @param {() => object|undefined} getNamespace live namespace getter */
  constructor(getNamespace) {
    this.getNamespace = getNamespace;
  }

  async call(method, args) {
    const namespace = this.getNamespace();
    const fn = namespace?.[method];
    if (typeof fn !== "function") {
      throw new SshApiError("not-mounted", `sshOps Remote method "${method}" is not mounted`);
    }
    const rpc = await fn(args);
    if (!rpc || rpc.ok !== true) {
      // Preserve the transport error code when the wire supplies one so
      // callers can distinguish e.g. no-session from a generic failure.
      throw new SshApiError(rpc?.error?.code ?? "rpc-failed", rpc?.error?.message ?? "remote call failed");
    }
    const business = rpc.value;
    if (!business || typeof business.ok !== "boolean") {
      throw new SshApiError("bad-envelope", `sshOps Remote method "${method}" returned an unexpected payload shape`);
    }
    if (business.ok) return business.value;
    throw new SshApiError(business.error?.code ?? "rpc-failed", business.error?.message ?? "remote call failed");
  }

  list() {
    return this.call("list", {});
  }

  connect(input) {
    return this.call("connect", input);
  }

  profileList() {
    return this.call("profileList", {});
  }

  profileSave(input) {
    return this.call("profileSave", input);
  }

  profileDelete(profileId) {
    return this.call("profileDelete", { profileId });
  }

  profileDisconnect(profileId) {
    return this.call("profileDisconnect", { profileId });
  }

  profileConnect(input) {
    return this.call("profileConnect", typeof input === "string" ? { profileId: input } : input);
  }

  cancelProfileConnect(input = {}) {
    return this.call("cancelProfileConnect", input);
  }

  groupList() {
    return this.call("groupList", {});
  }

  groupSave(input) {
    return this.call("groupSave", input);
  }

  groupDelete(groupId) {
    return this.call("groupDelete", { groupId });
  }

  openSession(connectionId, cols, rows) {
    return this.call("openSession", { connectionId, cols, rows });
  }

  async write(sessionId, text) {
    await this.call("write", { sessionId, data: encodeBase64(text) });
  }

  pendingConfirmationList() {
    return this.call("pendingConfirmationList", {});
  }

  pendingConfirmationApprove(confirmationId) {
    return this.call("pendingConfirmationApprove", { confirmationId });
  }

  pendingConfirmationCancel(confirmationId) {
    return this.call("pendingConfirmationCancel", { confirmationId });
  }

  batchPlan(command, timeoutMs) {
    return this.call("batchPlan", { command, timeoutMs });
  }

  batchTaskList() {
    return this.call("batchTaskList", {});
  }

  batchRun(batchId, profileIds) {
    return this.call("batchRun", { batchId, profileIds });
  }

  batchCancel(batchId) {
    return this.call("batchCancel", { batchId });
  }


  async read(sessionId, timeoutMs = 300, after) {
    const value = await this.call("read", { sessionId, timeoutMs, ...(after === undefined ? {} : { after }) });
    return {
      data: value.data ? decodeBase64(value.data) : "",
      exit: value.exit,
      startOffset: value.startOffset,
      offset: value.offset
    };
  }

  /**
   * Subscribe to terminal output push (typert mode:'stream' over the
   * Gateway's WebSocket mux). Returns an async generator of already-decoded
   * { data, exit } items, or null when the stream path is unavailable (older
   * host, mux offline) so the caller falls back to read() polling.
   */
  async streamTerminal(sessionId, signal, after) {
    const namespace = this.getNamespace();
    const fn = namespace?.terminalStream;
    if (typeof fn !== "function") return null;
    let stream;
    try {
      const request = { sessionId, ...(after === undefined ? {} : { after }) };
      stream = signal !== undefined ? await fn(request, signal) : await fn(request);
    } catch {
      return null;
    }
    if (stream === null || stream === undefined || typeof stream[Symbol.asyncIterator] !== "function") return null;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const item of stream) {
          if (!item || item.ok !== true) {
            throw new SshApiError(item?.error?.code ?? "rpc-failed", item?.error?.message ?? "terminal stream failed");
          }
          yield { data: item.value.data ? decodeBase64(item.value.data) : "", exit: item.value.exit, startOffset: item.value.startOffset, offset: item.value.offset };
        }
      }
    };
  }

  changeDirectory(sessionId, path) {
    return this.call("changeDirectory", { sessionId, path });
  }

  resize(sessionId, cols, rows) {
    return this.call("resize", { sessionId, cols, rows });
  }

  closeSession(sessionId) {
    return this.call("closeSession", { sessionId });
  }

  disconnect(connectionId) {
    return this.call("disconnect", { connectionId });
  }

  // ── SFTP ───────────────────────────────────────────────────────────────────

  sftpList(connectionId, path) {
    return this.call("sftpList", { connectionId, path });
  }

  sftpStat(connectionId, path) {
    return this.call("sftpStat", { connectionId, path });
  }

  async sftpReadFile(connectionId, path, maxBytes) {
    const value = await this.call("sftpReadFile", { connectionId, path, maxBytes });
    return { ...value, data: decodeBase64Bytes(value.data) };
  }

  sftpWriteFile(connectionId, path, bytes) {
    return this.call("sftpWriteFile", { connectionId, path, data: encodeBase64Bytes(bytes) });
  }

  async scpReadFile(connectionId, path, maxBytes) {
    const value = await this.call("scpReadFile", { connectionId, path, maxBytes });
    return { ...value, data: decodeBase64Bytes(value.data) };
  }

  scpWriteFile(connectionId, path, bytes) {
    return this.call("scpWriteFile", { connectionId, path, data: encodeBase64Bytes(bytes) });
  }

  sftpMkdir(connectionId, path) {
    return this.call("sftpMkdir", { connectionId, path });
  }

  sftpDelete(connectionId, path) {
    return this.call("sftpDelete", { connectionId, path });
  }

  sftpRename(connectionId, from, to) {
    return this.call("sftpRename", { connectionId, from, to });
  }

  // ── Port forwarding ────────────────────────────────────────────────────────

  tunnelStartLocal(input) {
    return this.call("tunnelStartLocal", input);
  }

  tunnelStartRemote(input) {
    return this.call("tunnelStartRemote", input);
  }

  tunnelStop(connectionId, tunnelId) {
    return this.call("tunnelStop", { connectionId, tunnelId });
  }

  tunnelList(connectionId) {
    return this.call("tunnelList", { connectionId });
  }

  sshConfigImport() {
    return this.call("sshConfigImport", {});
  }

  // ── Database ops ───────────────────────────────────────────────────────────

  dbConnect(input) {
    return this.call("dbConnect", input);
  }

  dbListConnections() {
    return this.call("dbListConnections", {});
  }

  dbQuery(dbConnectionId, sql, params) {
    return this.call("dbQuery", { dbConnectionId, sql, params });
  }

  dbExecute(dbConnectionId, sql, params) {
    return this.call("dbExecute", { dbConnectionId, sql, params });
  }

  dbListTables(dbConnectionId) {
    return this.call("dbListTables", { dbConnectionId });
  }

  dbDescribeTable(dbConnectionId, table) {
    return this.call("dbDescribeTable", { dbConnectionId, table });
  }

  dbPreview(dbConnectionId, table, limit, offset) {
    return this.call("dbPreview", { dbConnectionId, table, limit, offset });
  }

  dbExplain(dbConnectionId, sql, params) {
    return this.call("dbExplain", { dbConnectionId, sql, params });
  }

  dbTxBegin(dbConnectionId) {
    return this.call("dbTxBegin", { dbConnectionId });
  }

  dbTxExecute(txId, sql, params) {
    return this.call("dbTxExecute", { txId, sql, params });
  }

  dbTxCommit(txId) {
    return this.call("dbTxCommit", { txId });
  }

  dbTxRollback(txId) {
    return this.call("dbTxRollback", { txId });
  }

  dbRun(dbConnectionId, input) {
    return this.call("dbRun", { dbConnectionId, ...input });
  }

  dbDisconnect(dbConnectionId) {
    return this.call("dbDisconnect", { dbConnectionId });
  }

  // ── Database profiles (durable) ────────────────────────────────────────────

  dbProfileList() {
    return this.call("dbProfileList", {});
  }

  dbProfileSave(input) {
    return this.call("dbProfileSave", input);
  }

  dbProfileDelete(dbProfileId) {
    return this.call("dbProfileDelete", { dbProfileId });
  }

  dbProfileConnect(dbProfileId) {
    return this.call("dbProfileConnect", { dbProfileId });
  }

  // ── Known-hosts management (operator only) ────────────────────────────────

  listKnownHosts() {
    return this.call("listKnownHosts", {});
  }

  forgetHostKey(host, port) {
    return this.call("forgetHostKey", { host, port });
  }
}

/**
 * Build the SshApi bound to the gateway's live `sshOps` namespace service.
 * Mirrors the dsh-terminal reach-around: the gateway's ClientRemoteService
 * keeps live namespace services in its public `namespaces` map.
 */
export function createSshApi(ctx) {
  return new SshApi(() => {
    const remote = ctx.remote;
    return remote?.namespaces?.get("sshOps")?.service;
  });
}
