/**
 * Remote file manager tab: browse the connected server's filesystem over
 * SFTP, with upload, download, mkdir, delete, and rename actions.
 */
import * as React from "react";
const { useEffect, useState } = React;

function joinPath(base, name) {
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

function dirnameOf(path) {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

export function SshFiles({ api, connectionId, onCd }) {
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameTo, setRenameTo] = useState("");
  const [transferMode, setTransferMode] = useState("sftp");
  const [scpReason, setScpReason] = useState("");
  const [scpUploadFile, setScpUploadFile] = useState(null);
  const [scpUploadPath, setScpUploadPath] = useState("");
  const [scpDownloadPath, setScpDownloadPath] = useState("");
  // Monotonic sequence: only the latest issued directory listing may commit
  // state, so a slow earlier response cannot overwrite a newer directory.
  const loadSeq = React.useRef(0);
  // Mirror of cwd for post-operation refreshes: a mutation that finishes after
  // the user navigated elsewhere must refresh the NEW directory, not snap back.
  const cwdRef = React.useRef("/");

  const load = async (path) => {
    const seq = ++loadSeq.current;
    setBusy(true);
    setError(null);
    setSelected(null);
    try {
      const value = await api.sftpList(connectionId, path);
      if (seq !== loadSeq.current) return;
      setEntries(Array.isArray(value?.entries) ? value.entries : []);
      setCwd(value?.path || path);
      cwdRef.current = value?.path || path;
    } catch (err) {
      if (seq !== loadSeq.current) return;
      // SFTP is the normal file manager. Only failure to OPEN its subsystem
      // merits SCP fallback; permission and path errors stay visible as SFTP
      // errors instead of silently changing transfer semantics.
      if (path === "/" && err?.code === "sftp-failed") {
        setTransferMode("scp");
        setScpReason(err.message ?? "SFTP 子系统不可用");
        setEntries(null);
        return;
      }
      setError(err?.message ?? String(err));
      setEntries([]);
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  };

  useEffect(() => {
    setTransferMode("sftp");
    setScpReason("");
    setScpUploadFile(null);
    setScpUploadPath("");
    setScpDownloadPath("");
    if (connectionId) load("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const goUp = () => {
    if (cwd !== "/") load(dirnameOf(cwd));
  };

  const openEntry = (entry) => {
    if (entry.isDirectory) load(joinPath(cwd, entry.name));
  };

  const download = async (entry) => {
    const target = entry || selected;
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const value = await api.sftpReadFile(connectionId, joinPath(cwd, target.name));
      if (value.truncated) {
        setError(`文件超过读取上限（${value.bytes} 字节），已截断——请用对话里的 sftp_read 指定更大 max_bytes`);
        return;
      }
      // browser download
      const blob = new Blob([value.data], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = target.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const ensureRemoteDir = async (remotePath) => {
    // Build the path one level at a time, ignoring "already exists" errors.
    const parts = remotePath.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current === "" ? `/${part}` : `${current}/${part}`;
      try { await api.sftpMkdir(connectionId, current); } catch {} // ignore if exists
    }
  };

  const upload = async (fileList) => {
    const files = Array.isArray(fileList) ? fileList : [fileList];
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        // Preserve relative path for directory uploads (webkitRelativePath).
        const relPath = file.webkitRelativePath || file.name;
        const remotePath = joinPath(cwd, relPath);
        // Ensure the remote directory exists.
        const dirPart = dirnameOf(remotePath);
        if (dirPart !== "/" && dirPart !== cwd) {
          await ensureRemoteDir(dirPart);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        await api.sftpWriteFile(connectionId, remotePath, bytes);
      }
      load(cwdRef.current);
    } catch (err) {
      setError(`上传失败：${err?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.sftpMkdir(connectionId, joinPath(cwd, newName.trim()));
      setNewName("");
      setCreating(false);
      load(cwdRef.current);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (entry) => {
    if (!window.confirm(`确定删除远程路径 ${joinPath(cwd, entry.name)} ？此操作不可恢复。`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.sftpDelete(connectionId, joinPath(cwd, entry.name));
      setSelected(null);
      load(cwdRef.current);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const doRename = async () => {
    if (!selected || !renameTo.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.sftpRename(connectionId, joinPath(cwd, selected.name), joinPath(cwd, renameTo.trim()));
      setRenameTo("");
      setRenaming(false);
      setSelected(null);
      load(cwdRef.current);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const scpUpload = async () => {
    if (!scpUploadFile || !scpUploadPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await scpUploadFile.arrayBuffer());
      await api.scpWriteFile(connectionId, scpUploadPath.trim(), bytes);
      setScpUploadFile(null);
    } catch (err) {
      setError(`SCP 上传失败：${err?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const scpDownload = async () => {
    const path = scpDownloadPath.trim();
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const value = await api.scpReadFile(connectionId, path);
      if (value.truncated) {
        setError(`文件超过读取上限（${value.bytes} 字节），未下载。`);
        return;
      }
      const blob = new Blob([value.data], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = path.split("/").filter(Boolean).at(-1) || "download";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(`SCP 下载失败：${err?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const inputRef = (el) => {
    if (el) {
      el.placeholder = "选择要上传的文本文件…";
      el.style.display = "none";
    }
  };

  if (transferMode === "scp") {
    return (
      <div style={filesStyles.root}>
        <div style={filesStyles.compatNotice}>
          SFTP 子系统不可用，已切换到 SCP 兼容模式。仅支持单文件上传和下载，需填写远端完整路径。
          {scpReason ? <div style={filesStyles.compatDetail}>{scpReason}</div> : null}
        </div>
        {error && <div style={filesStyles.error}>{error}</div>}
        <div style={filesStyles.scpCard}>
          <div style={filesStyles.scpTitle}>上传文件</div>
          <input
            type="file"
            onChange={(e) => setScpUploadFile(e.target.files?.[0] ?? null)}
            style={filesStyles.fileInput}
          />
          <input
            value={scpUploadPath}
            onChange={(e) => setScpUploadPath(e.target.value)}
            placeholder="远端完整目标路径，例如 /tmp/report.zip"
            style={filesStyles.input}
          />
          <button onClick={scpUpload} disabled={busy || !scpUploadFile || !scpUploadPath.trim()} style={filesStyles.btnPrimary}>上传</button>
        </div>
        <div style={filesStyles.scpCard}>
          <div style={filesStyles.scpTitle}>下载文件</div>
          <input
            value={scpDownloadPath}
            onChange={(e) => setScpDownloadPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && scpDownload()}
            placeholder="远端完整文件路径，例如 /var/log/app.log"
            style={filesStyles.input}
          />
          <button onClick={scpDownload} disabled={busy || !scpDownloadPath.trim()} style={filesStyles.btnPrimary}>下载</button>
        </div>
      </div>
    );
  }

  return (
    <div style={filesStyles.root}>
      <div style={filesStyles.toolbar}>
        <button onClick={goUp} disabled={cwd === "/"} style={filesStyles.btn} title="上级目录">↑</button>
        <span style={filesStyles.path} title={cwd}>{cwd}</span>
        <button onClick={() => setCreating(!creating)} style={filesStyles.btn} title="新建目录">＋</button>
        <label style={filesStyles.btn} title="上传文件（可多选）">
          上传
          <input
            ref={inputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const files = e.target.files;
              if (files && files.length > 0) upload([...files]);
              e.target.value = "";
            }}
          />
        </label>
        <button onClick={() => load(cwd)} disabled={busy} style={filesStyles.btn} title="刷新">↻</button>
      </div>

      {creating && (
        <div style={filesStyles.inlineForm}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doCreate()}
            placeholder="新目录名"
            style={filesStyles.input}
          />
          <button onClick={doCreate} disabled={busy || !newName.trim()} style={filesStyles.btnPrimary}>创建</button>
          <button onClick={() => setCreating(false)} style={filesStyles.btn}>取消</button>
        </div>
      )}

      {error && <div style={filesStyles.error}>{error}</div>}

      {renaming && selected && (
        <div style={filesStyles.inlineForm}>
          <input
            autoFocus
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doRename()}
            placeholder={selected.name}
            style={filesStyles.input}
          />
          <button onClick={doRename} disabled={busy || !renameTo.trim()} style={filesStyles.btnPrimary}>改名</button>
          <button onClick={() => setRenaming(false)} style={filesStyles.btn}>取消</button>
        </div>
      )}

      <div style={filesStyles.list}>
        {!entries || entries.length === 0 ? (
          <div style={filesStyles.empty}>{busy ? "加载中…" : (entries && entries.length === 0 ? "（空目录）" : "请连接服务器")}</div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.name}
              style={{
                ...filesStyles.row,
                ...(selected?.name === entry.name ? filesStyles.rowSelected : {})
              }}
              onClick={() => setSelected(entry)}
              onDoubleClick={() => {
                if (entry.isDirectory) openEntry(entry);
                else download(entry);
              }}
              title={entry.isDirectory ? `${entry.name}（双击打开）` : `${entry.name}  (${entry.size} bytes，双击下载)`}
            >
              <span style={filesStyles.icon}>
                {entry.isDirectory
                  ? React.createElement("svg", { width: 16, height: 14, viewBox: "0 0 16 14", fill: "none" },
                      React.createElement("path", { d: "M1 3C1 2.4 1.4 2 2 2H6L7.5 4H14C14.6 4 15 4.4 15 5V12C15 12.6 14.6 13 14 13H2C1.4 13 1 12.6 1 12V3Z", fill: "#e8c547" }))
                  : React.createElement("svg", { width: 14, height: 16, viewBox: "0 0 14 16", fill: "none" },
                      React.createElement("path", { d: "M2 1H9L13 5V14C13 14.6 12.6 15 12 15H2C1.4 15 1 14.6 1 14V2C1 1.4 1.4 1 2 1Z", fill: "#c8ccd1" }),
                      React.createElement("path", { d: "M9 1L13 5H10C9.4 5 9 4.6 9 4V1Z", fill: "#8b93a1" }))}
              </span>
              <span style={filesStyles.rowName}>{entry.name}</span>
              {!entry.isDirectory && (
                <span style={filesStyles.rowSize}>{formatSize(entry.size)}</span>
              )}
              {selected?.name === entry.name && (
                <span style={filesStyles.rowActions} onClick={(e) => e.stopPropagation()}>
                  {entry.isDirectory && onCd && (
                    <button
                      onClick={() => onCd(joinPath(cwd, entry.name))}
                      disabled={busy}
                      style={filesStyles.btnTiny}
                      title="在右侧终端 cd 到此目录"
                      aria-label={`在终端 cd 到 ${joinPath(cwd, entry.name)}`}
                    >cd</button>
                  )}
                  <button onClick={() => download(entry)} disabled={busy} style={filesStyles.btnTiny}>下载</button>
                  <button onClick={() => setRenaming(!renaming)} style={filesStyles.btnTiny}>改名</button>
                  <button onClick={() => doDelete(entry)} disabled={busy} style={filesStyles.btnDanger}>删除</button>
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const filesStyles = {
  root: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 6 },
  toolbar: { display: "flex", alignItems: "center", gap: 6, flex: "none" },
  path: { flex: 1, fontSize: 12, color: "#9aa3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" },
  btn: {
    background: "transparent", border: "1px solid #3a414b", color: "#d7dbe2",
    borderRadius: 6, padding: "3px 8px", fontSize: 12, cursor: "pointer", flex: "none"
  },
  btnTiny: {
    background: "transparent", border: "1px solid #3a414b", color: "#d7dbe2",
    borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer"
  },
  btnPrimary: {
    background: "#2d6cdf", color: "#fff", border: "none", borderRadius: 6,
    padding: "3px 10px", fontSize: 12, cursor: "pointer"
  },
  btnDanger: {
    background: "transparent", border: "1px solid #f85149", color: "#f85149",
    borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer"
  },
  inlineForm: { display: "flex", gap: 6, alignItems: "center", flex: "none" },
  input: {
    flex: 1, background: "#101418", border: "1px solid #2a303a", borderRadius: 6,
    color: "#d7dbe2", padding: "4px 8px", fontSize: 12, outline: "none"
  },
  error: {
    padding: "6px 10px", fontSize: 12, color: "#f85149",
    background: "rgba(248,81,73,.1)", border: "1px solid rgba(248,81,73,.3)", borderRadius: 6, flex: "none"
  },
  compatNotice: {
    padding: "8px 10px", fontSize: 12, color: "#f0c36d",
    background: "rgba(240,195,109,.1)", border: "1px solid rgba(240,195,109,.35)", borderRadius: 6, flex: "none"
  },
  compatDetail: { marginTop: 4, color: "#9aa3af", wordBreak: "break-word" },
  scpCard: { display: "flex", flexDirection: "column", gap: 8, padding: 10, border: "1px solid #2a303a", borderRadius: 6, flex: "none" },
  scpTitle: { fontSize: 13, color: "#d7dbe2", fontWeight: 600 },
  fileInput: { fontSize: 12, color: "#c8ccd1" },
  rowSize: { flex: "none", fontSize: 11, color: "#8b93a1" },
  rowActions: { display: "flex", gap: 4, flex: "none", marginLeft: "auto" },
  list: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1 },
  row: { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 6, cursor: "pointer" },
  rowSelected: { background: "rgba(45,108,223,.18)" },
  icon: { flex: "none", fontSize: 13, display: "inline-flex", alignItems: "center" },
  rowName: { flex: 1, fontSize: 13, color: "#d7dbe2", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  empty: { margin: "auto", fontSize: 12, color: "#8b93a1" }
};
