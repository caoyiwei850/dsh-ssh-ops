/**
 * The SSH workspace: connection toolbar, inner tabs (terminal / files /
 * tunnels / snippets / database) and the dialogs. It is the shared INNER
 * content rendered by two hosts:
 *
 * - `SshDrawer.jsx` — the legacy fixed right-side floating panel (old DSH
 *   fallback), which adds positioning, drag-resize and the hide button.
 * - `SshSidebarBody.jsx` — a body of the official right-Sidebar tab
 *   (`sidebar.right.pane.tab`, new DSH), which owns width, split and
 *   fullscreen.
 *
 * The workspace itself owns no outer geometry. Terminals are keep-alive:
 * unmounting a view (tab switch, sidebar collapse, chat switch) never
 * disposes the xterm instance, so remounting restores the full scrollback
 * while the host replays output buffered in the meantime.
 */
import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { isMacPlatform, runFind, searchResultLabel, searchShortcutLabel, searchShortcutMatches } from "./terminal-search.js";
import { XTERM_CSS } from "./xterm-css.js";
import { useSshUi, sshUiSetActiveConnection, sshUiSetBusy, sshUiSetConnections, sshUiSetError } from "./store.js";
import { IconRobot16 } from "./IconRobot16.jsx";
import { SshFiles } from "./SshFiles.jsx";
import { SshTunnels } from "./SshTunnels.jsx";
import { SshDatabase } from "./SshDatabase.jsx";
import { SshLogs } from "./SshLogs.jsx";
import { privateKeyProblem } from "./pemkey.js";
import { availableCommandSnippets, loadCommandSnippets, matchingCommandSnippets, saveCommandSnippets, searchCommandSnippets } from "./command-snippets.js";
import { createTerminalPool } from "./terminal-pool.js";
import { applyTerminalTheme, createTerminalThemeWatcher, getTerminalTheme } from "./terminal-theme.js";
import {
  DRAWER_VIEW_ID,
  adoptIntoView,
  claimPendingOpens,
  closeInView,
  forgetView,
  openInView,
  paneOpenRequestsRevision,
  reconcileViews,
  resolvePaneActiveConnection,
  selectInView,
  subscribePaneSessions,
  viewSession
} from "./pane-selection.js";

const { useEffect, useRef, useState, useSyncExternalStore, Component } = React;

/** Error boundary so a crash in one tab (Files/Tunnels) never closes the panel. */
class TabErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error("[dsh-ssh-ops] tab crashed:", error);
  }
  render() {
    if (this.state.error) {
      return React.createElement("div", {
        style: { margin: "auto", padding: 16, fontSize: 12, color: "#f85149", textAlign: "center" }
      }, `此页签出错：${this.state.error?.message ?? String(this.state.error)}`);
    }
    return this.props.children;
  }
}

let stylesInjected = false;

/**
 * Workspace button visuals that need real pseudo-classes (hover/active on the
 * add-server button) and therefore cannot live in inline style objects. Kept
 * class-scoped and plugin-prefixed; only colors/borders live here — geometry
 * stays with the inline styles so the two cannot drift.
 */
const PANEL_CSS = `
.dsh-ssh-ops-add-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid rgba(45, 108, 223, 0.55);
  background: rgba(45, 108, 223, 0.14);
  color: #7fb0f5;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 550;
  line-height: 1;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.dsh-ssh-ops-add-btn:hover {
  background: #2d6cdf;
  border-color: #2d6cdf;
  color: #fff;
}
.dsh-ssh-ops-add-btn:active {
  background: #255cba;
  border-color: #255cba;
  color: #fff;
}
`;

/**
 * Inject the xterm stylesheet and the workspace button styles once. Neither
 * carries outer-geometry rules: outer geometry (drawer width, chat-column
 * reservation, sidebar fit) belongs to the hosts.
 */
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = XTERM_CSS + PANEL_CSS;
  document.head.appendChild(style);
  ensureTerminalThemeWatcher();
}

/**
 * Keep-alive pool for this workspace's terminals, keyed by host SSH session
 * id. The official Sidebar draws only the ACTIVE tab's body, so switching to
 * the Files tab (or closing the SSH tab, or switching chats) unmounts every
 * XtermView; the pool keeps each xterm instance — and with it the scrollback —
 * alive across those unmounts. Host-side, output written while no view is
 * attached accumulates in the session buffer and is replayed on re-attach.
 */
const terminalPool = createTerminalPool({
  create: () => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      // The search addon's match HIGHLIGHTS are gated behind this flag; the
      // search itself still works, but without it every find throws
      // "proposed API" and the reader sees no matches at all.
      allowProposedApi: true,
      // Some remote commands produce LF-only text. Treat it as a normal
      // terminal newline so rows do not continue at the previous column.
      convertEol: true,
      theme: getTerminalTheme()
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // One SearchAddon per terminal: it searches the live scrollback (the
    // session's own history), so a view can be attached and detached freely.
    const search = new SearchAddon();
    term.loadAddon(search);
    return { term, fit, search };
  },
  max: 8
});

let stopTerminalThemeWatcher = null;

function ensureTerminalThemeWatcher() {
  if (stopTerminalThemeWatcher !== null || typeof document === "undefined") return;
  stopTerminalThemeWatcher = createTerminalThemeWatcher({
    apply: (theme) => {
      applyWorkspaceTheme(theme);
      terminalPool.forEachTerm((term) => applyTerminalTheme(term, theme));
    }
  });
}

function applyWorkspaceTheme(theme) {
  const light = theme.background === "#f7f8fa";
  const colors = light
    ? { bg: "#f7f8fa", surface: "#ffffff", input: "#ffffff", border: "#d9dee7", text: "#1d2128", muted: "#667085", tab: "#eef1f5" }
    : { bg: "#101418", surface: "#161b21", input: "#101418", border: "#3a414b", text: "#d7dbe2", muted: "#8b93a1", tab: "#1a1f26" };
  for (const [name, value] of Object.entries(colors)) document.documentElement.style.setProperty(`--dsh-ssh-ops-${name}`, value);
}

