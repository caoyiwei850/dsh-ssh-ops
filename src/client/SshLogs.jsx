/**
 * Session-log tab: recorded SSH sessions with preview, paging, search and
 * delete. Logs live on the host (one file per session); this panel only reads
 * bounded ranges so a huge recording never reaches the browser in full.
 */
import * as React from "react";
import { readableLine, toReadableText } from "../terminal-text.js";
const { useEffect, useState, useRef } = React;

const PAGE_BYTES = 48 * 1024;

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatWhen(iso) {
  if (typeof iso !== "string" || iso === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function SshLogs({ api }) {
  const [logs, setLogs] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState("");
  const [nextOffset, setNextOffset] = useState(0);
  const [eof, setEof] = useState(true);
  const [size, setSize] = useState(0);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Guard against a slow earlier response overwriting a newer selection.
  const loadSeq = useRef(0);

  const refresh = async () => {
    setError(null);
    try {
      const value = await api.sessionLogList();
      setEnabled(value.enabled !== false);
      setLogs(Array.isArray(value.logs) ? value.logs : []);
    } catch (err) {
      setError(err?.message ?? String(err));
      setLogs([]);
    }
  };

  useEffect(() => { refresh(); }, []);

  const openLog = async (log, { offset = 0, append = false } = {}) => {
    const seq = ++loadSeq.current;
    setBusy(true);
    setError(null);
    try {
      const value = await api.sessionLogRead(log.sessionId, offset, PAGE_BYTES);
      if (seq !== loadSeq.current) return;
      setSelected(log);
      setSize(value.size);
      setNextOffset(value.nextOffset);
      setEof(value.eof);
      // The log keeps raw bytes (a recording must be faithful); the viewer
      // shows the readable text, not the escape debris that produced it.
      const readable = toReadableText(value.data);
      setContent((previous) => (append ? previous + readable : readable));
      setHits(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err?.message ?? String(err));
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  };

  const search = async () => {
    if (!selected || query.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const value = await api.sessionLogSearch(selected.sessionId, query.trim(), 200);
      setHits(Array.isArray(value.hits) ? value.hits.map((hit) => ({ ...hit, line: readableLine(hit.line) })) : []);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      let offset = 0;
      let text = "";
      for (;;) {
        const value = await api.sessionLogRead(selected.sessionId, offset, 1024 * 1024);
        text += value.data;
        offset = value.nextOffset;
        if (value.eof || offset <= value.startOffset) break;
      }
      // The downloaded .log is the reader's copy: readable text, not escapes.
      const where = [selected.name, selected.host].filter(Boolean).join("-") || "session";
      const blob = new Blob([toReadableText(text)], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ssh-session-${where}-${selected.sessionId}.log`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Remove every log that recorded nothing — they carry no information. */
  const pruneEmpty = async () => {
    const empty = (logs ?? []).filter((log) => log.bytes === 0);
    if (empty.length === 0) return;
    if (!globalThis.confirm?.(`删除 ${empty.length} 条 0 字节的会话日志？`)) return;
    setBusy(true);
    setError(null);
    try {
      for (const log of empty) await api.sessionLogDelete(log.sessionId);
      await refresh();
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeLog = async (log) => {
    if (!globalThis.confirm?.(`删除会话日志 ${log.sessionId}？此操作不可恢复。`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.sessionLogDelete(log.sessionId);
      if (selected?.sessionId === log.sessionId) {
        setSelected(null);
        setContent("");
        setHits(null);
      }
      await refresh();
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.root}>
      <div style={styles.toolbar}>
        <span style={styles.title}>会话日志</span>
        <button onClick={refresh} disabled={busy} style={styles.btn} title="刷新列表">↻</button>
        {(logs ?? []).some((log) => log.bytes === 0) && (
          <button
            onClick={pruneEmpty}
            disabled={busy}
            style={styles.btn}
            title="删除所有 0 字节的会话日志"
          >清理空日志</button>
        )}
        {!enabled && <span style={styles.hint}>录制已关闭（config.sessionLogEnabled = false）</span>}
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.body}>
        <div style={styles.list}>
          {logs === null ? (
            <div style={styles.empty}>加载中…</div>
          ) : logs.length === 0 ? (
            <div style={styles.empty}>还没有录制的会话。打开 SSH 终端后会自动记录。</div>
          ) : (
            logs.map((log) => (
              <div
                key={log.sessionId}
                onClick={() => openLog(log)}
                style={{ ...styles.row, ...(selected?.sessionId === log.sessionId ? styles.rowActive : {}) }}
                title={log.sessionId}
              >
                <div style={styles.rowTitle}>
                  <span>{[log.name, log.host].filter(Boolean).join(" @ ") || "未知主机"}</span>
                  <span style={styles.rowMeta}>{formatBytes(log.bytes)}{log.truncated ? " · 已截断" : ""}</span>
                </div>
                <div style={styles.rowSub}>
                  <span>{formatWhen(log.startedAt)}</span>
                  <span>{log.endedAt === null ? "录制中" : (log.exitCode === null ? "已结束" : `退出码 ${log.exitCode}`)}</span>
                  <button
                    onClick={(event) => { event.stopPropagation(); removeLog(log); }}
                    disabled={busy}
                    style={styles.rowDelete}
                    title={`删除 ${log.sessionId}`}
                  >×</button>
                </div>
              </div>
            ))
          )}
        </div>

        <div style={styles.viewer}>
          {selected === null ? (
            <div style={styles.empty}>选择左侧一条会话查看内容</div>
          ) : (
            <>
              <div style={styles.viewerBar}>
                <span style={styles.viewerPath} title={selected.sessionId}>{selected.sessionId}</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && search()}
                  placeholder="搜索…"
                  style={styles.searchInput}
                />
                <button onClick={search} disabled={busy || query.trim() === ""} style={styles.btn}>搜索</button>
                <button onClick={download} disabled={busy} style={styles.btn}>下载</button>
              </div>
              {hits !== null && (
                <div style={styles.hits}>
                  {hits.length === 0 ? (
                    <div style={styles.hint}>没有匹配行</div>
                  ) : hits.map((hit, index) => (
                    <button
                      key={`${hit.offset}-${index}`}
                      onClick={() => openLog(selected, { offset: hit.offset })}
                      style={styles.hitRow}
                      title={`跳到 offset ${hit.offset}`}
                    >{hit.line}</button>
                  ))}
                </div>
              )}
              <pre style={styles.pre}>{content}{content === "" ? "（空）" : ""}</pre>
              <div style={styles.viewerFoot}>
                <span style={styles.hint}>{formatBytes(nextOffset)} / {formatBytes(size)}{eof ? " · 已到末尾" : ""}</span>
                {!eof && (
                  <button
                    onClick={() => openLog(selected, { offset: nextOffset, append: true })}
                    disabled={busy}
                    style={styles.btn}
                  >加载更多</button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const styles = {
  root: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 6 },
  toolbar: { display: "flex", alignItems: "center", gap: 8, flex: "none" },
  title: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary, #d7dbe2)" },
  btn: {
    background: "var(--dsw-alias-bg-layer-1, transparent)", border: "1px solid var(--dsw-alias-border-l4, #3a414b)",
    color: "var(--dsw-alias-label-primary, #d7dbe2)", borderRadius: 6, padding: "3px 8px", fontSize: 12, cursor: "pointer", flex: "none"
  },
  hint: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #8b93a1)" },
  error: {
    padding: "6px 10px", fontSize: 12, color: "#f85149",
    background: "rgba(248,81,73,.1)", border: "1px solid rgba(248,81,73,.3)", borderRadius: 6, flex: "none"
  },
  body: { display: "flex", gap: 8, flex: 1, minHeight: 0 },
  list: { width: 210, flex: "none", overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 },
  empty: { margin: "auto", fontSize: 12, color: "var(--dsw-alias-label-secondary, #8b93a1)", textAlign: "center", padding: 12 },
  row: {
    display: "flex", flexDirection: "column", gap: 2, padding: "6px 8px", borderRadius: 6, cursor: "pointer",
    border: "1px solid transparent"
  },
  rowActive: { background: "rgba(45,108,223,.18)", borderColor: "var(--dsw-alias-border-l3, #2a303a)" },
  rowTitle: { display: "flex", justifyContent: "space-between", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-primary, #d7dbe2)" },
  rowMeta: { flex: "none", fontSize: 11, color: "var(--dsw-alias-label-secondary, #8b93a1)" },
  rowSub: { display: "flex", justifyContent: "space-between", gap: 6, fontSize: 11, color: "var(--dsw-alias-label-secondary, #8b93a1)" },
  rowDelete: { background: "transparent", border: "none", color: "#8b93a1", cursor: "pointer", fontSize: 12, padding: "0 4px" },
  viewer: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 },
  viewerBar: { display: "flex", alignItems: "center", gap: 6, flex: "none" },
  viewerPath: { flex: 1, fontSize: 11, color: "var(--dsw-alias-label-secondary, #8b93a1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  searchInput: {
    width: 150, flex: "none", background: "var(--dsw-alias-bg-layer-1, #101418)", border: "1px solid var(--dsw-alias-border-l4, #2a303a)",
    borderRadius: 6, color: "var(--dsw-alias-label-primary, #d7dbe2)", padding: "3px 8px", fontSize: 12, outline: "none"
  },
  hits: { maxHeight: 120, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1, flex: "none" },
  hitRow: {
    textAlign: "left", background: "transparent", border: "none", cursor: "pointer", padding: "2px 4px", borderRadius: 4,
    color: "var(--dsw-alias-label-primary, #d7dbe2)", fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
  },
  pre: {
    flex: 1, minHeight: 0, margin: 0, overflow: "auto", padding: 8, borderRadius: 6,
    background: "var(--dsw-alias-bg-layer-1, #101418)", border: "1px solid var(--dsw-alias-border-l4, #2a303a)",
    color: "var(--dsw-alias-label-primary, #d7dbe2)", fontSize: 11, lineHeight: 1.45,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "pre-wrap", wordBreak: "break-all"
  },
  viewerFoot: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flex: "none" }
};
