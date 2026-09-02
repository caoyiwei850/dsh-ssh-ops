/**
 * The right-side SSH terminal panel: a floating panel pinned to the right edge
 * of the conversation view. Shows a connection toolbar, an xterm.js terminal
 * for the active session, and a connect dialog.
 */
import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { XTERM_CSS } from "./xterm-css.js";
import { useSshUi, getSshUiSnapshot, sshUiSetActiveConnection, sshUiSetBusy, sshUiSetConnections, sshUiSetError, sshUiSetOpen } from "./store.js";
import { SshFiles } from "./SshFiles.jsx";
import { SshTunnels } from "./SshTunnels.jsx";
import { SshDatabase } from "./SshDatabase.jsx";
import { privateKeyProblem } from "./pemkey.js";
import { availableCommandSnippets, loadCommandSnippets, matchingCommandSnippets, saveCommandSnippets, searchCommandSnippets } from "./command-snippets.js";

const { useEffect, useRef, useState, Component } = React;

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
const PANEL_LAYOUT_STYLE_ID = "dsh-ssh-ops-panel-layout";
const PANEL_WIDTH_KEY = "dsh-ssh-ops.panel-width";
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 720;

function maxPanelWidth() {
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.floor(window.innerWidth * 0.7)));
}

function clampPanelWidth(width) {
  return clamp(Math.round(width), PANEL_MIN_WIDTH, maxPanelWidth());
}

function initialPanelWidth() {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored)) return clampPanelWidth(stored);
  } catch {}
  return 480;
}


function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `${XTERM_CSS}

/*
 * The shell overlay does not reserve layout space on its own.  When the SSH
 * drawer is open, make the main conversation column yield the drawer width so
 * text never continues underneath the terminal.  The class suffix is emitted
 * by DSH's CSS modules and is stable across its hashed prefix.
 */
html[data-dsh-ssh-ops-panel-open] [class*="centerCol"] {
  margin-right: var(--dsh-ssh-ops-panel-space, 496px) !important;
  transition: margin-right 160ms ease;
}

/*
 * DSH-better-sidebar reserves its own right-hand lane by publishing
 * --dsh-sidebar-width.  Keep this drawer inside the remaining app frame
 * instead of covering that lane.  The fallback retains the normal DSH layout
 * when better-sidebar is absent or collapsed.
 */
html[data-dsh-ssh-ops-panel-open] [data-dsh-ssh-ops-panel] {
  right: var(--dsh-sidebar-width, 0px) !important;
}

/*
 * When better-sidebar is collapsed its two toggle buttons live in the
 * viewport's top-right corner.  Move this drawer's own + / close actions out
 * of that shared corner while leaving the title and panel body unchanged.
 */
body[data-dsh-sidebar-collapsed] [data-dsh-ssh-ops-panel-header] {
  padding-right: 84px !important;
}

/* On narrow screens, preserving a usable conversation column matters more
 * than a permanent split view, so the terminal remains an overlay. */
@media (max-width: 900px) {
  html[data-dsh-ssh-ops-panel-open] [class*="centerCol"] {
    margin-right: 0 !important;
  }
}`;
  document.head.appendChild(style);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Whether the plugin runs inside the DSH Desktop shell, whose frameless window
 * draws its own titlebar (and window controls) above the web content.
 */
function isDesktopShell() {
  return (
    (typeof document !== "undefined" && document.body?.classList?.contains("dsh-desktop-windows-titlebar-layout")) ||
    (typeof document !== "undefined" && document.getElementById("dsh-desktop-drag-region") !== null)
  );
}

/**
 * The DSH Desktop shell's window controls (minimize / maximize / close) sit in
 * the top-right of a ~36px frameless titlebar. Align the drawer's top edge with
 * the sidebar "New session" button so the drawer header (＋/×) lands below that
 * titlebar instead of covering the window close button. Falls back to 74px
 * (36px titlebar + sidebar brand row) when the button cannot be measured.
 */