/** One xterm view bound to one host session via long-poll reads / stream push. */
function XtermView({ api, sessionId, connectionId }) {
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);
  /** The pooled entry (terminal + addons) this mount attached to. */
  const entryRef = useRef(null);
  const [closed, setClosed] = useState(() => terminalPool.get(sessionId)?.closed ?? false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null);

  useEffect(() => {
    ensureStyles();
    const container = containerRef.current;
    if (!container) return undefined;
    const owner = { sessionId };
    const entry = terminalPool.acquire(sessionId, owner);
    entryRef.current = entry;
    const term = entry.term;
    const fit = entry.fit;

    // (Re)attach: a pooled terminal keeps its DOM element — move it into this
    // mount's container instead of opening it a second time. xterm's open()
    // early-returns once opened, so the re-parent plus a full refresh is what
    // actually redraws it at the new size.
    if (entry.reused && term.element) {
      if (term.element.parentElement !== container) container.appendChild(term.element);
      try { term.refresh(0, Math.max(0, term.rows - 1)); } catch {}
    } else {
      term.open(container);
    }

    let alive = true;
    let writing = false;
    let pendingInput = "";
    const MAX_PENDING_INPUT = 64 * 1024;

    const flushInput = () => {
      if (!alive || writing || pendingInput.length === 0) return;
      const data = pendingInput;
      pendingInput = "";
      writing = true;
      api.write(sessionId, data).catch(() => {}).finally(() => {
        writing = false;
        flushInput();
      });
    };

    const onData = (data) => {
      // A stalled transport gets one bounded buffer, rather than an unbounded
      // promise chain. Input after close is discarded and never replayed.
      if (!alive) return;
      if (pendingInput.length + data.length > MAX_PENDING_INPUT) return;
      pendingInput += data;
      flushInput();
    };
    const inputSubscription = term.onData(onData);

    // Search runs over this terminal's live scrollback via the addon; the
    // pane only adds the bar, the count and the keyboard path. Ctrl/Cmd+F is
    // caught before xterm sees it (and before the browser's own find opens).
    const search = entry.search;
    const resultsSubscription = search?.onDidChangeResults?.((value) => {
      if (alive) setSearchResults(value);
    });
    const isMac = isMacPlatform(globalThis.navigator?.platform ?? globalThis.navigator?.userAgent);
    const onKeyDown = (event) => {
      if (!searchShortcutMatches(event, isMac)) return;
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    };
    container.addEventListener("keydown", onKeyDown, true);

    const controller = new AbortController();
    const NO_SESSION_NOTICE = `\r\n\x1b[31m[终端会话已失效：DSH 服务已重启或该连接已关闭。请到 设置 → SSH 资源 重新连接]\x1b[0m\r\n`;
    const EXIT_NOTICE = `\r\n\x1b[90m[session exited]\x1b[0m\r\n`;
    const markClosed = () => {
      // The closed flag belongs to the session, not this mount: a remount
      // (tab switch back, sidebar reopen) must not reset it.
      terminalPool.setClosed(sessionId, true);
      setClosed(true);
    };
    const showItem = ({ data, exit, startOffset, offset }) => {
      const fresh = entry.consume(data ?? "", startOffset, offset);
      if (fresh) term.write(fresh);
      if (exit !== null) {
        markClosed();
        term.write(EXIT_NOTICE);
        return true;
      }
      return false;
    };

    const backoff = async (steps) => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 500 * 2 ** steps)));
    };

    // Preferred path: host push over the Gateway WebSocket mux (typert
    // mode:'stream'). The keepalive heartbeat resets the error backoff, so a
    // quiet-but-alive terminal never degrades into retries.
    const streamLoop = async () => {
      let errorBackoff = 0;
      while (alive) {
        const stream = await api.streamTerminal(sessionId, controller.signal, entry.offset);
        if (!stream) return false;
        try {
          for await (const item of stream) {
            if (!alive) return true;
            errorBackoff = 0;
            if (showItem(item)) return true;
          }
          // Generator ended without an exit item: the mux dropped the stream
          // (host reload, network blip). Back off, then resubscribe — output
          // written meanwhile is buffered host-side and delivered on attach.
        } catch (error) {
          if (!alive) return true;
          if (error?.code === "no-session") {
            // The host restarted or the connection was closed server-side.
            // Without this notice the pane freezes on stale output and it
            // looks like agent commands stopped being echoed.
            markClosed();
            term.write(NO_SESSION_NOTICE);
            return true;
          }
        }
        if (!alive) return true;
        await backoff(errorBackoff++);
      }
      return true;
    };

    // Fallback path: the original 300ms long-poll, kept for hosts/carriers
    // without the stream mux.
    const pollLoop = async () => {
      let errorBackoff = 0;
      while (alive) {
        try {
          const { data, exit, startOffset, offset } = await api.read(sessionId, 300, entry.offset);
          if (!alive) return;
          errorBackoff = 0;
          if (showItem({ data, exit, startOffset, offset })) return;
        } catch (error) {
          if (!alive) return;
          if (error?.code === "no-session") {
            markClosed();
            term.write(NO_SESSION_NOTICE);
            return;
          }
          // Back off so a dead transport cannot become a tight retry loop.
          await backoff(errorBackoff++);
        }
      }
    };

    const loop = async () => {
      const handled = await streamLoop();
      if (handled || !alive) return;
      await pollLoop();
    };
    loop();

    // Refit whenever the container gets a new box: sidebar drag-resize,
    // fullscreen switch, tab re-activation, server-tab switch — and the first
    // observe after a remount, which is what restores correct dimensions when
    // the terminal returns while the sidebar changed size while hidden.
    let lastCols = 0;
    let lastRows = 0;
    const fitNow = () => {
      if (!alive) return;
      try {
        fit.fit();
        if (term.cols > 0 && term.rows > 0 && (term.cols !== lastCols || term.rows !== lastRows)) {
          lastCols = term.cols;
          lastRows = term.rows;
          api.resize(sessionId, term.cols, term.rows).catch(() => {});
        }
      } catch {}
    };
    const raf = requestAnimationFrame(fitNow);
    const resizeObserver = new ResizeObserver(fitNow);
    resizeObserver.observe(container);

    return () => {
      alive = false;
      controller.abort();
      cancelAnimationFrame(raf);
      pendingInput = "";
      container.removeEventListener("keydown", onKeyDown, true);
      resultsSubscription?.dispose?.();
      search?.clearDecorations?.();
      entryRef.current = null;
      setSearchOpen(false);
      resizeObserver.disconnect();
      inputSubscription.dispose();
      // Detach only — the pooled terminal (and its scrollback) survives this
      // unmount. Connections are host-side and are not touched here either.
      terminalPool.release(sessionId, owner);
    };
  }, [sessionId, connectionId, api]);

  const runSearch = (backwards) => {
    const search = entryRef.current?.search;
    if (search === undefined || query.trim() === "") return;
    runFind(search, query, { backwards, warn: console.warn });
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchResults(null);
    entryRef.current?.search?.clearDecorations?.();
    containerRef.current?.parentElement?.querySelector("textarea")?.focus?.();
  };

  return (
    <div style={panelStyles.xtermHost}>
      <div style={panelStyles.xtermWrap} ref={containerRef} data-closed={closed || undefined} />
      {/* The shortcut alone is not discoverable: this button is the visible
          entry point, and its tooltip teaches the keyboard path. */}
      {!searchOpen && (
        <button
          type="button"
          onClick={() => {
            setSearchOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 0);
          }}
          style={panelStyles.searchOpenBtn}
          title={`在终端里查找（${searchShortcutLabel(isMacPlatform(globalThis.navigator?.platform ?? globalThis.navigator?.userAgent))}）`}
          aria-label="在终端里查找"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 10L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {searchOpen && (
        <div style={panelStyles.searchBar}>
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              const text = event.target.value.trim();
              const search = entryRef.current?.search;
              if (text !== "" && search !== undefined) runFind(search, text, { warn: console.warn });
              else {
                setSearchResults(null);
                entryRef.current?.search?.clearDecorations?.();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); runSearch(event.shiftKey); }
              else if (event.key === "Escape") { event.preventDefault(); closeSearch(); }
            }}
            placeholder="在终端里查找…"
            aria-label="在终端里查找"
            style={panelStyles.searchInput}
          />
          <span style={panelStyles.searchCount} aria-live="polite">{searchResultLabel(searchResults, query)}</span>
          <button type="button" onClick={() => runSearch(true)} style={panelStyles.searchBtn} title="上一个匹配 (Shift+Enter)">↑</button>
          <button type="button" onClick={() => runSearch(false)} style={panelStyles.searchBtn} title="下一个匹配 (Enter)">↓</button>
          <button type="button" onClick={closeSearch} style={panelStyles.searchBtn} title="关闭 (Esc)">×</button>
        </div>
      )}
    </div>
  );
}

