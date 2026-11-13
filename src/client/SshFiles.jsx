/**
 * Remote file manager tab: browse the connected server's filesystem over
 * SFTP, with upload, download, mkdir, delete, and rename actions.
 */
import * as React from "react";
import { MAX_EDITABLE_BYTES, changedLineRegions, decodeEditableText, encodeEditableText, filterEntries } from "./file-editor.js";
import { favoritesKey, readFavorites, writeFavorites, toggleFavorite } from "./sftp-favorites.js";
import { t } from "../i18n/core.js";
import { searchRemoteFiles } from "./remote-file-search.js";
import { streamDownload } from "./stream-download.js";
import { checkpointDestination, checkpointFile, createDownloadCheckpoint, deleteDownloadCheckpoint, listDownloadCheckpoints, withDownloadLock } from "./download-checkpoints.js";
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

export function SshFiles({ api, connectionId, onCd, initialPath = "/" }) {
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
  const [filter, setFilter] = useState("");
  const [favorites, setFavorites] = useState([]);
  const [favoritesStorageKey, setFavoritesStorageKey] = useState(null);
  const favoritesKeyRef = React.useRef(favoritesStorageKey);
  favoritesKeyRef.current = favoritesStorageKey;
  const [editing, setEditing] = useState(null);
  const [previewChanges, setPreviewChanges] = useState(false);
  const [lastSave, setLastSave] = useState(null);
  const connectionRef = React.useRef(connectionId);
  connectionRef.current = connectionId;
  const [editorBusy, setEditorBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [agentTasks, setAgentTasks] = useState([]);
  const [persistDownloads, setPersistDownloads] = useState(false);
  const [checkpoints, setCheckpoints] = useState([]);
  const taskId = React.useRef(0);
  const controllers = React.useRef(new Map());
  const searchController = React.useRef(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState(null);
  const updateTask = (id, patch) => setTasks((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const addTask = (task) => { const id = ++taskId.current; setTasks((items) => [{ ...task, id }, ...items.filter((item, index) => item.status === "running" || index < 49)]); return id; };
  useEffect(() => () => { searchController.current?.abort(); for (const controller of controllers.current.values()) controller.abort(); }, []);
  useEffect(() => { searchController.current?.abort(); searchController.current = null; setSearchState(null); }, [connectionId]);
  useEffect(() => {
    let active = true;
    setAgentTasks([]);
    if (!connectionId || typeof api.sftpTransferList !== "function") return () => { active = false; };
    const refresh = async () => {
      try { const result = await api.sftpTransferList(connectionId); if (active) setAgentTasks(result.transfers ?? []); } catch { /* Older hosts may not expose the registry. */ }
    };
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [api, connectionId]);

  const refreshCheckpoints = async (identity = favoritesStorageKey) => {
    if (!identity) return;
    try {
      const items = await listDownloadCheckpoints(identity);
      if (favoritesKeyRef.current === identity) setCheckpoints(items);
    } catch { if (favoritesKeyRef.current === identity) setCheckpoints([]); }
  };
  useEffect(() => { setCheckpoints([]); void refreshCheckpoints(favoritesStorageKey); }, [favoritesStorageKey]);

  const fetchVerifiedDownload = async (query, task, signal) => {
    const id = globalThis.crypto?.randomUUID?.();
    if (!id) return fetch(`/ssh-ops/stream/file?${query}`, { signal });
    query.set("verificationId", id);
    const status = new URLSearchParams({ connectionId: query.get("connectionId"), id });
    const pollController = new AbortController();
    let pending = false;
    updateTask(task, { verification: null });
    const timer = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch(`/ssh-ops/stream/verification?${status}`, { signal: pollController.signal });
        if (!response.ok) return;
        const verification = await response.json();
        if (!pollController.signal.aborted) updateTask(task, { verification });
      } catch { /* The progress endpoint is optional for the download. */ }
      finally { pending = false; }
    }, 400);
    try {
      return await fetch(`/ssh-ops/stream/file?${query}`, { signal });
    } finally {
      clearInterval(timer);
      pollController.abort();
    }
  };

  const resumeCheckpoint = async (checkpoint) => {
    if (typeof globalThis.showSaveFilePicker !== "function") return;
    let destination;
    try { destination = await globalThis.showSaveFilePicker({ suggestedName: checkpoint.path.split("/").pop() || "download" }); }
    catch (err) { if (err?.name !== "AbortError") setError(err?.message ?? String(err)); return; }
    const controller = new AbortController();
    const task = addTask({ name: checkpoint.path.split("/").pop(), kind: "download", status: "running", sent: checkpoint.offset, total: checkpoint.total, cancellable: true, resuming: true });
    controllers.current.set(task, controller);
    try {
      await withDownloadLock(checkpoint.id, async () => {
        const prefix = await checkpointFile(checkpoint.id);
        const makeRequest = async (offset, expectedSha256) => {
          updateTask(task, { resuming: true, speed: 0 });
          const query = new URLSearchParams({ connectionId, path: checkpoint.path, verify: "sha256", offset: String(offset), expectedSha256 });
          const response = await fetchVerifiedDownload(query, task, controller.signal);
          updateTask(task, { resuming: false });
          return response;
        };
        const response = await makeRequest(prefix.size, checkpoint.digest);
        if (!response.ok || response.headers.get("x-content-sha256") !== checkpoint.digest) {
          await response.body?.cancel().catch(() => {});
          throw new Error(t("远程文件已变化或无法续传"));
        }
        updateTask(task, { resuming: false });
        const startedAt = Date.now();
        await streamDownload(response, checkpointDestination(checkpoint.id, destination, controller.signal, checkpoint.digest), controller.signal, (sent, total) => {
          const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001);
          updateTask(task, { sent, total, speed: (sent - prefix.size) / elapsed });
        }, makeRequest, prefix);
      });
      updateTask(task, { status: "done" });
    } catch (err) {
      const cancelled = controller.signal.aborted || err?.name === "AbortError";
      updateTask(task, { status: cancelled ? "cancelled" : "failed", error: cancelled ? "" : (err?.message ?? String(err)) });
      if (!cancelled) setError(err?.message ?? String(err));
    } finally { controllers.current.delete(task); void refreshCheckpoints(); }
  };

  const runSearch = async () => {
    if (!searchQuery.trim()) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    const root = cwd;
    setSearchState({ running: true, root, results: [], errors: [] });
    const result = await searchRemoteFiles((path) => api.sftpList(connectionId, path), root, searchQuery.trim(), { signal: controller.signal });
    if (searchController.current === controller) setSearchState({ ...result, root, running: false });
  };
  // Monotonic sequence: only the latest issued directory listing may commit
  // state, so a slow earlier response cannot overwrite a newer directory.
  const loadSeq = React.useRef(0);
  // Mirror of cwd for post-operation refreshes: a mutation that finishes after
  // the user navigated elsewhere must refresh the NEW directory, not snap back.
  const cwdRef = React.useRef("/");

  // Favorites are stored per server: the runtime connection id changes every
  // session, so resolve the stable host/port/username key once here.
  useEffect(() => {
    let cancelled = false;
    setFavoritesStorageKey(null);
    (async () => {
      try {
        const value = await api.list();
        if (cancelled) return;
        const connection = (value?.connections ?? []).find((item) => item.connectionId === connectionId);
        const key = favoritesKey(connection);
        setFavoritesStorageKey(key);
        setFavorites(readFavorites(globalThis.localStorage, key));
      } catch {
        // Favorites are cosmetic: a failed lookup simply shows none.
      }
    })();
    return () => { cancelled = true; };
  }, [api, connectionId]);

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
        setScpReason(err.message ?? t("SFTP 子系统不可用"));
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
    setLastSave(null);
    setScpReason("");
    setScpUploadFile(null);
    setScpUploadPath("");
    setScpDownloadPath("");
    if (connectionId) load(initialPath);
  }, [connectionId, initialPath]);

  const goUp = () => {
    if (cwd !== "/") load(dirnameOf(cwd));
  };

  const openEntry = (entry) => {
    if (entry.isDirectory) load(joinPath(cwd, entry.name));
  };

  const download = async (entry) => {
    const target = entry || selected;
    if (!target) return;
    if (typeof globalThis.showSaveFilePicker === "function") {
      let handle;
      try { handle = await globalThis.showSaveFilePicker({ suggestedName: target.name }); }
      catch (err) { if (err?.name !== "AbortError") setError(err?.message ?? String(err)); return; }
      const controller = new AbortController();
      const task = addTask({ name: target.name, kind: "download", status: "running", sent: 0, total: target.size, cancellable: true, verifying: true });
      controllers.current.set(task, controller);
      setError(null);
      try {
        const query = new URLSearchParams({ connectionId, path: joinPath(cwd, target.name), verify: "sha256" });
        const response = await fetchVerifiedDownload(query, task, controller.signal);
        const startedAt = Date.now();
        updateTask(task, { verifying: false });
        let destination = handle;
        let checkpoint;
        if (persistDownloads) {
          const digest = response.headers.get("x-content-sha256");
          const totalHeader = response.headers.get("x-file-size");
          const total = Number(totalHeader);
          if (!response.ok || !favoritesStorageKey || !/^[0-9a-f]{64}$/.test(digest ?? "") || !totalHeader || !/^\d+$/.test(totalHeader) || !Number.isSafeInteger(total) || total < 0) {
            await response.body?.cancel().catch(() => {});
            throw new Error(t("无法创建可恢复的下载任务"));
          }
          checkpoint = await createDownloadCheckpoint({ identity: favoritesStorageKey, path: joinPath(cwd, target.name), digest, total });
          destination = checkpointDestination(checkpoint.id, handle, controller.signal, checkpoint.digest);
        }
        const perform = () => streamDownload(response, destination, controller.signal, (sent, total) => {
          const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001);
          updateTask(task, { sent, total, speed: sent / elapsed });
        }, async (offset, expectedSha256) => {
          updateTask(task, { verifying: true, resuming: true });
          const next = new URLSearchParams({ connectionId, path: joinPath(cwd, target.name), verify: "sha256", offset: String(offset), expectedSha256 });
          const response = await fetchVerifiedDownload(next, task, controller.signal);
          updateTask(task, { verifying: false, resuming: false });
          return response;
        });
        if (checkpoint) await withDownloadLock(checkpoint.id, perform);
        else await perform();
        updateTask(task, { status: "done" });
      } catch (err) {
        const cancelled = controller.signal.aborted || err?.name === "AbortError";
        updateTask(task, { status: cancelled ? "cancelled" : "failed", error: cancelled ? "" : (err?.message ?? String(err)) });
        if (!cancelled) setError(err?.message ?? String(err));
      } finally { controllers.current.delete(task); void refreshCheckpoints(); }
      return;
    }
    setBusy(true);
    setError(null);
    const task = addTask({ name: target.name, kind: "download", status: "running" });
    try {
      const value = await api.sftpReadFile(connectionId, joinPath(cwd, target.name));
      if (value.truncated) {
        throw new Error(t(`文件超过读取上限（${value.bytes} 字节），未下载`));
      }
      // browser download
      const blob = new Blob([value.data], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = target.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      updateTask(task, { status: "done" });
    } catch (err) {
      updateTask(task, { status: "failed", error: err?.message ?? String(err) });
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
    const controller = new AbortController();
    const task = addTask({ name: files.length === 1 ? files[0].name : t(`${files.length} 个文件`), kind: "upload", status: "running", sent: 0, total: files.reduce((sum, file) => sum + file.size, 0), cancellable: true });
    controllers.current.set(task, controller);
    let completedBytes = 0;
    try {
      for (const file of files) {
        if (controller.signal.aborted) throw new Error("cancelled");
        // Preserve relative path for directory uploads (webkitRelativePath).
        const relPath = file.webkitRelativePath || file.name;
        const remotePath = joinPath(cwd, relPath);
        // Ensure the remote directory exists.
        const dirPart = dirnameOf(remotePath);
        if (dirPart !== "/" && dirPart !== cwd) {
          await ensureRemoteDir(dirPart);
        }
        updateTask(task, { current: file.name, sent: completedBytes, writing: false });
        try {
          await api.sftpUploadFile(connectionId, remotePath, file, (sent) => {
            updateTask(task, { current: file.name, sent: completedBytes + sent, writing: sent >= file.size });
          }, controller.signal);
        } catch (error) {
          if (error?.code !== "stream-unavailable") throw error;
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (controller.signal.aborted) throw new Error("cancelled");
          updateTask(task, { current: file.name, sent: completedBytes, writing: true, cancellable: false });
          await api.sftpWriteFile(connectionId, remotePath, bytes);
        }
        completedBytes += file.size;
        updateTask(task, { sent: completedBytes, cancellable: true });
      }
      updateTask(task, { status: "done", cancellable: false });
      load(cwdRef.current);
    } catch (err) {
      const cancelled = controller.signal.aborted;
      updateTask(task, { status: cancelled ? "cancelled" : "failed", error: cancelled ? null : (err?.message ?? String(err)), cancellable: false });
      if (!cancelled) setError(t(`上传失败：${err?.message ?? String(err)}`));
    } finally {
      controllers.current.delete(task);
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
    if (!window.confirm(t(`确定删除远程路径 ${joinPath(cwd, entry.name)} ？此操作不可恢复。`))) return;
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
      setError(t(`SCP 上传失败：${err?.message ?? String(err)}`));
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
        setError(t(`文件超过读取上限（${value.bytes} 字节），未下载。`));
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
      setError(t(`SCP 下载失败：${err?.message ?? String(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const inputRef = (el) => {
    if (el) {
      el.placeholder = t("选择要上传的文本文件…");
      el.style.display = "none";
    }
  };

  if (transferMode === "scp") {
    return (
      <div style={filesStyles.root}>
        <div style={filesStyles.compatNotice}>
          {t("SFTP 子系统不可用，已切换到 SCP 兼容模式。仅支持单文件上传和下载，需填写远端完整路径。")}
          {scpReason ? <div style={filesStyles.compatDetail}>{scpReason}</div> : null}
        </div>
        {error && <div style={filesStyles.error}>{error}</div>}
        <div style={filesStyles.scpCard}>
          <div style={filesStyles.scpTitle}>{t("上传文件")}</div>
          <input
            type="file"
            onChange={(e) => setScpUploadFile(e.target.files?.[0] ?? null)}
            style={filesStyles.fileInput}
          />
          <input
            value={scpUploadPath}
            onChange={(e) => setScpUploadPath(e.target.value)}
            placeholder={t("远端完整目标路径，例如 /tmp/report.zip")}
            style={filesStyles.input}
          />
          <button onClick={scpUpload} disabled={busy || !scpUploadFile || !scpUploadPath.trim()} style={filesStyles.btnPrimary}>{t("上传")}</button>
        </div>
        <div style={filesStyles.scpCard}>
          <div style={filesStyles.scpTitle}>{t("下载文件")}</div>
          <input
            value={scpDownloadPath}
            onChange={(e) => setScpDownloadPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && scpDownload()}
            placeholder={t("远端完整文件路径，例如 /var/log/app.log")}
            style={filesStyles.input}
          />
          <button onClick={scpDownload} disabled={busy || !scpDownloadPath.trim()} style={filesStyles.btnPrimary}>{t("下载")}</button>
        </div>
      </div>
    );
  }

  const persistFavorites = (next) => {
    setFavorites(next);
    writeFavorites(globalThis.localStorage, favoritesStorageKey, next);
  };
  const pinCurrent = () => persistFavorites(toggleFavorite(favorites, cwd).paths);
  const unpin = (path) => persistFavorites(favorites.filter((item) => item !== path));

  /** Read one remote file into the text editor, refusing binaries and big files. */
  const openEditor = async (entry) => {
    const path = joinPath(cwd, entry.name);
    setBusy(true);
    setError(null);
    try {
      const stat = await api.sftpStat(connectionId, path).catch(() => null);
      if (stat?.size > MAX_EDITABLE_BYTES) {
        setError(t(`文件 ${formatSize(stat.size)} 超过 ${MAX_EDITABLE_BYTES / 1024 / 1024} MB 的编辑上限，请下载后编辑`));
        return;
      }
      const file = await api.sftpReadFile(connectionId, path, MAX_EDITABLE_BYTES + 1);
      const decoded = decodeEditableText(file.data);
      if (!decoded.ok) {
        setError(t(`${entry.name}：${decoded.reason}`));
        return;
      }
      setEditing({
        path,
        text: decoded.text,
        original: decoded.text,
        originalBytes: file.data,
        replaced: decoded.replaced,
        bytes: file.data.length,
        mtime: stat?.mtime ?? entry.mtime ?? null
      });
      setPreviewChanges(false);
    } catch (err) {
      setError(t(`打开失败：${err?.message ?? String(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const saveEditor = async () => {
    if (!editing) return;
    setEditorBusy(true);
    setError(null);
    try {
      const replacement = encodeEditableText(editing.text);
      const result = await api.sftpEditorSave(connectionId, editing.path, editing.originalBytes, replacement);
      if (connectionRef.current !== connectionId) return;
      setLastSave({ path: editing.path, backup: result.backup, original: editing.originalBytes, replacement });
      setEditing(null);
      load(cwdRef.current);
    } catch (err) {
      setError(t(`保存失败：${err?.message ?? String(err)}`));
    } finally {
      setEditorBusy(false);
    }
  };

  const restoreLastSave = async () => {
    if (!lastSave || !globalThis.confirm?.(t(`恢复 ${lastSave.path} 的上一个版本？当前内容会先备份。`))) return;
    setEditorBusy(true);
    try {
      const result = await api.sftpEditorSave(connectionId, lastSave.path, lastSave.replacement, lastSave.original);
      if (connectionRef.current !== connectionId) return;
      setLastSave({ path: lastSave.path, backup: result.backup, original: lastSave.replacement, replacement: lastSave.original });
      setError(null);
      load(cwdRef.current);
    } catch (err) { setError(t(`恢复失败：${err?.message ?? String(err)}`)); }
    finally { setEditorBusy(false); }
  };

  const restoreBackup = async (entry) => {
    const match = entry.name.match(/^(.*)\.dsh-backup-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    if (!match || !match[1]) return;
    const targetPath = joinPath(cwd, match[1]);
    if (!globalThis.confirm?.(t(`用 ${entry.name} 恢复 ${targetPath}？当前内容会先备份。`))) return;
    setBusy(true);
    setError(null);
    try {
      const [backup, current] = await Promise.all([
        api.sftpReadFile(connectionId, joinPath(cwd, entry.name), MAX_EDITABLE_BYTES + 1),
        api.sftpReadFile(connectionId, targetPath, MAX_EDITABLE_BYTES + 1)
      ]);
      if (backup.truncated || current.truncated || backup.data.length > MAX_EDITABLE_BYTES || current.data.length > MAX_EDITABLE_BYTES) throw new Error(t("文件超过编辑器大小上限，无法恢复"));
      const result = await api.sftpEditorSave(connectionId, targetPath, current.data, backup.data);
      if (connectionRef.current !== connectionId) return;
      setLastSave({ path: targetPath, backup: result.backup, original: current.data, replacement: backup.data });
      load(cwdRef.current);
    } catch (err) { setError(t(`恢复失败：${err?.message ?? String(err)}`)); }
    finally { setBusy(false); }
  };

  const visibleEntries = entries === null ? null : filterEntries(entries, filter);
  const changes = editing && previewChanges ? changedLineRegions(editing.original, editing.text) : null;

  return (
    <div style={filesStyles.root}>
      {lastSave && <div style={filesStyles.compatNotice}>
        <div>{t(`已保存备份：${lastSave.backup}`)}</div>
        <button type="button" disabled={editorBusy} onClick={restoreLastSave} style={filesStyles.btnTiny}>{t("恢复上一个版本")}</button>
      </div>}
      <div style={filesStyles.toolbar}>
        <button onClick={goUp} disabled={cwd === "/"} style={filesStyles.btn} title={t("上级目录")}>↑</button>
        <span style={filesStyles.path} title={cwd}>{cwd}</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("过滤")}
          title={t("按名称过滤当前目录")}
          aria-label={t("按名称过滤当前目录")}
          style={filesStyles.filterInput}
        />
        <button
          onClick={pinCurrent}
          style={filesStyles.btn}
          title={favorites.includes(cwd) ? t("取消收藏当前目录") : t("收藏当前目录")}
          aria-label={favorites.includes(cwd) ? t("取消收藏当前目录") : t("收藏当前目录")}
        >{favorites.includes(cwd) ? "★" : "☆"}</button>
        <button onClick={() => setCreating(!creating)} style={filesStyles.btn} title={t("新建目录")}>{t("＋")}</button>
        <label style={filesStyles.btn} title={t("上传文件（可多选）")}>{t("上传")}<input
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
        <button onClick={() => setSearchOpen(!searchOpen)} style={filesStyles.btn} title={t("递归搜索文件名")}>{t("搜索")}</button>
        <button onClick={() => load(cwd)} disabled={busy} style={filesStyles.btn} title={t("刷新")}>↻</button>
      </div>

      {favorites.length > 0 && (
        <div style={filesStyles.favorites}>
          {favorites.map((path) => (
            <span key={path} style={filesStyles.favoriteChip}>
              <button type="button" onClick={() => load(path)} style={filesStyles.favoritePath} title={t(`进入 ${path}`)}>{path}</button>
              <button type="button" onClick={() => unpin(path)} style={filesStyles.favoriteRemove} title={t(`取消收藏 ${path}`)}>×</button>
            </span>
          ))}
        </div>
      )}

      {creating && (
        <div style={filesStyles.inlineForm}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doCreate()}
            placeholder={t("新目录名")}
            style={filesStyles.input}
          />
          <button onClick={doCreate} disabled={busy || !newName.trim()} style={filesStyles.btnPrimary}>{t("创建")}</button>
          <button onClick={() => setCreating(false)} style={filesStyles.btn}>{t("取消")}</button>
        </div>
      )}

      {error && <div style={filesStyles.error}>{error}</div>}
      {typeof globalThis.showSaveFilePicker === "function" && <div style={filesStyles.compatNotice}>
        <label><input type="checkbox" checked={persistDownloads} onChange={(event) => setPersistDownloads(event.target.checked)} /> {t("允许下载跨重启续传")}</label>
        {(persistDownloads || checkpoints.length > 0) && <div>{t("未完成的文件会以明文保存在此浏览器的本地存储中，占用磁盘空间；请在完成后或不再需要时清理。")}</div>}
        {checkpoints.map((checkpoint) => <div key={checkpoint.id} style={filesStyles.inlineForm}>
          <span title={checkpoint.path}>{checkpoint.path} · {formatSize(checkpoint.offset)} / {formatSize(checkpoint.total)}</span>
          <button type="button" style={filesStyles.btnTiny} onClick={() => { void resumeCheckpoint(checkpoint); }}>{t("续传")}</button>
          <button type="button" style={filesStyles.btnTiny} onClick={() => {
            if (!globalThis.confirm?.(t("删除本地未完成的下载？"))) return;
            void withDownloadLock(checkpoint.id, () => deleteDownloadCheckpoint(checkpoint.id)).then(() => refreshCheckpoints()).catch((err) => setError(err.message));
          }}>{t("清理")}</button>
        </div>)}
      </div>}
      {searchOpen && <div style={filesStyles.scpCard}>
        <div style={filesStyles.inlineForm}>
          <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSearch()} placeholder={t("搜索当前目录下的文件名")} style={filesStyles.input} />
          <button onClick={runSearch} disabled={!searchQuery.trim() || searchState?.running} style={filesStyles.btn}>{t("搜索")}</button>
          {searchState?.running && <button onClick={() => searchController.current?.abort()} style={filesStyles.btn}>{t("取消")}</button>}
        </div>
        {searchState && <div style={filesStyles.uploadProgress} role="status">
          <span>{searchState.running ? t("搜索中…") : t(`已搜索 ${searchState.visited} 个目录，找到 ${searchState.results.length} 项`)} {searchState.reason === "limit" ? t("（达到上限）") : searchState.reason === "timeout" ? t("（超时，结果不完整）") : searchState.reason === "cancelled" ? t("（已取消）") : ""}</span>
          {searchState.errors.length > 0 && <span>{t(`有 ${searchState.errors.length} 个目录无法读取，结果可能不完整`)}</span>}
          <div style={{ maxHeight: 150, overflowY: "auto" }}>{searchState.results.map((item) => <button key={item.path} style={{ ...filesStyles.favoritePath, display: "block", maxWidth: "100%" }} title={item.path} onClick={() => { load(item.isDirectory ? item.path : dirnameOf(item.path)); setSearchOpen(false); }}>{item.path}</button>)}</div>
        </div>}
      </div>}
      {agentTasks.length > 0 && <div style={{ ...filesStyles.scpCard, maxHeight: 180, overflowY: "auto" }}>
        <div style={filesStyles.inlineForm}><strong>{t("AI 上传任务")}</strong></div>
        {agentTasks.map((task) => <div key={task.id} style={filesStyles.uploadProgress} role="status">
          <span title={task.id}>{task.source.split(/[\\/]/).pop()} → {task.target} · {task.status === "running" ? t("进行中") : task.status === "done" ? t("已完成") : task.status === "cancelled" ? t("已取消") : t("失败")} {task.error}</span>
          {task.status === "running" && <progress value={task.sent} max={Math.max(task.total, 1)} />}
          {task.status === "running" && <button style={filesStyles.btnTiny} onClick={() => { void api.sftpTransferCancel(connectionId, task.id).catch((err) => setError(err.message)); }}>{t("取消")}</button>}
          {(task.status === "failed" || task.status === "cancelled") && <span>{t("可使用任务 ID 续传")}：{task.id}</span>}
          {(task.status === "failed" || task.status === "cancelled") && typeof api.sftpTransferDiscard === "function" && <button style={filesStyles.btnTiny} onClick={() => { void api.sftpTransferDiscard(connectionId, task.id).then(() => setAgentTasks((items) => items.filter((item) => item.id !== task.id))).catch((err) => setError(err.message)); }}>{t("清理残留")}</button>}
        </div>)}
      </div>}
      {tasks.length > 0 && <div style={{ ...filesStyles.scpCard, maxHeight: 180, overflowY: "auto" }}>
        <div style={filesStyles.inlineForm}><strong>{t("传输任务")}</strong><button style={filesStyles.btnTiny} onClick={() => setTasks((items) => items.filter((item) => item.status === "running"))}>{t("清除已结束")}</button></div>
        {tasks.map((task) => <div key={task.id} style={filesStyles.uploadProgress} role="status">
          <span>{task.kind === "upload" ? t("上传") : t("下载")} · {task.name} · {task.status === "running" ? (task.resuming ? t("正在验证并续传…") : task.verifying ? t("正在计算远端校验值…") : task.writing ? t("远端写入中") : t("进行中")) : task.status === "done" ? t("已完成") : task.status === "cancelled" ? t("已取消") : t("失败")} {task.error || ""}</span>
          {task.status === "running" && !task.verifying && !task.resuming && task.kind === "download" && task.speed > 0 && <span>{formatSize(task.sent)}{task.total != null ? ` / ${formatSize(task.total)}` : ""} · {formatSize(task.speed)}/s{task.total != null && task.sent < task.total ? ` · ${t("剩余约")} ${Math.ceil((task.total - task.sent) / task.speed)}s` : ""}</span>}
          {task.status === "running" && (task.verifying || task.resuming
            ? <><progress aria-label={t("正在计算远端校验值…")} value={task.verification?.total > 0 ? Math.min(task.verification.bytes, task.verification.total) : undefined} max={task.verification?.total || 1} />
              {task.verification && <span>{formatSize(task.verification.bytes)} / {formatSize(task.verification.total)}</span>}</>
            : task.total != null && <progress value={task.sent} max={Math.max(task.total, 1)} />)}
          {task.status === "running" && task.cancellable && <button style={filesStyles.btnTiny} onClick={() => controllers.current.get(task.id)?.abort()}>{t("取消")}</button>}
        </div>)}
      </div>}

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
          <button onClick={doRename} disabled={busy || !renameTo.trim()} style={filesStyles.btnPrimary}>{t("改名")}</button>
          <button onClick={() => setRenaming(false)} style={filesStyles.btn}>{t("取消")}</button>
        </div>
      )}

      <div
        style={{ ...filesStyles.list, ...(dragActive ? filesStyles.listDrop : {}) }}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          const files = [...(e.dataTransfer?.files ?? [])];
          if (files.length > 0) upload(files);
        }}
      >
        {dragActive && <div style={filesStyles.dropHint}>{t(`松开鼠标：上传到 ${cwd}`)}</div>}
        {!entries || entries.length === 0 ? (
          <div style={filesStyles.empty}>{busy ? t("加载中…") : (entries && entries.length === 0 ? t("（空目录，可拖入文件上传）") : t("请连接服务器"))}</div>
        ) : visibleEntries.length === 0 ? (
          <div style={filesStyles.empty}>{t("（无匹配项）")}</div>
        ) : (
          visibleEntries.map((entry) => (
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
              title={entry.isDirectory ? t(`${entry.name}（双击打开）`) : t(`${entry.name}  (${entry.size} bytes，双击下载)`)}
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
                      title={t("在右侧终端 cd 到此目录")}
                      aria-label={t(`在终端 cd 到 ${joinPath(cwd, entry.name)}`)}
                    >cd</button>
                  )}
                  {!entry.isDirectory && (
                    <button onClick={() => openEditor(entry)} disabled={busy} style={filesStyles.btnTiny} title={t("在文本编辑器中打开（上限 10 MB）")}>{t("编辑")}</button>
                  )}
                  {!entry.isDirectory && /\.dsh-backup-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name) && <button onClick={() => restoreBackup(entry)} disabled={busy} style={filesStyles.btnTiny}>{t("恢复备份")}</button>}
                  <button onClick={() => download(entry)} disabled={busy} style={filesStyles.btnTiny}>{t("下载")}</button>
                  <button onClick={() => setRenaming(!renaming)} style={filesStyles.btnTiny}>{t("改名")}</button>
                  <button onClick={() => doDelete(entry)} disabled={busy} style={filesStyles.btnDanger}>{t("删除")}</button>
                </span>
              )}
            </div>
          ))
        )}
      </div>

      {editing && (
        <div style={filesStyles.editorBackdrop}>
          <div style={filesStyles.editorDialog}>
            <div style={filesStyles.editorTitle} title={editing.path}>{t(`编辑：${editing.path}`)}</div>
            <div style={filesStyles.editorMeta}>
              {formatSize(editing.bytes)} · UTF-8
              {editing.replaced ? t(" · 含无法按 UTF-8 解码的字节（保存会按 UTF-8 重写）") : ""}
              {editing.text !== editing.original ? t(" · 已修改") : ""}
            </div>
            {previewChanges ? <div style={filesStyles.diffColumns}>
              {[changes.left, changes.right].map((part, index) => <div key={index}>
                <strong>{index === 0 ? t("修改前") : t("修改后")}</strong>
                <pre style={filesStyles.diffText}>{part.before}{part.before && "\n"}<span style={{ background: index === 0 ? "rgba(248,81,73,.2)" : "rgba(46,160,67,.2)" }}>{part.changed}</span>{part.after && "\n"}{part.after}</pre>
              </div>)}
            </div> : <textarea
              autoFocus
              value={editing.text}
              onChange={(event) => setEditing({ ...editing, text: event.target.value })}
              spellCheck={false}
              style={filesStyles.editorText}
            />}
            <div style={filesStyles.editorActions}>
              <button type="button" onClick={() => setEditing(null)} style={filesStyles.btn}>{t("关闭")}</button>
              <button type="button" onClick={() => setPreviewChanges(!previewChanges)} style={filesStyles.btn}>{previewChanges ? t("返回编辑") : t("预览修改")}</button>
              <button
                type="button"
                onClick={saveEditor}
                disabled={editorBusy || editing.text === editing.original}
                style={filesStyles.btnPrimary}
              >{editorBusy ? t("保存中…") : t("保存")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const filesStyles = {
  diffColumns: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, overflow: "auto", flex: 1, minHeight: 0 },
  diffText: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 },
  root: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 6 },
  toolbar: { display: "flex", alignItems: "center", gap: 6, flex: "none" },
  path: { flex: 1, fontSize: 12, color: "var(--dsw-alias-label-secondary, #9aa3af)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" },
  btn: {
    background: "var(--dsw-alias-bg-layer-1, transparent)", border: "1px solid var(--dsw-alias-border-l4, #3a414b)", color: "var(--dsw-alias-label-primary, #d7dbe2)",
    borderRadius: 6, padding: "3px 8px", fontSize: 12, cursor: "pointer", flex: "none"
  },
  btnTiny: {
    background: "var(--dsw-alias-bg-layer-1, transparent)", border: "1px solid var(--dsw-alias-border-l4, #3a414b)", color: "var(--dsw-alias-label-primary, #d7dbe2)",
    borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer"
  },
  btnPrimary: {
    background: "var(--dsw-alias-button-primary-fill, #2d6cdf)", color: "var(--dsw-alias-label-primary-foreground, #fff)", border: "none", borderRadius: 6,
    padding: "3px 10px", fontSize: 12, cursor: "pointer"
  },
  btnDanger: {
    background: "transparent", border: "1px solid #f85149", color: "#f85149",
    borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer"
  },
  inlineForm: { display: "flex", gap: 6, alignItems: "center", flex: "none" },
  input: {
    flex: 1, background: "var(--dsw-alias-bg-layer-1, #101418)", border: "1px solid var(--dsw-alias-border-l4, #2a303a)", borderRadius: 6,
    color: "var(--dsw-alias-label-primary, #d7dbe2)", padding: "4px 8px", fontSize: 12, outline: "none"
  },
  error: {
    padding: "6px 10px", fontSize: 12, color: "#f85149",
    background: "rgba(248,81,73,.1)", border: "1px solid rgba(248,81,73,.3)", borderRadius: 6, flex: "none"
  },
  compatNotice: {
    padding: "8px 10px", fontSize: 12, color: "#f0c36d",
    background: "rgba(240,195,109,.1)", border: "1px solid rgba(240,195,109,.35)", borderRadius: 6, flex: "none"
  },
  compatDetail: { marginTop: 4, color: "var(--dsw-alias-label-secondary, #9aa3af)", wordBreak: "break-word" },
  scpCard: { display: "flex", flexDirection: "column", gap: 8, padding: 10, background: "var(--dsw-alias-bg-layer-1, transparent)", border: "1px solid var(--dsw-alias-border-l3, #2a303a)", borderRadius: 6, flex: "none" },
  scpTitle: { fontSize: 13, color: "var(--dsw-alias-label-primary, #d7dbe2)", fontWeight: 600 },
  fileInput: { fontSize: 12, color: "var(--dsw-alias-label-primary, #c8ccd1)" },
  rowSize: { flex: "none", fontSize: 11, color: "var(--dsw-alias-label-secondary, #8b93a1)" },
  rowActions: { display: "flex", gap: 4, flex: "none", marginLeft: "auto" },
  list: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1 },
  row: { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 6, cursor: "pointer" },
  rowSelected: { background: "rgba(45,108,223,.18)" },
  icon: { flex: "none", fontSize: 13, display: "inline-flex", alignItems: "center" },
  rowName: { flex: 1, fontSize: 13, color: "var(--dsw-alias-label-primary, #d7dbe2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  empty: { margin: "auto", fontSize: 12, color: "var(--dsw-alias-label-secondary, #8b93a1)" },
  filterInput: {
    width: 110, flex: "none", background: "var(--dsw-alias-bg-layer-1, #101418)", border: "1px solid var(--dsw-alias-border-l4, #2a303a)",
    borderRadius: 6, color: "var(--dsw-alias-label-primary, #d7dbe2)", padding: "3px 8px", fontSize: 12, outline: "none"
  },
  favorites: { display: "flex", flexWrap: "wrap", gap: 4, flex: "none" },
  favoriteChip: {
    display: "inline-flex", alignItems: "center", gap: 2, border: "1px solid var(--dsw-alias-border-l4, #2a303a)",
    borderRadius: 999, padding: "1px 2px 1px 8px", background: "var(--dsw-alias-bg-layer-1, transparent)"
  },
  favoritePath: {
    background: "transparent", border: "none", color: "var(--dsw-alias-label-primary, #d7dbe2)", cursor: "pointer",
    fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: 0
  },
  favoriteRemove: { background: "transparent", border: "none", color: "var(--dsw-alias-label-secondary, #8b93a1)", cursor: "pointer", fontSize: 12, padding: "0 4px" },
  listDrop: { outline: "1px dashed var(--dsw-alias-button-primary-fill, #2d6cdf)", outlineOffset: -4, borderRadius: 6 },
  dropHint: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #8b93a1)", padding: "4px 8px" },
  uploadProgress: { display: "grid", gap: 4, fontSize: 12, color: "var(--dsw-alias-label-secondary, #8b93a1)" },
  uploadNotice: { fontSize: 12, color: "var(--dsw-alias-label-positive, #4ea66a)" },
  editorBackdrop: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60
  },
  editorDialog: {
    width: "min(860px, 92vw)", height: "min(640px, 86vh)", display: "flex", flexDirection: "column", gap: 8, padding: 12,
    background: "var(--dsw-alias-bg-layer-2, #171b21)", border: "1px solid var(--dsw-alias-border-l3, #2a303a)", borderRadius: 10
  },
  editorTitle: {
    fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #d7dbe2)",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
  },
  editorMeta: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #8b93a1)", flex: "none" },
  editorText: {
    flex: 1, minHeight: 0, resize: "none", background: "var(--dsw-alias-bg-layer-1, #101418)", color: "var(--dsw-alias-label-primary, #d7dbe2)",
    border: "1px solid var(--dsw-alias-border-l4, #2a303a)", borderRadius: 6, padding: 10, fontSize: 12, lineHeight: 1.5,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "pre", overflow: "auto", outline: "none"
  },
  editorActions: { display: "flex", justifyContent: "flex-end", gap: 8, flex: "none" }
};