function desktopPanelTop() {
  if (!isDesktopShell()) return 0;
  const sidebar = document.querySelector("[data-dsh-sidebar-root]");
  if (!sidebar) return 74;
  const labelRe = /新建会话|New session/i;
  let best = null;
  for (const button of sidebar.querySelectorAll("button")) {
    if (!labelRe.test(button.getAttribute("aria-label") ?? "")) continue;
    // The brand logo button shares the same aria-label but lives higher in the
    // logo row; the real New Session button is the lower of the two.
    if (best === null || button.getBoundingClientRect().top > best.getBoundingClientRect().top) {
      best = button;
    }
  }
  if (!best) return 74;
  const top = Math.round(best.getBoundingClientRect().top);
  return top > 0 ? top : 74;
}

/** One xterm instance bound to one host session via long-poll reads. */
function XtermView({ api, sessionId, connectionId }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    ensureStyles();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      // Some remote commands produce LF-only text. Treat it as a normal
      // terminal newline so rows do not continue at the previous column.
      convertEol: true,
      theme: { background: "#101418" }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    term.open(containerRef.current);
    fit.fit();

    let alive = true;
    let resizeObserver = null;
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
    term.onData(onData);

    const loop = async () => {
      let errorBackoff = 0;
      while (alive) {
        try {
          const { data, exit } = await api.read(sessionId, 300);
          if (!alive) return;
          if (data) term.write(data);
          errorBackoff = 0;
          if (exit !== null) {
            setClosed(true);
            if (alive) term.write(`\r\n\x1b[90m[session exited]\x1b[0m\r\n`);
            return;
          }
        } catch (error) {
          if (!alive) return;
          if (error?.code === "no-session") {
            // The host restarted or the connection was closed server-side.
            // Without this notice the pane freezes on stale output and it
            // looks like agent commands stopped being echoed.
            setClosed(true);
            term.write(`\r\n\x1b[31m[终端会话已失效：DSH 服务已重启或该连接已关闭。请到 设置 → 插件 → SSH 资源 重新连接]\x1b[0m\r\n`);
            return;
          }
          // Back off so a dead transport cannot become a tight retry loop.
          await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 500 * 2 ** errorBackoff++)));
        }
      }
    };
    loop();

    const onResize = () => {
      try {
        fit.fit();
        const dims = term.cols && term.rows ? { cols: term.cols, rows: term.rows } : null;
        if (dims && alive) api.resize(sessionId, dims.cols, dims.rows).catch(() => {});
      } catch {}
    };
    resizeObserver = new ResizeObserver(onResize);
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    return () => {
      alive = false;
      pendingInput = "";
      resizeObserver?.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId, connectionId, api]);

  return (
    <div style={panelStyles.xtermWrap} ref={containerRef} data-closed={closed || undefined} />
  );
}