function ConnectDialog({ api, credentials, onClose, onConnected }) {
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: "22",
    username: "root",
    authKind: "password",
    credentialId: "",
    password: "",
    privateKey: "",
    passphrase: ""
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [keyFileName, setKeyFileName] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [sharedCredentials, setSharedCredentials] = useState([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  // Off by default: joining a live connection makes this pane share that
  // connection's single shell, so both panes would mirror each other and the
  // operator could not work in them independently. Opting in is for deliberately
  // watching the agent in the same shell.
  const [reuseExisting, setReuseExisting] = useState(false);
  const keyFileInputRef = useRef(null);
  const [showProxyJump, setShowProxyJump] = useState(false);
  const [proxyJumps, setProxyJumps] = useState([]);

  useEffect(() => {
    let alive = true;
    Promise.all([api.profileList(), api.credentialList?.() ?? { credentials: [] }]).then(([profileResult, credentialResult]) => {
      if (!alive) return;
      setProfiles(profileResult.profiles);
      setSharedCredentials(credentialResult.credentials ?? []);
    }).catch(() => {});
    return () => { alive = false; };
  }, [api]);

  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  const addProxyJump = () => setProxyJumps((hops) => [...hops, { profileId: "" }]);
  const removeProxyJump = (index) => {
    setProxyJumps((hops) => hops.filter((_, i) => i !== index));
  };
  const updateProxyJump = (index, key, value) => {
    setProxyJumps((hops) => hops.map((hop, i) => i === index ? { ...hop, [key]: value } : hop));
  };

  const importSshConfig = async () => {
    setBusy(true);
    setError(null);
    setStatus("正在读取 ~/.ssh/config…");
    try {
      const result = await api.sshConfigImport();
      setStatus(null);
      if (!result || !result.hosts || result.hosts.length === 0) {
        setError("~/.ssh/config 里没有可导入的主机（Host * 会被跳过）");
        return;
      }
      const first = result.hosts[0];
      setForm((f) => ({
        ...f,
        name: first.name,
        host: first.host,
        port: String(first.port),
        username: first.username || "root",
        authKind: first.identityFile ? "key" : "password",
        privateKey: "",
        passphrase: ""
      }));
      if (result.hosts.length > 1) {
        setError(`已导入第 1 台「${first.name}」，共 ${result.hosts.length} 台。其余请在设置里逐台添加。`);
      } else {
        setError(`已导入「${first.name}」（${first.host}），请补充认证信息后连接。`);
      }
    } catch (err) {
      setStatus(null);
      setError(`导入失败：${err?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    // Temporary connections carry the key inline: reject a truncated or
    // empty-shell paste up front instead of surfacing it as a bare auth
    // failure 20 seconds later. Saved profiles keep their keys server-side.
    if (proxyJumps.some((hop) => !hop.profileId)) {
      setError("请选择每台跳板服务器");
      return;
    }
    if (!selectedProfileId && !form.credentialId) {
      for (const secret of [form.privateKey]) {
        const problem = privateKeyProblem(secret);
        if (problem) {
          setError(problem);
          return;
        }
      }
    }
    setBusy(true);
    setError(null);
    sshUiSetError(null);
    setStatus("正在连接服务器，最多需要 20 秒…");
    try {
      const connection = selectedProfileId
        ? await api.profileConnect({ profileId: selectedProfileId, readyTimeout: 15000, retries: 0, reuseExisting: reuseExisting && proxyJumps.length === 0, ...(proxyJumps.length > 0 ? { proxyJumpProfileIds: proxyJumps.map((hop) => hop.profileId) } : {}) })
        : await api.connect({
            host: form.host.trim(),
            port: Number(form.port) || 22,
            username: form.username.trim(),
            ...(form.credentialId
              ? { credentialId: form.credentialId }
              : { auth: form.authKind === "password"
                ? { kind: "password", password: form.password }
                : { kind: "key", privateKey: form.privateKey, ...(form.passphrase ? { passphrase: form.passphrase } : {}) } }),
            name: form.name.trim() || undefined,
            ...(proxyJumps.length > 0 ? { proxyJumpProfileIds: proxyJumps.map((hop) => hop.profileId) } : {})
          });
      // The service returns a live connection, but it is not useful to the
      // panel until it becomes the active record.  Without this, a successful
      // connect looked exactly like "No connections" to the user.
      onConnected?.(connection.connectionId);
      await refreshConnections(api);
      // The panel is a terminal, not merely a connection list: open the PTY
      // immediately so a successful connection is ready to use at once.
      try {
        await api.openSession(connection.connectionId, 100, 30);
        await refreshConnections(api);
      } catch (sessionError) {
        sshUiSetError(`已连接，但无法自动打开终端：${sessionError?.message ?? String(sessionError)}`);
      }
      setStatus(null);
      onClose();
    } catch (err) {
      const message = err?.message ?? String(err);
      setError(message);
      sshUiSetError(message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  /** Save the temporary form as a durable SSH resource, then connect via it. */
  const submitSaveAndConnect = async () => {
    if (!credentials) {
      setError("当前 DSH 未提供凭据服务，不能安全保存 SSH 认证信息");
      return;
    }
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      setError("请填写名称、主机和用户名（名称会用于保存的资源）");
      return;
    }
    if (proxyJumps.some((hop) => !hop.profileId)) {
      setError("请选择每台跳板服务器");
      return;
    }
    if (form.authKind === "key") {
      const problem = privateKeyProblem(form.privateKey);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setBusy(true);
    setError(null);
    sshUiSetError(null);
    setStatus("正在保存并连接…");
    try {
      const saved = await api.profileSave({
        name: form.name.trim(),
        host: form.host.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        authKind: form.authKind,
        hostKeyMode: "accept-new",
        groupId: null,
        proxyJump: proxyJumps.map((hop) => ({ profileId: hop.profileId }))
      });
      const primaryRef = form.authKind === "password" ? saved.credentialRefs.password : saved.credentialRefs.privateKey;
      const secret = form.authKind === "password" ? form.password : form.privateKey;
      if (secret) {
        const response = await credentials.set(primaryRef, secret);
        if (response && !response.ok) throw new Error(response.error?.message ?? "无法保存凭据");
      }
      if (form.authKind === "key" && form.passphrase) {
        const response = await credentials.set(saved.credentialRefs.passphrase, form.passphrase);
        if (response && !response.ok) throw new Error(response.error?.message ?? "无法保存私钥口令");
      }
      // profileSave returns { profile: { profileId, ... }, credentialRefs }.
      const profileId = saved?.profile?.profileId;
      if (!profileId) throw new Error("保存资源后未能取得 profileId");
      const connection = await api.profileConnect({ profileId, readyTimeout: 15000, retries: 0 });
      onConnected?.(connection.connectionId);
      await refreshConnections(api);
      try {
        await api.openSession(connection.connectionId, 100, 30);
        await refreshConnections(api);
      } catch (sessionError) {
        sshUiSetError(`已连接，但无法自动打开终端：${sessionError?.message ?? String(sessionError)}`);
      }
      setStatus(null);
      onClose();
    } catch (cause) {
      const message = cause?.message ?? String(cause);
      setError(message);
      sshUiSetError(message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const importPrivateKey = async (event) => {
    const file = event.target.files?.[0];
    // Reset first so importing the same file again still triggers change.
    event.target.value = "";
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setError("私钥文件不能超过 1 MB");
      return;
    }
    try {
      const privateKey = await file.text();
      if (!privateKey.trim()) throw new Error("所选私钥文件为空");
      setForm((current) => ({ ...current, privateKey }));
      setKeyFileName(file.name);
      setError(null);
    } catch (err) {
      setError(err?.message ?? "无法读取私钥文件");
    }
  };

  const selectProfile = (event) => {
    const id = event.target.value;
    setSelectedProfileId(id);
    setError(null);
  };

  const [batchSelected, setBatchSelected] = useState({});
  const [batchBusy, setBatchBusy] = useState(false);

  const toggleBatch = (profileId) => {
    setBatchSelected((s) => ({ ...s, [profileId]: !s[profileId] }));
  };

  const batchConnect = async () => {
    const ids = Object.keys(batchSelected).filter((id) => batchSelected[id]);
    if (ids.length === 0) return;
    setBatchBusy(true);
    setError(null);
    setStatus(`正在批量连接 ${ids.length} 台服务器…`);
    let ok = 0;
    let fail = 0;
    for (const profileId of ids) {
      try {
        const connection = await api.profileConnect({ profileId, readyTimeout: 15000, retries: 0 });
        onConnected?.(connection.connectionId);
        try {
          await api.openSession(connection.connectionId, 100, 30);
        } catch {}
        ok++;
      } catch {
        fail++;
      }
    }
    await refreshConnections(api);
    setStatus(null);
    setBatchBusy(false);
    setBatchSelected({});
    if (fail === 0) {
      onClose();
    } else {
      setError(`批量连接完成：${ok} 台成功，${fail} 台失败`);
    }
  };

  return (
    <div style={panelStyles.dialogBackdrop} onClick={busy ? undefined : onClose}>
      <div style={panelStyles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={panelStyles.dialogTitle}>连接服务器</div>
        {profiles.length > 0 && (
          <div style={panelStyles.savedProfileRow}>
            <label style={{ ...panelStyles.field, flex: 1 }}>
              <span>已保存的服务器（单选连接）</span>
              <select value={selectedProfileId} onChange={selectProfile} style={panelStyles.input}>
                <option value="">选择一台服务器…</option>
                {profiles.map((profile) => (
                  <option key={profile.profileId} value={profile.profileId}>
                    {profile.name || profile.host} — {profile.username}@{profile.host}:{profile.port}
                  </option>
                ))}
              </select>
            </label>
            {selectedProfileId && (
              <label style={panelStyles.reuseToggle} title="默认各自一条独立通道；勾选后本栏将加入已打开的那条连接，与另一栏共用同一个终端">
                <input type="checkbox" checked={reuseExisting} onChange={(event) => setReuseExisting(event.target.checked)} />
                <span>复用已打开的连接</span>
              </label>
            )}
          </div>
        )}
        {!selectedProfileId && <><div style={panelStyles.temporaryTitle}>临时连接（不会保存）</div><div style={panelStyles.formRow}>
          <label style={panelStyles.field}>
            <span>名称（可选）</span>
            <input value={form.name} onChange={set("name")} placeholder="my-server" style={panelStyles.input} />
          </label>
          <label style={panelStyles.field}>
            <span>主机</span>
            <input value={form.host} onChange={set("host")} placeholder="192.168.1.100" style={panelStyles.input} />
          </label>
        </div><div style={panelStyles.formRow}>
          <label style={panelStyles.field}>
            <span>端口</span>
            <input value={form.port} onChange={set("port")} style={panelStyles.input} />
          </label>
          <label style={panelStyles.field}>
            <span>用户名</span>
            <input value={form.username} onChange={set("username")} style={panelStyles.input} />
          </label>
        </div><div style={panelStyles.formRow}>
          <label style={panelStyles.field}>
            <span>认证方式</span>
            <select value={form.authKind} onChange={(event) => setForm((current) => ({ ...current, authKind: event.target.value, credentialId: "" }))} style={panelStyles.input}>
              <option value="password">密码</option>
              <option value="key">私钥</option>
            </select>
          </label>
          <label style={panelStyles.field}>
            <span>复用共享凭据（可选）</span>
            <select value={form.credentialId} onChange={set("credentialId")} style={panelStyles.input}>
              <option value="">不复用，临时输入{form.authKind === "password" ? "密码" : "私钥"}</option>
              {sharedCredentials.filter((credential) => credential.authKind === form.authKind && credential.credentialConfigured).map((credential) => <option key={credential.credentialId} value={credential.credentialId}>{credential.name}</option>)}
            </select>
          </label>
        </div>
        {!form.credentialId && (form.authKind === "password" ? (
          <label style={panelStyles.field}>
            <span>密码</span>
            <input type="password" value={form.password} onChange={set("password")} style={panelStyles.input} />
          </label>
        ) : (
          <>
            <label style={panelStyles.field}>
              <span>私钥文件（PEM / .key，粘贴或导入）</span>
              <textarea value={form.privateKey} onChange={set("privateKey")} rows={4} style={{ ...panelStyles.input, fontFamily: "monospace" }} />
            </label>
            <div style={panelStyles.keyImportRow}>
              <input
                ref={keyFileInputRef}
                type="file"
                accept=".pem,.key,.rsa,.ed25519,.txt,application/x-pem-file,application/x-pkcs8,text/plain"
                onChange={importPrivateKey}
                style={panelStyles.hiddenFileInput}
              />
              <button type="button" onClick={() => keyFileInputRef.current?.click()} style={panelStyles.btnSecondary}>
                导入 PEM / 私钥文件
              </button>
              <span style={panelStyles.keyImportHint}>{keyFileName ? `已导入：${keyFileName}` : "不会保存到本机"}</span>
            </div>
            <label style={panelStyles.field}>
              <span>私钥口令</span>
              <input type="password" value={form.passphrase} onChange={set("passphrase")} style={panelStyles.input} />
            </label>
          </>
        ))}</>}
        {(
          <div style={panelStyles.proxyJumpSection}>
            <button type="button" onClick={() => setShowProxyJump(!showProxyJump)} style={panelStyles.proxyJumpToggle}>
              {showProxyJump ? "▼" : "▶"} 跳板机（ProxyJump）{selectedProfileId ? " · 留空沿用已保存配置" : ""}
            </button>
            {showProxyJump && (
              <div style={panelStyles.proxyJumpList}>
                {proxyJumps.map((hop, index) => (
                  <div key={index} style={panelStyles.proxyJumpRow}>
                    <select value={hop.profileId} onChange={(e) => updateProxyJump(index, "profileId", e.target.value)} style={panelStyles.input}>
                      <option value="">选择已保存服务器</option>
                      {profiles.map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.name} · {profile.username}@{profile.host}:{profile.port}</option>)}
                    </select>
                    <button type="button" onClick={() => removeProxyJump(index)} style={panelStyles.btnSmall}>✕</button>
                  </div>
                ))}
                <button type="button" onClick={addProxyJump} style={panelStyles.btnSecondary}>＋ 添加跳板</button>
              </div>
            )}
          </div>
        )}
        <div style={panelStyles.sshConfigRow}>
          <button type="button" onClick={importSshConfig} disabled={busy} style={panelStyles.btnSecondary}>
            从 ~/.ssh/config 导入
          </button>
        </div>
        {status && <div style={panelStyles.dialogStatus} role="status" aria-live="polite">{status}</div>}
        {error && <div style={panelStyles.dialogError} role="alert">{error}</div>}
        <div style={panelStyles.dialogActions}>
          <button onClick={onClose} disabled={busy} style={panelStyles.btnSecondary}>取消</button>
          {!selectedProfileId && (
            <button
              onClick={submitSaveAndConnect}
              disabled={busy || !form.host.trim()}
              style={panelStyles.btnSecondary}
              title="保存为 SSH 资源并连接（名称、主机、认证信息存入本机 DSH 凭据库）"
            >
              {busy ? "保存中…" : "保存并连接"}
            </button>
          )}
          <button onClick={submit} disabled={busy || (!selectedProfileId && !form.host.trim())} style={panelStyles.btnPrimary}>
            {busy ? "连接中…" : selectedProfileId ? "连接并打开" : "临时连接"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Mirror the host's connection list and its current binding. The active
 * connection is host state, not a client guess: it is what the agent's
 * connection-less tool calls target, and a page reload must not invent a value
 * for it. The badge reads this field, so it always reports the host's truth.
 */
async function refreshConnections(api) {
  try {
    const { connections, activeConnectionId } = await api.list();
    sshUiSetConnections(connections);
    sshUiSetActiveConnection(activeConnectionId ?? null);
  } catch (error) {
    sshUiSetError(`无法刷新 SSH 连接列表：${error?.message ?? String(error)}`);
  }
}

function PendingConfirmations({ confirmations, busyId, onApprove, onCancel, onCopy, alwaysExpand = false }) {
  const [expandedId, setExpandedId] = useState(null);
  const prevIdsRef = useRef(null);

  // Cards collapse to a one-line command so several can be reviewed without
  // scrolling inside the block. The polling loop replaces the array every
  // second with equal content, so only react when the id list actually
  // changes (mount / new item / handled item): expand the newest command.
  useEffect(() => {
    const ids = confirmations.map((item) => item.confirmationId);
    const previous = prevIdsRef.current;
    prevIdsRef.current = ids;
    if (previous !== null && previous.length === ids.length && ids.every((id, i) => id === previous[i])) return;
    setExpandedId(ids.length > 0 ? ids[ids.length - 1] : null);
  }, [confirmations]);

  if (confirmations.length === 0) {
    return <div style={panelStyles.emptyState}>暂无待确认的危险操作。</div>;
  }
  return (
    <div style={panelStyles.pendingList}>
      {confirmations.map((item) => {
        const expanded = alwaysExpand || item.confirmationId === expandedId;
        return (
          <section key={item.confirmationId} style={panelStyles.pendingCard}>
            <div style={panelStyles.pendingHead}>
              <span style={panelStyles.pendingBadge} aria-hidden="true">⚠</span>
              <button
                type="button"
                style={{ ...panelStyles.pendingToggle, cursor: alwaysExpand ? "default" : "pointer" }}
                title={expanded ? item.command : `${item.command}（点击展开完整信息）`}
                onClick={() => {
                  if (!alwaysExpand) setExpandedId(expanded ? null : item.confirmationId);
                }}
              >
                {item.command}
              </button>
              <span style={panelStyles.pendingHostTag}>{item.name || item.host}</span>
            </div>
            {expanded && (
              <>
                <div style={panelStyles.pendingMeta}>
                  来源：Agent · {new Date(item.createdAt).toLocaleString()}
                </div>
                <div style={panelStyles.pendingReason}>风险：{item.reason}</div>
                <pre style={panelStyles.pendingCommand}>{item.command}</pre>
              </>
            )}
            <div style={panelStyles.pendingActions}>
              {expanded && (
                <button type="button" style={panelStyles.btnSecondary} onClick={() => onCopy(item.command)}>复制命令</button>
              )}
              <button type="button" style={panelStyles.btnDanger} disabled={busyId === item.confirmationId} onClick={() => onApprove(item.confirmationId)}>
                {busyId === item.confirmationId ? "处理中…" : "执行"}
              </button>
              <button type="button" style={panelStyles.btnSecondary} disabled={busyId === item.confirmationId} onClick={() => onCancel(item.confirmationId)}>撤销</button>
            </div>
          </section>
        );
      })}
    </div>
  );
}


function BatchDialog({ api, task, onDone }) {
  const [profiles, setProfiles] = useState([]);
  const [selected, setSelected] = useState({});
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.profileList().then((v) => setProfiles(v.profiles || [])).catch(() => {});
  }, [api]);

  const run = async () => {
    const ids = Object.keys(selected).filter((id) => selected[id]);
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.batchRun(task.batchId, ids);
      setResults(r.results);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  // Escape defers the dialog like the confirmation modal does — but never
  // while a run is in flight, which would drop the results mid-execution.
  useEffect(() => {
    if (busy) return;
    const onKey = (event) => {
      if (event.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onDone]);

  return (
    <div style={panelStyles.dialogBackdrop} onClick={busy ? undefined : onDone}>
      <div style={{ ...panelStyles.dialog, width: 480 }} onClick={(e) => e.stopPropagation()}>
        <div style={panelStyles.dialogTitle}>批量执行</div>
        {task.dangerous && (
          <div style={{ fontSize: 12, color: "#ffb86b", background: "rgba(255,184,107,.12)", border: "1px solid #4a3520", borderRadius: 6, padding: "7px 8px" }}>
            ⚠️ 危险命令：{task.reason}。确认将对勾选的全部服务器执行。
          </div>
        )}
        <pre style={panelStyles.pendingCommand}>{task.command}</pre>
        <div style={panelStyles.batchTitle}>目标服务器（每次手动勾选）</div>
        <div style={panelStyles.batchList}>
          {profiles.map((p) => (
            <label key={p.profileId} style={panelStyles.batchItem}>
              <input type="checkbox" checked={!!selected[p.profileId]}
                onChange={() => setSelected((s) => ({ ...s, [p.profileId]: !s[p.profileId] }))} />
              <span>{p.name || p.host} — {p.username}@{p.host}:{p.port}</span>
            </label>
          ))}
        </div>
        {error && <div style={panelStyles.dialogError}>{error}</div>}
        {results && (
          <div style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
            {results.map((r, i) => (
              <div key={i} style={{ padding: "6px 8px", background: "#101418", borderRadius: 6, border: `1px solid ${r.ok ? "#3fb950" : "#f85149"}` }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: r.ok ? "#3fb950" : "#f85149" }}>{r.name || r.host}</div>
                <pre style={{ fontSize: 11, color: "#d7dbe2", margin: "4px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{r.error || r.stdout || "(无输出)"}</pre>
              </div>
            ))}
          </div>
        )}
        <div style={panelStyles.dialogActions}>
          <button type="button" style={panelStyles.btnSecondary} disabled={busy} onClick={() => { api.batchCancel(task.batchId).catch(() => {}); onDone(); }}>取消</button>
          <button
            type="button"
            style={panelStyles.btnPrimary}
            // The task is consumed by the first run; results === null guards
            // against a second click that could only ever error out.
            disabled={busy || results !== null || !Object.values(selected).some(Boolean)}
            onClick={run}
          >
            {busy ? "执行中…" : `执行（${Object.values(selected).filter(Boolean).length} 台）`}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SshPanel({ api, credentials, locale, viewId = DRAWER_VIEW_ID, viewSignal }) {
  const ui = useSshUi();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tab, setTab] = useState("terminal");
  const [batchTask, setBatchTask] = useState(null);
  const [pendingBatchCount, setPendingBatchCount] = useState(0);
  // Batch ids already surfaced this panel session. Dismissing the dialog (e.g.
  // clicking the backdrop) must not re-pop it on the next poll tick; only a
  // brand-new task auto-opens. Handled tasks are gone from the server, and the
  // leftover count stays visible in the inline notice for manual re-open.
  const seenBatchIdsRef = useRef(new Set());
  const [pendingConfirmations, setPendingConfirmations] = useState([]);
  const [pendingBusy, setPendingBusy] = useState(null);
  const [pendingModalOpen, setPendingModalOpen] = useState(false);
  const [commandSnippets, setCommandSnippets] = useState(loadCommandSnippets);
  const [profiles, setProfiles] = useState([]);
  const [groups, setGroups] = useState([]);
  const [snippetQuery, setSnippetQuery] = useState("");
  const [snippetEditorOpen, setSnippetEditorOpen] = useState(false);
  const [snippetForm, setSnippetForm] = useState({ name: "", command: "", scope: "global", scopeId: "" });
  // Confirmation ids this panel session has already surfaced. Only a brand-new
  // id re-opens the interruptive popup, so deferring one is not undone by the
  // next poll tick.
  const seenPendingIdsRef = useRef(null);
  /** Whether this mount already offered to adopt the live host connections. */
  const adoptedRef = useRef(false);
  const snippetSearchRef = useRef(null);
  const t = zhDict;

  // The workspace runs its data loops for exactly as long as it is mounted:
  // the host (drawer open, or the SSH tab being the Sidebar's active tab in an
  // expanded panel) decides visibility, and unmounting never touches the
  // host-side connections. Style injection rides the first effect too, so the
  // empty-state add button is styled before any terminal exists.
  useEffect(() => {
    ensureStyles();
    refreshConnections(api);
    const timer = setInterval(() => refreshConnections(api), 5000);
    return () => clearInterval(timer);
  }, [api]);

  useEffect(() => {
    const sync = () => setCommandSnippets(loadCommandSnippets());
    window.addEventListener("dsh-ssh-ops-command-snippets", sync);
    return () => window.removeEventListener("dsh-ssh-ops-command-snippets", sync);
  }, []);

  useEffect(() => {
    Promise.all([api.profileList(), api.groupList()]).then(([profileValue, groupValue]) => {
      setProfiles(profileValue.profiles ?? []);
      setGroups(groupValue.groups ?? []);
    }).catch(() => {});
  }, [api]);

  const refreshPendingConfirmations = async () => {
    try {
      const { confirmations } = await api.pendingConfirmationList();
      setPendingConfirmations(confirmations);
      // Dangerous commands must come to the operator, not wait to be found:
      // anything never shown before pops the confirmation modal. On remount
      // (panel reopened) items still unhandled also pop up again.
      const seen = seenPendingIdsRef.current;
      if (seen === null) {
        seenPendingIdsRef.current = new Set(confirmations.map((c) => c.confirmationId));
        if (confirmations.length > 0) setPendingModalOpen(true);
      } else if (confirmations.some((c) => !seen.has(c.confirmationId))) {
        for (const c of confirmations) seen.add(c.confirmationId);
        setPendingModalOpen(true);
      }
    } catch (error) {
      sshUiSetError(`无法刷新待确认队列：${error?.message ?? String(error)}`);
    }
  };

  useEffect(() => {
    refreshPendingConfirmations();
    const timer = setInterval(refreshPendingConfirmations, 1000);
    return () => clearInterval(timer);
  }, [api]);

  const refreshBatchTasks = async () => {
    try {
      const { tasks } = await api.batchTaskList();
      setPendingBatchCount(tasks.length);
      if (tasks.length > 0) {
        const unseen = tasks.find((t) => !seenBatchIdsRef.current.has(t.batchId));
        if (unseen) {
          seenBatchIdsRef.current.add(unseen.batchId);
          setBatchTask((current) => current ?? unseen);
        }
      }
    } catch {}
  };

  const openBatchTask = async () => {
    try {
      const { tasks } = await api.batchTaskList();
      if (tasks.length > 0) {
        seenBatchIdsRef.current.add(tasks[0].batchId);
        setBatchTask(tasks[0]);
      }
    } catch {}
  };

  useEffect(() => {
    refreshBatchTasks();
    const timer = setInterval(refreshBatchTasks, 1000);
    return () => clearInterval(timer);
  }, [api]);


  // Every queued command handled → no reason to keep the popup up.
  useEffect(() => {
    if (pendingModalOpen && pendingConfirmations.length === 0) setPendingModalOpen(false);
  }, [pendingModalOpen, pendingConfirmations]);

  useEffect(() => {
    if (!pendingModalOpen) return;
    const onKey = (event) => {
      if (event.key === "Escape") setPendingModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingModalOpen]);

  // Split panes are sibling trees over one connection list, and the dock kit
  // remounts this body when the layout root turns into a split. Which servers
  // this pane shows therefore lives in the shared pane store, keyed by the
  // host's tab id, so a split carries the pane's servers across the remount.
  const view = useSyncExternalStore(subscribePaneSessions, () => viewSession(viewId));
  const paneConnections = ui.connections.filter((connection) => view.connectionIds.includes(connection.connectionId));
  const resolvedActiveConnectionId = resolvePaneActiveConnection(paneConnections, view.activeConnectionId);
  const active = paneConnections.find((c) => c.connectionId === resolvedActiveConnectionId);

  useEffect(() => {
    reconcileViews(ui.connections);
  }, [ui.connections]);

  // Host-side sessions outlive a page reload; without adopting them into the
  // first pane to mount they would be invisible zombies no pane can disconnect.
  // One attempt per mount only: re-adopting on every poll would hand back a
  // server the operator just closed, which is the one thing a close must not do.
  useEffect(() => {
    if (adoptedRef.current || ui.connections.length === 0) return;
    adoptedRef.current = true;
    adoptIntoView(viewId, ui.connections);
  }, [ui.connections, viewId]);

  // A surface that owns no pane (the resources page) queues what it connected.
  // The first pane to render claims it, so an operator-initiated connect lands
  // in exactly one pane — not none, and not mirrored into every pane. This
  // subscribes to the queue's revision rather than the view snapshot, which is
  // identity-stable and would not re-render for a queue-only change.
  const paneOpenRequests = useSyncExternalStore(subscribePaneSessions, paneOpenRequestsRevision);
  useEffect(() => {
    for (const connectionId of claimPendingOpens()) openInView(viewId, connectionId);
  }, [paneOpenRequests, viewId]);

  // The host aborts this signal when the tab record disappears (or the plugin
  // unloads). Release the view's references so another pane's later close is
  // still recognized as the last one — closing a view never disconnects.
  useEffect(() => {
    if (viewSignal === undefined) return;
    const onAbort = () => forgetView(viewId);
    viewSignal.addEventListener("abort", onAbort);
    return () => viewSignal.removeEventListener("abort", onAbort);
  }, [viewSignal, viewId]);

  const openConnectionInPane = (connectionId) => {
    openInView(viewId, connectionId);
  };

  /**
   * Hand the agent this pane's connection. Panes are independent, so the agent
   * needs one answer to "which server am I working on"; the operator's click is
   * that answer. Clicking the already-bound pane is a no-op rather than a fresh
   * round trip.
   *
   * The report comes back from the host, not from a local guess: writing the
   * badge optimistically made a failed switch look applied for one poll tick and
   * then flip back, which reads as the agent wandering off on its own.
   */
  const bindAgent = (connectionId) => {
    if (connectionId === null || connectionId === ui.activeConnectionId) return;
    api.selectConnection(connectionId)
      .then(() => refreshConnections(api))
      .catch((error) => {
        const message = error?.message ?? String(error);
        // A missing route means the running host half predates this build:
        // client code reloads with the page, host code only with a restart.
        // Say so instead of leaving a bare transport error to decode.
        sshUiSetError(/404|not mounted|not-mounted/i.test(message)
          ? "切换 Agent 目标失败：宿主端仍是旧版本（没有 selectConnection 接口），重启 dsh web / DSH.app 后即可生效"
          : `切换 Agent 目标失败：${message}`);
      });
  };
  const visibleCommandSnippets = searchCommandSnippets(
    matchingCommandSnippets(availableCommandSnippets(commandSnippets), active, profiles),
    snippetQuery
  );

  useEffect(() => {
    if (tab !== "snippets") return;
    const frame = requestAnimationFrame(() => snippetSearchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [tab]);

  const openSession = async () => {
    if (!active) return;
    sshUiSetBusy(true);
    sshUiSetError(null);
    try {
      await api.openSession(active.connectionId, 100, 30);
      await refreshConnections(api);
    } catch (err) {
      sshUiSetError(err?.message ?? String(err));
    } finally {
      sshUiSetBusy(false);
    }
  };

  const fillSnippet = async (command) => {
    const sessionId = active?.sessions?.[0];
    if (!command || !sessionId) return sshUiSetError("请先打开当前服务器的终端，再填入快捷命令");
    try {
      await api.write(sessionId, command);
      setSnippetQuery("");
      setTab("terminal");
    } catch (error) {
      sshUiSetError(`填入快捷命令失败：${error?.message ?? String(error)}`);
    }
  };

  // The host verifies a single idle POSIX shell and an empty input line.
  // Never append a command to an operator draft or a foreground program.
  const cdFromFiles = async (dir) => {
    const sessionId = active?.sessions?.[0];
    if (!sessionId || !dir) return sshUiSetError("请先打开当前服务器的终端，再使用 cd");
    try {
      await api.changeDirectory(sessionId, dir);
      setTab("terminal");
    } catch (error) {
      sshUiSetError(`cd 失败：${error?.message ?? String(error)}`);
    }
  };

  const saveSnippet = () => {
    const name = snippetForm.name.trim();
    const command = snippetForm.command.trim();
    if (!name || !command) return sshUiSetError("请填写快捷命令的名称和命令内容");
    if (snippetForm.scope !== "global" && !snippetForm.scopeId) return sshUiSetError("请选择命令适用的分组或服务器");
    const next = [...commandSnippets, {
      id: crypto.randomUUID(), name, command, scope: snippetForm.scope,
      scopeId: snippetForm.scope === "global" ? null : snippetForm.scopeId
    }];
    saveCommandSnippets(next);
    setCommandSnippets(next);
    setSnippetForm({ name: "", command: "", scope: "global", scopeId: "" });
    setSnippetEditorOpen(false);
    sshUiSetError(null);
  };

  const removeSnippet = (item) => {
    if (!window.confirm(`删除自定义快捷命令“${item.name}”？`)) return;
    const next = commandSnippets.filter((entry) => entry.id !== item.id);
    saveCommandSnippets(next);
    setCommandSnippets(next);
  };

  /**
   * Hide one server tab from this pane. The host session is disconnected only
   * when no pane shows it any more, so a server open in both panes survives
   * closing it in one of them.
   */
  const closePaneTab = async (connectionId) => {
    if (!closeInView(viewId, connectionId)) return;
    try {
      await api.disconnect(connectionId);
      await refreshConnections(api);
    } catch (error) {
      // The server-side session remains alive when disconnect fails, so put the
      // local tab back rather than pretending it was released.
      openInView(viewId, connectionId);
      sshUiSetError(`断开服务器失败：${error?.message ?? String(error)}`);
    }
  };

  const actOnPending = async (confirmationId, action) => {
    setPendingBusy(confirmationId);
    sshUiSetError(null);
    try {
      if (action === "approve") await api.pendingConfirmationApprove(confirmationId);
      else await api.pendingConfirmationCancel(confirmationId);
    } catch (error) {
      sshUiSetError(error?.message ?? String(error));
    } finally {
      await refreshPendingConfirmations();
      setPendingBusy(null);
    }
  };

  const copyPendingCommand = async (command) => {
    try {
      await navigator.clipboard.writeText(command);
    } catch (error) {
      sshUiSetError(`复制命令失败：${error?.message ?? String(error)}`);
    }
  };

  return (
    <div style={panelStyles.workspace}>
      <div style={panelStyles.serverTabs}>
        {paneConnections.map((conn) => {
          const isActive = conn.connectionId === resolvedActiveConnectionId;
          const isAgentTarget = conn.connectionId === ui.activeConnectionId;
          return (
            <div key={conn.connectionId} style={{ ...panelStyles.serverTab, ...(isActive ? panelStyles.serverTabActive : {}), ...(isAgentTarget ? panelStyles.serverTabAgent : {}) }}>
              <button
                type="button"
                style={panelStyles.serverTabLabel}
                onClick={() => {
                  selectInView(viewId, conn.connectionId);
                  bindAgent(conn.connectionId);
                }}
                title={`${conn.username}@${conn.host}:${conn.port}${isAgentTarget ? "（Agent 正在使用此连接）" : ""}`}
              >
                {conn.name || `${conn.username}@${conn.host}`}
              </button>
              {isAgentTarget && (
                <span
                  style={panelStyles.agentBadge}
                  data-dsh-ssh-ops-agent-target="true"
                  role="img"
                  title="Agent 的 ssh_exec / sftp_* / tunnel_* 默认作用于此连接；点击其他栏可切换"
                  aria-label="Agent 正在使用此连接"
                >
                  <IconRobot16 size={15} />
                </span>
              )}
              <button
                type="button"
                style={panelStyles.serverTabClose}
                onClick={() => closePaneTab(conn.connectionId)}
                title="关闭此栏标签（两栏都关闭后断开服务器）"
                aria-label={`关闭此栏的 ${conn.name || conn.host} 标签`}
              >
                ×
              </button>
            </div>
          );
        })}
        {paneConnections.length === 0 && <span style={panelStyles.connEmpty}>{t.empty}</span>}
        <button
          type="button"
          className="dsh-ssh-ops-add-btn"
          style={paneConnections.length === 0 ? panelStyles.serverTabAddLabeled : panelStyles.serverTabAdd}
          onClick={() => setDialogOpen(true)}
          title={t.connect}
          aria-label="连接新服务器"
        >
          {paneConnections.length === 0 ? `＋ ${t.connect}` : "＋"}
        </button>
      </div>

      {ui.error && <div style={panelStyles.error}>{ui.error}</div>}

      <div style={panelStyles.tabs}>
        {[
          ["terminal", t.tabTerminal],
          ["files", t.tabFiles],
          ["tunnels", t.tabTunnels],
          ["snippets", "快捷命令"]
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => {
              if (key === "snippets" && tab === "snippets") {
                setSnippetQuery("");
                setTab("terminal");
              } else setTab(key);
            }}
            disabled={!active && key !== "terminal" && key !== "snippets"}
            style={{
              ...panelStyles.tab,
              ...(tab === key ? panelStyles.tabActive : {})
            }}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => setTab("database")}
          style={{
            ...panelStyles.tab,
            ...(tab === "database" ? panelStyles.tabActive : {})
          }}
          title="数据库连接与查询"
        >
          {t.tabDatabase}
        </button>
        <button
          onClick={() => setTab("logs")}
          style={{
            ...panelStyles.tab,
            ...(tab === "logs" ? panelStyles.tabActive : {})
          }}
          title="已录制的会话日志（可搜索、下载）"
        >
          日志
        </button>
      </div>

      {!batchTask && pendingBatchCount > 0 && (
        <div style={panelStyles.batchNotice} onClick={openBatchTask}>
          ⚡ {pendingBatchCount} 个批量任务待处理，点击打开
        </div>
      )}

      <div style={panelStyles.body}>
        <TabErrorBoundary key="terminal">
          <div style={{ ...panelStyles.tabPane, display: tab === "terminal" ? "flex" : "none" }}>
            {pendingConfirmations.length > 0 && !pendingModalOpen && (
              <div style={panelStyles.pendingInline}>
                <div style={panelStyles.pendingInlineTitle}>待确认操作（在此执行或撤销）</div>
                <PendingConfirmations
                  confirmations={pendingConfirmations}
                  busyId={pendingBusy}
                  onApprove={(id) => actOnPending(id, "approve")}
                  onCancel={(id) => actOnPending(id, "cancel")}
                  onCopy={copyPendingCommand}
                />
              </div>
            )}
            {paneConnections.length > 0 ? (
              paneConnections.map((conn) => {
                const sessionId = conn.sessions?.[0] ?? null;
                const isActive = conn.connectionId === resolvedActiveConnectionId;
                return (
                  <div
                    key={conn.connectionId}
                    style={{ ...panelStyles.terminalPaneWrap, display: isActive ? "flex" : "none" }}
                    // Clicking into a pane is the operator saying "work here":
                    // a text-selection click hits this too, which is why
                    // bindAgent is idempotent for the already-bound pane.
                    onMouseDown={() => bindAgent(conn.connectionId)}
                  >
                    {sessionId ? (
                      <XtermView api={api} sessionId={sessionId} connectionId={conn.connectionId} />
                    ) : (
                      <div style={panelStyles.emptyState}>
                        {t.sessionClosed}
                        {isActive && (
                          <button onClick={openSession} disabled={ui.busy} style={{ ...panelStyles.btnTiny, marginTop: 8 }}>
                            {ui.busy ? t.busy : t.openSession}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div style={panelStyles.emptyState}>{t.noConnection}</div>
            )}
          </div>
        </TabErrorBoundary>
        {active && (
          <>
            <TabErrorBoundary key="files">
              <div style={{ ...panelStyles.tabPane, display: tab === "files" ? "flex" : "none" }}>
                <SshFiles
                  api={api}
                  connectionId={active.connectionId}
                  onCd={cdFromFiles}
                  initialPath={ui.projectTarget?.connectionId === active.connectionId ? ui.projectTarget.path : "/"}
                />
              </div>
            </TabErrorBoundary>
            <TabErrorBoundary key="tunnels">
              <div style={{ ...panelStyles.tabPane, display: tab === "tunnels" ? "flex" : "none" }}>
                <SshTunnels api={api} connectionId={active.connectionId} />
              </div>
            </TabErrorBoundary>
          </>
        )}
        <TabErrorBoundary key="database">
          <div style={{ ...panelStyles.tabPane, display: tab === "database" ? "flex" : "none" }}>
            <SshDatabase api={api} />
          </div>
        </TabErrorBoundary>
        <TabErrorBoundary key="logs">
          <div style={{ ...panelStyles.tabPane, display: tab === "logs" ? "flex" : "none" }}>
            <SshLogs api={api} />
          </div>
        </TabErrorBoundary>
        <TabErrorBoundary key="snippets">
          <div style={{ ...panelStyles.tabPane, display: tab === "snippets" ? "flex" : "none" }}>
            <div style={panelStyles.snippetPage}>
              <div style={panelStyles.snippetPageHeading}>快捷命令</div>
              <div style={panelStyles.snippetToolbar}>
                <div style={panelStyles.snippetHint}>点击仅填入终端输入行，按 Enter 后才执行。</div>
                <button type="button" onClick={() => setSnippetEditorOpen((open) => !open)} style={panelStyles.snippetAdd}>{snippetEditorOpen ? "收起" : "＋ 自定义"}</button>
              </div>
              {snippetEditorOpen && <div style={panelStyles.snippetEditor}>
                <input value={snippetForm.name} onChange={(event) => setSnippetForm({ ...snippetForm, name: event.target.value })} placeholder="名称" style={panelStyles.snippetEditorName} />
                <input value={snippetForm.command} onChange={(event) => setSnippetForm({ ...snippetForm, command: event.target.value })} placeholder="命令，例如：systemctl status nginx" style={panelStyles.snippetEditorCommand} />
                <select value={snippetForm.scope} onChange={(event) => setSnippetForm({ ...snippetForm, scope: event.target.value, scopeId: "" })} style={panelStyles.snippetEditorScope}>
                  <option value="global">所有服务器</option><option value="group">指定分组</option><option value="profile">指定服务器</option>
                </select>
                {snippetForm.scope === "group" && <select value={snippetForm.scopeId} onChange={(event) => setSnippetForm({ ...snippetForm, scopeId: event.target.value })} style={panelStyles.snippetEditorScope}><option value="">选择分组</option>{groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}</select>}
                {snippetForm.scope === "profile" && <select value={snippetForm.scopeId} onChange={(event) => setSnippetForm({ ...snippetForm, scopeId: event.target.value })} style={panelStyles.snippetEditorScope}><option value="">选择服务器</option>{profiles.map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.name || profile.host}</option>)}</select>}
                <button type="button" onClick={saveSnippet} style={panelStyles.snippetSave}>保存</button>
              </div>}
              <input
                ref={snippetSearchRef}
                value={snippetQuery}
                onChange={(event) => setSnippetQuery(event.target.value)}
                placeholder="搜索名称或命令，例如：nginx、日志、docker…"
                style={panelStyles.snippetSearch}
              />
              {!active && <div style={panelStyles.snippetEmpty}>请先连接服务器；你仍可浏览和搜索内置命令。</div>}
              <div style={panelStyles.snippetList}>
                {visibleCommandSnippets.map((item) => (
                  <div key={item.id} style={panelStyles.snippetCard}>
                    <button type="button" onClick={() => fillSnippet(item.command)} disabled={!active} style={panelStyles.snippetCardMain}>
                      <strong>{item.name}{!item.builtIn && <small style={panelStyles.snippetCustomBadge}>自定义</small>}</strong><code>{item.command}</code>
                    </button>
                    {!item.builtIn && <button type="button" onClick={() => removeSnippet(item)} title={`删除 ${item.name}`} aria-label={`删除 ${item.name}`} style={panelStyles.snippetDelete}>×</button>}
                  </div>
                ))}
                {visibleCommandSnippets.length === 0 && (
                  <div style={panelStyles.snippetEmpty}>没有匹配的快捷命令。点击右上角“＋ 自定义”即可添加。</div>
                )}
              </div>
            </div>
          </div>
        </TabErrorBoundary>
      </div>

      {pendingModalOpen && pendingConfirmations.length > 0 && (
        <div
          style={panelStyles.pendingModalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="危险操作确认"
          onClick={() => setPendingModalOpen(false)}
        >
          <div style={panelStyles.pendingModal} onClick={(e) => e.stopPropagation()}>
            <div style={panelStyles.pendingModalTitle}>⚠️ 检测到危险命令等待确认</div>
            <div style={panelStyles.pendingModalHint}>
              以下命令由 Agent 发起且尚未执行，只有点击「执行」才会发送到服务器。
            </div>
            <PendingConfirmations
              confirmations={pendingConfirmations}
              busyId={pendingBusy}
              onApprove={(id) => actOnPending(id, "approve")}
              onCancel={(id) => actOnPending(id, "cancel")}
              onCopy={copyPendingCommand}
              alwaysExpand
            />
            <div style={panelStyles.dialogActions}>
              <button type="button" style={panelStyles.btnSecondary} onClick={() => setPendingModalOpen(false)}>
                稍后在面板中处理
              </button>
            </div>
          </div>
        </div>
      )}

      {dialogOpen && <ConnectDialog api={api} credentials={credentials} onConnected={openConnectionInPane} onClose={() => setDialogOpen(false)} />}

      {batchTask && <BatchDialog api={api} task={batchTask} onDone={() => setBatchTask(null)} />}
    </div>
  );
}

const zhDict = {
  panelTitle: "SSH 终端",
  connect: "连接服务器",
  openSession: "打开终端",
  empty: "还没有连接。",
  sessionClosed: "会话已关闭",
  noConnection: "未连接",
  busy: "忙…",
  tabTerminal: "终端",
  tabFiles: "文件",
  tabTunnels: "转发",
  tabDatabase: "数据库"
};

const enDict = {
  panelTitle: "SSH Terminal",
  connect: "Connect",
  openSession: "Open",
  empty: "No connections yet.",
  sessionClosed: "Session closed",
  noConnection: "Not connected",
  busy: "Busy…",
  tabTerminal: "Terminal",
  tabFiles: "Files",
  tabTunnels: "Tunnels",
  tabDatabase: "Database"
};

const panelStyles = {
  /** The workspace fill: works inside the fixed drawer (flex child) and inside
   * the official Sidebar's tab body (block parent with a definite height). */
  workspace: {
    boxSizing: "border-box",
    flex: "1 1 auto",
    height: "100%",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "var(--dsh-ssh-ops-bg, #101418)",
    fontFamily: "var(--dsw-font-family, system-ui, sans-serif)",
    color: "var(--dsh-ssh-ops-text, #d7dbe2)"
  },
  btnSmall: {
    background: "transparent",
    border: "1px solid var(--dsh-ssh-ops-border, #3a414b)",
    color: "var(--dsh-ssh-ops-text, #d7dbe2)",
    borderRadius: 6,
    width: 26,
    height: 26,
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1
  },
  btnTiny: {
    background: "transparent",
    border: "1px solid #3a414b",
    color: "#d7dbe2",
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 12,
    cursor: "pointer"
  },
  serverTabs: {
    display: "flex",
    gap: 2,
    padding: "6px 8px 0",
    borderBottom: "1px solid var(--dsh-ssh-ops-border, #1f242c)",
    flex: "none",
    alignItems: "center",
    flexWrap: "wrap",
    maxHeight: 120,
    overflowY: "auto"
  },
  serverTab: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    border: "1px solid var(--dsh-ssh-ops-border, #3a414b)",
    borderBottom: "none",
    borderRadius: "6px 6px 0 0",
    background: "var(--dsh-ssh-ops-tab, #1a1f26)",
    color: "var(--dsh-ssh-ops-muted, #8b93a1)",
    overflow: "hidden",
    flex: "none",
    maxWidth: 190
  },
  serverTabActive: {
    background: "var(--dsh-ssh-ops-bg, #101418)",
    color: "var(--dsh-ssh-ops-text, #d7dbe2)",
    borderBottom: "2px solid #2d6cdf"
  },
  /**
   * The connection the agent's connection-less tool calls resolve to.
   *
   * RoyalBlue3, picked by the operator. It sits close to the active-tab
   * underline (#2d6cdf), so the tab outline is only half the signal — the solid
   * chip with the robot glyph is what actually separates "the agent is here"
   * from "this tab is selected".
   *
   * Solid fill with white ink: royal blue is dark enough for a white glyph
   * (~5.8:1), and a chip that carries its own fill reads the same on both
   * Sidebar themes.
   */
  serverTabAgent: {
    borderColor: "#3a5fcd",
    boxShadow: "inset 0 0 0 1px rgba(58, 95, 205, .9)"
  },
  agentBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    marginRight: 2,
    padding: "2px 4px",
    borderRadius: 999,
    background: "#3a5fcd",
    border: "1px solid #3a5fcd",
    color: "#ffffff",
    cursor: "default"
  },
  serverTabLabel: {
    background: "transparent",
    border: "none",
    color: "inherit",
    fontSize: 12,
    padding: "6px 8px",
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
    minWidth: 0,
    textAlign: "left"
  },
  serverTabClose: {
    background: "transparent",
    border: "none",
    color: "inherit",
    fontSize: 14,
    lineHeight: 1,
    padding: "0 7px 0 2px",
    cursor: "pointer",
    opacity: 0.8
  },
  // Add-server button. Colors/border/hover live in the injected
  // .dsh-ssh-ops-add-btn class; these inline styles carry only geometry.
  serverTabAdd: {
    width: 24,
    height: 24,
    fontSize: 14,
    flex: "none"
  },
  serverTabAddLabeled: {
    height: 24,
    padding: "0 10px",
    fontSize: 12,
    flex: "none"
  },
  snippetPage: { display: "flex", flex: 1, minHeight: 0, flexDirection: "column", gap: 10, padding: 8, overflow: "hidden" },
  snippetPageHeading: { fontSize: 14, fontWeight: 650 },
  snippetToolbar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  snippetHint: { fontSize: 12, color: "#8b93a1" },
  snippetAdd: { padding: "4px 7px", background: "transparent", color: "#b9c7e8", border: "1px solid #3a414b", borderRadius: 5, fontSize: 12, cursor: "pointer", flex: "none" },
  snippetEditor: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: 7, background: "#161b21", border: "1px solid #2d3540", borderRadius: 7 },
  snippetEditorName: { width: 100, minWidth: 0, padding: "6px 7px", background: "#101418", color: "#d7dbe2", border: "1px solid #3a414b", borderRadius: 5, fontSize: 12 },
  snippetEditorCommand: { flex: "1 1 180px", minWidth: 0, padding: "6px 7px", background: "#101418", color: "#d7dbe2", border: "1px solid #3a414b", borderRadius: 5, fontSize: 12 },
  snippetEditorScope: { maxWidth: 130, minWidth: 0, padding: "6px", background: "#101418", color: "#d7dbe2", border: "1px solid #3a414b", borderRadius: 5, fontSize: 12 },
  snippetSave: { padding: "6px 8px", background: "#2d6cdf", color: "#fff", border: 0, borderRadius: 5, fontSize: 12, cursor: "pointer" },
  snippetSearch: { width: "100%", boxSizing: "border-box", padding: "8px 9px", background: "#101418", color: "#d7dbe2", border: "1px solid #3a414b", borderRadius: 6, fontSize: 13 },
  snippetList: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8, overflowY: "auto", paddingRight: 2 },
  snippetCard: { display: "flex", minWidth: 0, background: "#161b21", color: "#d7dbe2", border: "1px solid #2d3540", borderRadius: 7, fontSize: 12 },
  snippetCardMain: { display: "flex", flex: 1, minWidth: 0, flexDirection: "column", gap: 5, padding: "9px 10px", background: "transparent", color: "#d7dbe2", border: 0, textAlign: "left", cursor: "pointer", fontSize: 12 },
  snippetCustomBadge: { marginLeft: 6, color: "#8b93a1", fontWeight: 400 },
  snippetDelete: { alignSelf: "flex-start", padding: "6px 8px", background: "transparent", color: "#8b93a1", border: 0, fontSize: 16, cursor: "pointer" },
  snippetEmpty: { padding: 12, color: "#8b93a1", fontSize: 12, textAlign: "center" },
  connEmpty: { fontSize: 12, color: "#8b93a1", flex: "none", alignSelf: "center" },
  error: {
    padding: "6px 12px",
    fontSize: 12,
    color: "#f85149",
    background: "rgba(248,81,73,.1)",
    borderBottom: "1px solid rgba(248,81,73,.3)",
    flex: "none"
  },
  body: { flex: 1, minHeight: 0, padding: 8, display: "flex", flexDirection: "column" },
  tabPane: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  terminalPaneWrap: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  tabs: {
    display: "flex", gap: 4, padding: "0 8px", borderBottom: "1px solid var(--dsh-ssh-ops-border, #1f242c)",
    flex: "none", alignItems: "center"
  },
  tab: {
    background: "transparent", border: "none", color: "var(--dsh-ssh-ops-muted, #8b93a1)",
    padding: "6px 12px", fontSize: 12, cursor: "pointer",
    borderBottom: "2px solid transparent"
  },
  tabActive: { color: "var(--dsh-ssh-ops-text, #d7dbe2)", borderBottomColor: "#2d6cdf" },
  emptyState: { margin: "auto", fontSize: 12, color: "var(--dsh-ssh-ops-muted, #8b93a1)", textAlign: "center" },
  xtermWrap: { flex: 1, minWidth: 0, overflow: "hidden" },
  xtermHost: { position: "relative", display: "flex", flex: 1, minWidth: 0, minHeight: 0 },
  searchOpenBtn: {
    position: "absolute", top: 6, right: 10, zIndex: 5, display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 22, height: 22, padding: 0, borderRadius: 4, cursor: "pointer",
    background: "var(--dsh-ssh-ops-surface, #161b21)", border: "1px solid var(--dsh-ssh-ops-border, #3a414b)",
    color: "var(--dsh-ssh-ops-muted, #8b93a1)"
  },
  searchBar: {
    position: "absolute", top: 6, right: 10, zIndex: 5, display: "flex", alignItems: "center", gap: 4,
    padding: "3px 6px", borderRadius: 6,
    background: "var(--dsh-ssh-ops-surface, #161b21)", border: "1px solid var(--dsh-ssh-ops-border, #3a414b)"
  },
  searchInput: {
    width: 150, background: "var(--dsh-ssh-ops-input, #101418)", border: "1px solid var(--dsh-ssh-ops-border, #3a414b)",
    borderRadius: 4, color: "var(--dsh-ssh-ops-text, #d7dbe2)", padding: "2px 6px", fontSize: 12, outline: "none"
  },
  searchCount: { fontSize: 11, color: "var(--dsh-ssh-ops-muted, #8b93a1)", minWidth: 34, textAlign: "center" },
  searchBtn: {
    background: "transparent", border: "none", color: "var(--dsh-ssh-ops-muted, #8b93a1)",
    cursor: "pointer", fontSize: 13, padding: "0 3px", lineHeight: 1.2
  },
  dialogBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.5)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  },
  dialog: {
    width: 360,
    maxWidth: "90vw",
    background: "var(--dsh-ssh-ops-surface, #181c22)",
    border: "1px solid var(--dsh-ssh-ops-border, #2a303a)",
    borderRadius: 12,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    boxShadow: "0 12px 40px rgba(0,0,0,.5)"
  },
  dialogTitle: { fontSize: 14, fontWeight: 600, marginBottom: 2 },
  temporaryTitle: { fontSize: 12, color: "var(--dsh-ssh-ops-muted, #9aa3af)", marginTop: 2 },
  field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--dsh-ssh-ops-muted, #9aa3af)", minWidth: 0 },
  formRow: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 },
  savedProfileRow: { display: "flex", alignItems: "flex-end", flexWrap: "wrap", gap: 8 },
  reuseToggle: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    paddingBottom: 7,
    fontSize: 12,
    color: "var(--dsh-ssh-ops-muted, #9aa3af)",
    cursor: "pointer",
    whiteSpace: "nowrap"
  },
  input: {
    background: "var(--dsh-ssh-ops-input, #101418)",
    border: "1px solid var(--dsh-ssh-ops-border, #2a303a)",
    borderRadius: 6,
    color: "var(--dsh-ssh-ops-text, #d7dbe2)",
    padding: "6px 8px",
    fontSize: 13,
    outline: "none"
  },
  dialogError: { fontSize: 12, color: "#f85149" },
  dialogStatus: {
    fontSize: 12,
    color: "#9cc8ff",
    background: "rgba(45,108,223,.12)",
    border: "1px solid rgba(45,108,223,.3)",
    borderRadius: 6,
    padding: "7px 8px"
  },
  keyImportRow: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  proxyJumpSection: { display: "flex", flexDirection: "column", gap: 6 },
  proxyJumpToggle: { background: "transparent", border: "none", color: "var(--dsh-ssh-ops-muted, #9aa3af)", fontSize: 12, cursor: "pointer", textAlign: "left", padding: 0 },
  proxyJumpList: { display: "flex", flexDirection: "column", gap: 4, padding: "6px 0" },
  proxyJumpRow: { display: "flex", gap: 4 },
  sshConfigRow: { flex: "none" },
  batchSection: { display: "flex", flexDirection: "column", gap: 6, padding: "8px 0", borderTop: "1px solid #262b33" },
  batchTitle: { fontSize: 12, color: "#9aa3af" },
  batchNotice: { padding: "6px 10px", fontSize: 12, color: "#ffb86b", background: "rgba(255,184,107,.1)", borderBottom: "1px solid #3a3420", cursor: "pointer", userSelect: "none" },
  batchList: { display: "flex", flexDirection: "column", gap: 4, maxHeight: 120, overflowY: "auto" },
  batchItem: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#d7dbe2", cursor: "pointer" },
  pendingInline: { flex: "none", display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto", padding: "2px 0 8px", borderBottom: "1px solid #262b33", marginBottom: 8 },
  pendingInlineTitle: { fontSize: 12, fontWeight: 600, color: "#ffb86b" },
  pendingList: { display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", padding: "2px 0" },
  pendingCard: { border: "1px solid #3a414b", borderRadius: 8, padding: 10, background: "#181c22", display: "flex", flexDirection: "column", gap: 7 },
  pendingHead: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  pendingBadge: { flex: "none", color: "#ffb86b", fontSize: 13, lineHeight: 1 },
  pendingToggle: {
    flex: 1, minWidth: 0, textAlign: "left",
    background: "#101418", border: "1px solid #262b33", borderRadius: 6,
    color: "#f4f6f8", fontSize: 12,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    padding: "6px 8px",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
  },
  pendingHostTag: { flex: "none", maxWidth: 140, fontSize: 11, color: "#9aa3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  pendingModalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.6)",
    zIndex: 1100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  },
  pendingModal: {
    width: 560,
    maxWidth: "92vw",
    maxHeight: "80vh",
    overflowY: "auto",
    background: "#181c22",
    border: "1px solid #4a3520",
    borderRadius: 12,
    boxShadow: "0 16px 48px rgba(0,0,0,.55)",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10
  },
  pendingModalTitle: { fontSize: 15, fontWeight: 700, color: "#ffb86b" },
  pendingModalHint: { fontSize: 12, color: "#9aa3af" },
  pendingMeta: { fontSize: 11, color: "#9aa3af" },
  pendingReason: { fontSize: 12, color: "#ffb86b" },
  pendingCommand: { margin: 0, padding: 8, borderRadius: 6, background: "#101418", color: "#f4f6f8", border: "1px solid #262b33", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: 'Menlo, Monaco, "Courier New", monospace' },
  pendingActions: { display: "flex", justifyContent: "flex-end", gap: 8 },
  btnDanger: { background: "#c9372c", color: "#fff", border: "1px solid #e14b40", borderRadius: 6, padding: "6px 14px", fontSize: 13, cursor: "pointer" },
  hiddenFileInput: { display: "none" },
  keyImportHint: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--dsh-ssh-ops-muted, #8b93a1)" },
  dialogActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  btnPrimary: {
    background: "var(--dsw-alias-button-primary-fill, #2d6cdf)",
    color: "var(--dsw-alias-label-primary-foreground, #fff)",
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer"
  },
  btnSecondary: {
    background: "var(--dsw-alias-bg-layer-1, transparent)",
    color: "var(--dsh-ssh-ops-text, #d7dbe2)",
    border: "1px solid var(--dsh-ssh-ops-border, #3a414b)",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer"
  }
};