function ConnectDialog({ api, credentials, onClose }) {
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: "22",
    username: "root",
    authKind: "password",
    password: "",
    privateKey: "",
    passphrase: ""
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [keyFileName, setKeyFileName] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const keyFileInputRef = useRef(null);
  const [showProxyJump, setShowProxyJump] = useState(false);
  const [proxyJumps, setProxyJumps] = useState([]);

  useEffect(() => {
    let alive = true;
    api.profileList().then((value) => {
      if (alive) setProfiles(value.profiles);
    }).catch(() => {});
    return () => { alive = false; };
  }, [api]);

  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  const addProxyJump = () => {
    setProxyJumps((hops) => [...hops, { host: "", port: 22, username: "root", authKind: "password", password: "", privateKey: "", passphrase: "" }]);
  };
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
    if (!selectedProfileId) {
      for (const secret of [form.privateKey, ...proxyJumps.map((hop) => hop.privateKey)]) {
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
        ? await api.profileConnect({ profileId: selectedProfileId, readyTimeout: 15000, retries: 0 })
        : await api.connect({
            host: form.host.trim(),
            port: Number(form.port) || 22,
            username: form.username.trim(),
            auth: form.authKind === "password"
              ? { kind: "password", password: form.password }
              : { kind: "key", privateKey: form.privateKey, ...(form.passphrase ? { passphrase: form.passphrase } : {}) },
            name: form.name.trim() || undefined,
            ...(proxyJumps.length > 0 ? [{ proxyJump: proxyJumps.map((hop) => ({
              host: hop.host.trim(),
              port: Number(hop.port) || 22,
              username: hop.username.trim(),
              auth: hop.authKind === "password"
                ? { kind: "password", password: hop.password }
                : { kind: "key", privateKey: hop.privateKey, ...(hop.passphrase ? { passphrase: hop.passphrase } : {}) }
            })) }] : [])
          });
      // The service returns a live connection, but it is not useful to the
      // panel until it becomes the active record.  Without this, a successful
      // connect looked exactly like "No connections" to the user.
      sshUiSetActiveConnection(connection.connectionId);
      await refreshConnections(api, { adopt: false });
      // The panel is a terminal, not merely a connection list: open the PTY
      // immediately so a successful connection is ready to use at once.
      try {
        await api.openSession(connection.connectionId, 100, 30);
        await refreshConnections(api, { adopt: false });
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
        groupId: null
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
      sshUiSetActiveConnection(connection.connectionId);
      await refreshConnections(api, { adopt: false });
      try {
        await api.openSession(connection.connectionId, 100, 30);
        await refreshConnections(api, { adopt: false });
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
        sshUiSetActiveConnection(connection.connectionId);
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
          </div>
        )}
        {!selectedProfileId && <><div style={panelStyles.temporaryTitle}>临时连接（不会保存）</div><label style={panelStyles.field}>
          <span>名称（可选）</span>
          <input value={form.name} onChange={set("name")} placeholder="my-server" style={panelStyles.input} />
        </label>
        <label style={panelStyles.field}>
          <span>主机</span>
          <input value={form.host} onChange={set("host")} placeholder="192.168.1.100" style={panelStyles.input} />
        </label>
        <label style={panelStyles.field}>
          <span>端口</span>
          <input value={form.port} onChange={set("port")} style={panelStyles.input} />
        </label>
        <label style={panelStyles.field}>
          <span>用户名</span>
          <input value={form.username} onChange={set("username")} style={panelStyles.input} />
        </label>
        <label style={panelStyles.field}>
          <span>认证方式</span>
          <select value={form.authKind} onChange={set("authKind")} style={panelStyles.input}>
            <option value="password">密码</option>
            <option value="key">私钥</option>
          </select>
        </label>
        {form.authKind === "password" ? (
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
        )}</>}
        {!selectedProfileId && (
          <div style={panelStyles.proxyJumpSection}>
            <button type="button" onClick={() => setShowProxyJump(!showProxyJump)} style={panelStyles.proxyJumpToggle}>
              {showProxyJump ? "▼" : "▶"} 跳板机（ProxyJump）
            </button>
            {showProxyJump && (
              <div style={panelStyles.proxyJumpList}>
                {proxyJumps.map((hop, index) => (
                  <div key={index} style={panelStyles.proxyJumpRow}>
                    <input value={hop.host} onChange={(e) => updateProxyJump(index, "host", e.target.value)} placeholder="跳板主机" style={panelStyles.input} />
                    <input value={hop.username} onChange={(e) => updateProxyJump(index, "username", e.target.value)} placeholder="用户名" style={panelStyles.input} />
                    <select value={hop.authKind} onChange={(e) => updateProxyJump(index, "authKind", e.target.value)} style={panelStyles.input}>
                      <option value="password">密码</option>
                      <option value="key">私钥</option>
                    </select>
                    {hop.authKind === "password" ? (
                      <input type="password" value={hop.password} onChange={(e) => updateProxyJump(index, "password", e.target.value)} placeholder="密码" style={panelStyles.input} />
                    ) : (
                      <input value={hop.privateKey} onChange={(e) => updateProxyJump(index, "privateKey", e.target.value)} placeholder="私钥内容" style={panelStyles.input} />
                    )}
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

async function refreshConnections(api, { adopt = true } = {}) {
  try {
    const { connections } = await api.list();
    sshUiSetConnections(connections);
    // A page reload resets the client-side active binding while connections
    // keep living server-side. Without re-adoption the panel shows "未连接"
    // and its × can no longer disconnect anything — the connection becomes a
    // zombie that outlives the browser. Rebind to the first live connection,
    // but only for recovery: never during an explicit × disconnect, where
    // re-adopting another live connection would defeat the operator's intent.
    if (adopt && connections.length > 0 && getSshUiSnapshot().activeConnectionId === null) {
      sshUiSetActiveConnection(connections[0].connectionId);
    }
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

export function SshPanel({ api, credentials, locale }) {
  const ui = useSshUi();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth);
  const [panelTop, setPanelTop] = useState(() => desktopPanelTop());
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
  const panelRef = useRef(null);
  const snippetSearchRef = useRef(null);
  const t = zhDict;

  useEffect(() => {
    if (!ui.open) return;
    refreshConnections(api);
    const timer = setInterval(() => refreshConnections(api), 5000);
    return () => clearInterval(timer);
  }, [ui.open, api]);

  useEffect(() => {
    const sync = () => setCommandSnippets(loadCommandSnippets());
    window.addEventListener("dsh-ssh-ops-command-snippets", sync);
    return () => window.removeEventListener("dsh-ssh-ops-command-snippets", sync);
  }, []);

  useEffect(() => {
    if (!ui.open) return;
    Promise.all([api.profileList(), api.groupList()]).then(([profileValue, groupValue]) => {
      setProfiles(profileValue.profiles ?? []);
      setGroups(groupValue.groups ?? []);
    }).catch(() => {});
  }, [ui.open, api]);

  // Keep the drawer's top edge aligned with the sidebar "New session" button so
  // the header controls never overlap the DSH Desktop window buttons. Re-measure
  // on resize, sidebar reflow, and a slow poll as a safety net for late mounts.
  useEffect(() => {
    if (!ui.open) return;
    const sync = () => setPanelTop(desktopPanelTop());
    sync();
    window.addEventListener("resize", sync);
    const sidebar = document.querySelector("[data-dsh-sidebar-root]");
    let observer = null;
    if (sidebar) {
      observer = new ResizeObserver(sync);
      observer.observe(sidebar);
    }
    const timer = setInterval(sync, 2000);
    return () => {
      window.removeEventListener("resize", sync);
      observer?.disconnect();
      clearInterval(timer);
    };
  }, [ui.open]);

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
    if (!ui.open) return;
    refreshPendingConfirmations();
    const timer = setInterval(refreshPendingConfirmations, 1000);
    return () => clearInterval(timer);
  }, [ui.open, api]);

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
    if (!ui.open) return;
    refreshBatchTasks();
    const timer = setInterval(refreshBatchTasks, 1000);
    return () => clearInterval(timer);
  }, [ui.open, api]);


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

  useEffect(() => {
    if (!ui.open) return;

    ensureStyles();
    const root = document.documentElement;
    const syncReservedSpace = () => {
      const width = Math.ceil(panelRef.current?.getBoundingClientRect().width || 480);
      // Keep a small breathing gap between the message column and the drawer.
      root.style.setProperty("--dsh-ssh-ops-panel-space", `${width + 16}px`);
    };

    syncReservedSpace();
    root.dataset.dshSshOpsPanelOpen = "true";
    const observer = new ResizeObserver(syncReservedSpace);
    if (panelRef.current) observer.observe(panelRef.current);

    return () => {
      observer.disconnect();
      delete root.dataset.dshSshOpsPanelOpen;
      root.style.removeProperty("--dsh-ssh-ops-panel-space");
    };
  }, [ui.open]);

  useEffect(() => {
    const onWindowResize = () => setPanelWidth((width) => clampPanelWidth(width));
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  const active = ui.connections.find((c) => c.connectionId === ui.activeConnectionId);
  const visibleCommandSnippets = searchCommandSnippets(
    matchingCommandSnippets(availableCommandSnippets(commandSnippets), active, profiles),
    snippetQuery
  );

  useEffect(() => {
    if (!ui.open || tab !== "snippets") return;
    const frame = requestAnimationFrame(() => snippetSearchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [ui.open, tab]);

  if (!ui.open) return null;

  const openSession = async () => {
    if (!active) return;
    sshUiSetBusy(true);
    sshUiSetError(null);
    try {
      await api.openSession(active.connectionId, 100, 30);
      await refreshConnections(api, { adopt: false });
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

  /** Disconnect one server from its tab's × button. */
  const closeConnection = async (connectionId) => {
    sshUiSetBusy(true);
    sshUiSetError(null);
    try {
      await api.disconnect(connectionId);
    } catch (err) {
      sshUiSetError(`断开 SSH 连接失败：${err?.message ?? String(err)}`);
    } finally {
      // If the closed tab was the selected one, move selection to a surviving
      // tab (or none) before the list refresh drops the record.
      const remaining = ui.connections.filter((c) => c.connectionId !== connectionId);
      if (getSshUiSnapshot().activeConnectionId === connectionId) {
        sshUiSetActiveConnection(remaining[0]?.connectionId ?? null);
      }
      await refreshConnections(api, { adopt: false });
      sshUiSetBusy(false);
    }
  };

  const closePanel = () => {
    // Hiding the panel must never tear down the open connections: they are
    // managed per tab, and the panel is only a view over them.  Reopening the
    // panel (top SSH button) shows the same tabs still connected.
    sshUiSetOpen(false);
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

  const beginResize = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelRef.current?.getBoundingClientRect().width ?? panelWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent) => {
      // The drawer is anchored at the right, so moving its left edge left makes
      // it wider and moving it right makes it narrower.
      setPanelWidth(clampPanelWidth(startWidth + startX - moveEvent.clientX));
    };
    const endResize = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endResize);
      window.removeEventListener("pointercancel", endResize);
      setPanelWidth((width) => {
        try {
          localStorage.setItem(PANEL_WIDTH_KEY, String(width));
        } catch {}
        return width;
      });
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endResize);
    window.addEventListener("pointercancel", endResize);
  };

  return (
    <div ref={panelRef} data-dsh-ssh-ops-panel="true" style={{ ...panelStyles.root, width: panelWidth, top: panelTop }}>
      <div
        style={panelStyles.resizeHandle}
        onPointerDown={beginResize}
        role="separator"
        aria-label="调整 SSH 终端宽度"
        aria-orientation="vertical"
        title="拖动以调整 SSH 终端宽度"
      />
      <div data-dsh-ssh-ops-panel-header="true" style={panelStyles.header}>
        <span style={panelStyles.title}>{t.panelTitle}</span>
        <button onClick={closePanel} disabled={ui.busy} style={panelStyles.btnSmall} title={t.closePanel}>×</button>
      </div>

      <div style={panelStyles.serverTabs}>
        {ui.connections.map((conn) => {
          const isActive = conn.connectionId === ui.activeConnectionId;
          return (
            <div key={conn.connectionId} style={{ ...panelStyles.serverTab, ...(isActive ? panelStyles.serverTabActive : {}) }}>
              <button
                type="button"
                style={panelStyles.serverTabLabel}
                onClick={() => sshUiSetActiveConnection(conn.connectionId)}
                title={`${conn.username}@${conn.host}:${conn.port}`}
              >
                {conn.name || `${conn.username}@${conn.host}`}
              </button>
              <button
                type="button"
                style={panelStyles.serverTabClose}
                onClick={() => closeConnection(conn.connectionId)}
                disabled={ui.busy}
                title="断开此服务器"
                aria-label={`断开 ${conn.name || conn.host}`}
              >
                ×
              </button>
            </div>
          );
        })}
        {ui.connections.length === 0 && <span style={panelStyles.connEmpty}>{t.empty}</span>}
        <button type="button" style={panelStyles.serverTabAdd} onClick={() => setDialogOpen(true)} title={t.connect} aria-label="连接新服务器">＋</button>
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
            {ui.connections.length > 0 ? (
              ui.connections.map((conn) => {
                const sessionId = conn.sessions?.[0] ?? null;
                const isActive = conn.connectionId === ui.activeConnectionId;
                return (
                  <div
                    key={conn.connectionId}
                    style={{ ...panelStyles.terminalPaneWrap, display: isActive ? "flex" : "none" }}
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
                <SshFiles api={api} connectionId={active.connectionId} />
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

      {dialogOpen && <ConnectDialog api={api} credentials={credentials} onClose={() => setDialogOpen(false)} />}

      {batchTask && <BatchDialog api={api} task={batchTask} onDone={() => setBatchTask(null)} />}
    </div>
  );
}

const zhDict = {
  panelTitle: "SSH 终端",
  connect: "连接服务器",
  closePanel: "隐藏 SSH 终端面板（不断开连接）",
  openSession: "打开终端",
  empty: "还没有连接。点「＋」添加服务器，或在对话里让我帮你连。",
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
  closePanel: "Hide SSH terminal panel (keep connections)",
  openSession: "Open",
  empty: "No connections. Click ＋ to add a server, or ask me in the conversation.",
  sessionClosed: "Session closed",
  noConnection: "Not connected",
  busy: "Busy…",
  tabTerminal: "Terminal",
  tabFiles: "Files",
  tabTunnels: "Tunnels",
  tabDatabase: "Database"
};

const panelStyles = {
  root: {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: 480,
    maxWidth: "70vw",
    zIndex: 900,
    display: "flex",
    flexDirection: "column",
    background: "#101418",
    borderLeft: "1px solid #262b33",
    boxShadow: "-8px 0 24px rgba(0,0,0,.35)",
    fontFamily: "var(--dsw-font-family, system-ui, sans-serif)",
    color: "#d7dbe2"
  },
  resizeHandle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -5,
    width: 10,
    cursor: "col-resize",
    zIndex: 1,
    touchAction: "none"
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    borderBottom: "1px solid #262b33",
    flex: "none"
  },
  title: { fontSize: 13, fontWeight: 600, flex: 1 },
  btnSmall: {
    background: "transparent",
    border: "1px solid #3a414b",
    color: "#d7dbe2",
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
    borderBottom: "1px solid #1f242c",
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
    border: "1px solid #3a414b",
    borderBottom: "none",
    borderRadius: "6px 6px 0 0",
    background: "#1a1f26",
    color: "#8b93a1",
    overflow: "hidden",
    flex: "none",
    maxWidth: 190
  },
  serverTabActive: {
    background: "#101418",
    color: "#d7dbe2",
    borderBottom: "2px solid #2d6cdf"
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
  serverTabAdd: {
    background: "transparent",
    border: "1px dashed #3a414b",
    color: "#8b93a1",
    borderRadius: 6,
    width: 24,
    height: 24,
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1,
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
    display: "flex", gap: 4, padding: "0 8px", borderBottom: "1px solid #1f242c",
    flex: "none", alignItems: "center"
  },
  tab: {
    background: "transparent", border: "none", color: "#8b93a1",
    padding: "6px 12px", fontSize: 12, cursor: "pointer",
    borderBottom: "2px solid transparent"
  },
  tabActive: { color: "#d7dbe2", borderBottomColor: "#2d6cdf" },
  emptyState: { margin: "auto", fontSize: 12, color: "#8b93a1", textAlign: "center" },
  xtermWrap: { flex: 1, minWidth: 0, overflow: "hidden" },
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
    background: "#181c22",
    border: "1px solid #2a303a",
    borderRadius: 12,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    boxShadow: "0 12px 40px rgba(0,0,0,.5)"
  },
  dialogTitle: { fontSize: 14, fontWeight: 600, marginBottom: 2 },
  temporaryTitle: { fontSize: 12, color: "#9aa3af", marginTop: 2 },
  field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#9aa3af" },
  input: {
    background: "#101418",
    border: "1px solid #2a303a",
    borderRadius: 6,
    color: "#d7dbe2",
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
  proxyJumpToggle: { background: "transparent", border: "none", color: "#9aa3af", fontSize: 12, cursor: "pointer", textAlign: "left", padding: 0 },
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
  keyImportHint: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "#8b93a1" },
  dialogActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  btnPrimary: {
    background: "#2d6cdf",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer"
  },
  btnSecondary: {
    background: "transparent",
    color: "#d7dbe2",
    border: "1px solid #3a414b",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer"
  }
};
