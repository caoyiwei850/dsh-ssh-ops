/**
 * Durable SSH resource management for Settings → Plugins.  Server coordinates
 * live in the host storage domain; secrets only cross the web boundary through
 * DSH's credentials.set/unset API and are never put in React state after save.
 */
import * as React from "react";
import { sshUiSetActiveConnection, sshUiSetConnections, sshUiSetError, sshUiSetOpen } from "./store.js";
import { privateKeyProblem } from "./pemkey.js";

const { useEffect, useRef, useState } = React;
const LEGACY_PROFILES_KEY = "dsh-ssh-ops.server-profiles.v1";

const HOST_KEY_MODE_LABELS = {
  "accept-new": "默认（首次信任，变化才拒）",
  verify: "严格（拒绝未知主机）",
  off: "关闭校验（不推荐）"
};

function emptyForm() {
  return {
    profileId: undefined,
    name: "",
    host: "",
    port: "22",
    username: "root",
    authKind: "password",
    hostKeyMode: "accept-new",
    groupId: "",
    secret: "",
    passphrase: "",
    clearSecret: false,
    clearPassphrase: false
  };
}

function profileToForm(profile) {
  return {
    ...emptyForm(),
    profileId: profile.profileId,
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    authKind: profile.authKind,
    hostKeyMode: profile.hostKeyMode ?? "accept-new",
    groupId: profile.groupId ?? ""
  };
}

async function credentialWrite(credentials, ref, value) {
  const response = await credentials.set(ref, value);
  if (response && !response.ok) throw new Error(response.error?.message ?? "无法保存凭据");
}

async function credentialUnset(credentials, ref) {
  const response = await credentials.unset(ref);
  if (response && !response.ok) throw new Error(response.error?.message ?? "无法清除凭据");
}

function readLegacyProfiles() {
  try {
    const value = JSON.parse(localStorage.getItem(LEGACY_PROFILES_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((profile) => profile && typeof profile.host === "string" && typeof profile.username === "string");
  } catch {
    return [];
  }
}

/** Migrate only non-secret coordinates from older browser-local profiles. */
export async function migrateLegacyProfiles(api) {
  const legacy = readLegacyProfiles().filter((p) => String(p.host ?? "").trim() !== "");
  if (legacy.length === 0) return false;
  const remaining = [];
  for (const profile of legacy) {
    try {
      await api.profileSave({
        name: String(profile.name || profile.host).trim() || "SSH server",
        host: String(profile.host).trim(),
        port: Number(profile.port) || 22,
        username: String(profile.username).trim(),
        authKind: profile.authKind === "key" ? "key" : "password"
      });
    } catch {
      remaining.push(profile);
    }
  }
  try {
    if (remaining.length === 0) localStorage.removeItem(LEGACY_PROFILES_KEY);
    else localStorage.setItem(LEGACY_PROFILES_KEY, JSON.stringify(remaining));
  } catch {}
  return true;
}

function ResourceEditor({ initial, groups, credentials, api, onClose, onSaved }) {
  const [form, setForm] = useState(() => initial ? profileToForm(initial) : emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const keyFileInput = useRef(null);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));

  const importKey = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1024 * 1024) return setError("私钥文件不能超过 1 MB");
    try {
      const secret = await file.text();
      if (!secret.trim()) throw new Error("所选私钥文件为空");
      setForm((current) => ({ ...current, secret }));
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? "无法读取私钥文件");
    }
  };

  const submit = async () => {
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      setError("请填写名称、主机和用户名");
      return;
    }
    if (!credentials) {
      setError("当前 DSH 未提供凭据服务，不能安全保存 SSH 认证信息");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // A truncated paste is the most common way a saved key ends up
      // "valid-looking but rejected by the server": catch it before anything
      // is persisted instead of surfacing later as a bare auth failure.
      if (form.authKind === "key" && form.secret.trim()) {
        const problem = privateKeyProblem(form.secret);
        if (problem) {
          setError(problem);
          return;
        }
      }
      const saved = await api.profileSave({
        ...(form.profileId ? { profileId: form.profileId } : {}),
        name: form.name.trim(),
        host: form.host.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        authKind: form.authKind,
        hostKeyMode: form.hostKeyMode,
        groupId: form.groupId || null
      });
      const primaryRef = form.authKind === "password" ? saved.credentialRefs.password : saved.credentialRefs.privateKey;
      if (form.secret.trim()) await credentialWrite(credentials, primaryRef, form.secret);
      else if (form.clearSecret) await credentialUnset(credentials, primaryRef);
      if (form.authKind === "key") {
        if (form.passphrase) await credentialWrite(credentials, saved.credentialRefs.passphrase, form.passphrase);
        else if (form.clearPassphrase) await credentialUnset(credentials, saved.credentialRefs.passphrase);
      }
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const primaryConfigured = initial?.credentialConfigured;
  return (
    <div style={styles.backdrop} onClick={busy ? undefined : onClose}>
      <div style={styles.dialog} onClick={(event) => event.stopPropagation()}>
        <div style={styles.dialogTitle}>{form.profileId ? "编辑 SSH 资源" : "新增 SSH 资源"}</div>
        <Field label="名称"><input value={form.name} onChange={set("name")} placeholder="阿里云生产环境" style={styles.input} /></Field>
        <Field label="主机"><input value={form.host} onChange={set("host")} placeholder="example.com 或 IP 地址" style={styles.input} /></Field>
        <div style={styles.twoColumns}>
          <Field label="端口"><input value={form.port} onChange={set("port")} inputMode="numeric" style={styles.input} /></Field>
          <Field label="用户名"><input value={form.username} onChange={set("username")} style={styles.input} /></Field>
        </div>
        <Field label="认证方式">
          <select value={form.authKind} onChange={set("authKind")} style={styles.input}>
            <option value="password">密码</option>
            <option value="key">PEM / 私钥</option>
          </select>
        </Field>
        <Field label="分组">
          <select value={form.groupId} onChange={set("groupId")} style={styles.input}>
            <option value="">未分组</option>
            {groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}
          </select>
        </Field>
        <Field label="主机指纹校验" hint="首次连接后信任该服务器指纹；之后指纹变化即拒（防中间人）。重装服务器后点该服务器卡片上的盾牌图标 → 忘记指纹重信。">
          <select value={form.hostKeyMode} onChange={set("hostKeyMode")} style={styles.input}>
            <option value="accept-new">{HOST_KEY_MODE_LABELS["accept-new"]}</option>
            <option value="verify">{HOST_KEY_MODE_LABELS.verify}</option>
            <option value="off">{HOST_KEY_MODE_LABELS.off}</option>
          </select>
        </Field>
        <Field label={form.authKind === "password" ? "密码" : "私钥（PEM / .key）"} hint={primaryConfigured ? "已保存；留空保持不变" : "保存后仅显示已配置状态"}>
          {form.authKind === "password" ? (
            <input type="password" value={form.secret} onChange={set("secret")} style={styles.input} />
          ) : (
            <>
              <textarea value={form.secret} onChange={set("secret")} rows={4} style={{ ...styles.input, fontFamily: "monospace" }} />
              <input ref={keyFileInput} type="file" accept=".pem,.key,.rsa,.ed25519,.txt,text/plain" onChange={importKey} style={{ display: "none" }} />
              <button type="button" onClick={() => keyFileInput.current?.click()} style={styles.secondary}>导入 PEM / 私钥文件</button>
            </>
          )}
          {primaryConfigured && <Check label="清除已保存的认证信息" checked={form.clearSecret} onChange={set("clearSecret")} />}
        </Field>
        {form.authKind === "key" && (
          <Field label="私钥口令" hint={initial?.passphraseConfigured ? "已保存；留空保持不变" : "可选"}>
            <input type="password" value={form.passphrase} onChange={set("passphrase")} style={styles.input} />
            {initial?.passphraseConfigured && <Check label="清除已保存的私钥口令" checked={form.clearPassphrase} onChange={set("clearPassphrase")} />}
          </Field>
        )}
        {error && <div style={styles.error} role="alert">{error}</div>}
        <div style={styles.actions}>
          <button type="button" disabled={busy} onClick={onClose} style={styles.secondary}>取消</button>
          <button type="button" disabled={busy} onClick={submit} style={styles.primary}>{busy ? "保存中…" : "保存资源"}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return <label style={styles.field}><span>{label}</span>{hint && <small style={styles.hint}>{hint}</small>}{children}</label>;
}

function Check({ label, checked, onChange }) {
  return <label style={styles.check}><input type="checkbox" checked={checked} onChange={onChange} />{label}</label>;
}

/** Green shield when a host's fingerprint is trusted; grey/dim when not. */
function ShieldIcon({ trusted }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" style={{ display: "block" }}>
      <path d="M12 2L4 5v6c0 5.2 3.4 9.5 8 11 4.6-1.5 8-5.8 8-11V5l-8-3z" fill={trusted ? "#32c56c" : "rgba(127,127,127,.45)"} />
    </svg>
  );
}

/** Modal to view / copy / forget one trusted host's fingerprint. */
function HostKeyPopup({ host, port, known, copied, onCopy, onForget, forgetBusy, onClose }) {
  const key = `${host}:${port}`;
  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.dialog} onClick={(event) => event.stopPropagation()}>
        <div style={styles.dialogTitle}>主机指纹 · {host}:{port}</div>
        <div style={styles.meta}>{known.algorithm || "ssh-host-key"}</div>
        <Field label="SHA-256 指纹" hint="可与此服务器上 ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub 的输出比对">
          <div style={styles.fingerprint}>SHA256:{known.fingerprint}</div>
        </Field>
        <div style={styles.meta}>首次信任 {new Date(known.firstSeenAt).toLocaleString()} · 最近 {new Date(known.lastSeenAt).toLocaleString()}</div>
        <div style={styles.actions}>
          <button type="button" onClick={() => onCopy(host, port, known.fingerprint)} style={styles.secondary}>{copied === key ? "已复制" : "复制指纹"}</button>
          <button type="button" disabled={forgetBusy === key} onClick={() => onForget(host, port)} style={styles.danger}>{forgetBusy === key ? "忘记中…" : "忘记指纹"}</button>
          <button type="button" onClick={onClose} style={styles.secondary}>关闭</button>
        </div>
      </div>
    </div>
  );
}

export function SshResources({ api, credentials }) {
  const [profiles, setProfiles] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editor, setEditor] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [knownHosts, setKnownHosts] = useState([]);
  const [forgetBusy, setForgetBusy] = useState(null);
  const [copiedHostKey, setCopiedHostKey] = useState(null);
  const [hostKeyPopup, setHostKeyPopup] = useState(null);

  const refresh = async ({ showLoading = true } = {}) => {
    // Poll ticks must not flip the loading flag: the list would unmount and
    // remount every 5 seconds (flicker, scroll and focus loss).
    if (showLoading) setLoading(true);
    try {
      const [profileResult, groupResult, knownResult] = await Promise.all([
        api.profileList(),
        api.groupList(),
        api.listKnownHosts?.().catch(() => ({ hosts: [] })) ?? { hosts: [] }
      ]);
      setProfiles(profileResult.profiles);
      setGroups(groupResult.groups);
      setKnownHosts(knownResult.hosts ?? []);
      // Deliberately no setError(null) here: this also runs on a 5s poll, and
      // wiping the banner would erase a connect failure before anyone reads it.
      // User actions clear the error when they start.
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try { await migrateLegacyProfiles(api); } catch {}
      if (alive) await refresh();
    })();
    // The connected badge reflects live server-side connections, which also
    // change from outside this page (SSH panel ×, agent, disconnects). Poll
    // so the badge and its 断开 control never go stale.
    const timer = setInterval(() => { if (alive) refresh({ showLoading: false }); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [api]);

  const connect = async (profile) => {
    setConnecting(profile.profileId);
    setError(null);
    try {
      // Fast-fail budget: an unreachable host settles in ~15s with a clear
      // error instead of a minute of silent retrying; the user can also
      // cancel the pending handshake explicitly.
      const connection = await api.profileConnect({ profileId: profile.profileId, readyTimeout: 15000, retries: 0 });
      await api.openSession(connection.connectionId, 100, 30);
      const listed = await api.list();
      sshUiSetConnections(listed.connections);
      sshUiSetActiveConnection(connection.connectionId);
      // A successful connect must clear any stale panel error (e.g. an earlier
      // host-key mismatch) so the error bar doesn't linger after recovery.
      sshUiSetError(null);
      sshUiSetOpen(true);
      await refresh();
    } catch (cause) {
      if (cause?.code === "connect-cancelled") return;
      const message = cause?.message ?? String(cause);
      sshUiSetError(message);
      setError(message);
    } finally {
      setConnecting(null);
    }
  };

  const cancelConnect = async (profile) => {
    try { await api.cancelProfileConnect({ profileId: profile.profileId }); } catch {}
    setConnecting(null);
  };

  const remove = async (profile) => {
    if (!window.confirm(`删除 SSH 资源“${profile.name}”？这会删除该资源保存的凭据，但不会断开已经建立的连接。`)) return;
    try {
      await api.profileDelete(profile.profileId);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const disconnectProfile = async (profile) => {
    setError(null);
    try {
      await api.profileDisconnect(profile.profileId);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const createGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    setCreatingGroup(true);
    try {
      await api.groupSave({ name });
      setNewGroupName("");
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setCreatingGroup(false);
    }
  };

  const deleteGroup = async (group) => {
    if (!window.confirm(`删除分组“${group.name}”？其中 ${group.profileCount} 台服务器会移到“未分组”，不会断开已建立的连接。`)) return;
    try {
      await api.groupDelete(group.groupId);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const forgetHost = async (host, port) => {
    if (!window.confirm(`忘记 ${host}:${port} 的主机指纹？下次连接将重新信任该服务器当前指纹。仅当服务器被合法重装/更换时才应操作。`)) return;
    const key = `${host}:${port}`;
    setForgetBusy(key);
    try {
      await api.forgetHostKey(host, port);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setForgetBusy(null);
    }
  };

  const copyHostFingerprint = async (host, port, fingerprint) => {
    const key = `${host}:${port}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("当前环境不支持复制到剪贴板");
      await navigator.clipboard.writeText(`SHA256:${fingerprint}`);
      setCopiedHostKey(key);
      setTimeout(() => setCopiedHostKey((current) => current === key ? null : current), 1500);
    } catch (cause) {
      setError(cause?.message ?? "无法复制主机指纹");
    }
  };

  const groupedProfiles = new Map(groups.map((group) => [group.groupId, []]));
  const ungrouped = [];
  for (const profile of profiles) {
    const bucket = profile.groupId === null ? undefined : groupedProfiles.get(profile.groupId);
    if (bucket === undefined) ungrouped.push(profile);
    else bucket.push(profile);
  }
  // Known hosts addressed by host:port so each saved-server card shows a green
  // shield when trusted; hosts trusted without a saved resource get a tail row.
  const knownByHost = new Map(knownHosts.map((h) => [`${h.host}:${h.port}`, h]));
  const matchedHostKeys = new Set(profiles.map((p) => `${p.host}:${p.port}`));
  const unmatchedKnownHosts = knownHosts.filter((h) => !matchedHostKeys.has(`${h.host}:${h.port}`));

  const renderProfiles = (items) => items.length === 0 ? null : <div style={styles.list}>{items.map((profile) => (
    <div key={profile.profileId} style={styles.card}>
      <div style={styles.cardMain}>
        <div style={styles.cardTitle}>{profile.name}{profile.connected && <span style={styles.connected}>已连接</span>}</div>
        <div style={styles.address}>{profile.username}@{profile.host}:{profile.port}</div>
        <div style={styles.meta}>{profile.authKind === "password" ? "密码认证" : "PEM / 私钥认证"} · {profile.credentialConfigured ? "凭据已保存" : "未保存凭据"}{profile.authKind === "key" && profile.passphraseConfigured ? " · 已保存私钥口令" : ""} · 指纹校验：{HOST_KEY_MODE_LABELS[profile.hostKeyMode] ?? HOST_KEY_MODE_LABELS["accept-new"]}</div>
      </div>
      <div style={styles.cardActions}>
        {(() => {
          const kh = knownByHost.get(`${profile.host}:${profile.port}`);
          return (
            <button type="button" disabled={!kh} onClick={() => kh && setHostKeyPopup(kh)} title={kh ? `已信任主机指纹（${kh.algorithm}）· 点击查看/复制/忘记` : "尚未信任该主机指纹"} aria-label={kh ? `查看 ${profile.host}:${profile.port} 的主机指纹` : "尚未信任主机指纹"} style={styles.iconButton}><ShieldIcon trusted={!!kh} /></button>
          );
        })()}
        {profile.connected && <button type="button" onClick={() => disconnectProfile(profile)} style={styles.secondary}>断开</button>}
        <button type="button" disabled={connecting === profile.profileId || !profile.credentialConfigured} onClick={() => connect(profile)} style={styles.primary}>{connecting === profile.profileId ? "连接中…" : "连接并打开"}</button>
        {connecting === profile.profileId && <button type="button" onClick={() => cancelConnect(profile)} style={styles.secondary}>取消</button>}
        <button type="button" onClick={() => setEditor({ mode: "edit", profile })} style={styles.secondary}>编辑</button>
        <button type="button" onClick={() => remove(profile)} style={styles.danger}>删除</button>
      </div>
    </div>
  ))}</div>;

  return (
    <div style={styles.page}>
      <div style={styles.pageHeader}>
        <div><h2 style={styles.heading}>SSH 资源</h2><p style={styles.description}>保存服务器地址和本机 DSH 凭据。密码、私钥和口令不会显示给 Agent 或写入浏览器存储。</p></div>
        <button type="button" style={styles.primary} onClick={() => setEditor({ mode: "new" })}>新增服务器</button>
      </div>
      <section style={styles.groupPanel}>
        <div style={styles.groupTitle}>服务器分组</div>
        <div style={styles.groupCreate}><input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") createGroup(); }} placeholder="例如：生产环境" style={styles.input} /><button type="button" disabled={creatingGroup || !newGroupName.trim()} onClick={createGroup} style={styles.secondary}>{creatingGroup ? "创建中…" : "创建分组"}</button></div>
        {groups.length > 0 && <div style={styles.groupChips}>{groups.map((group) => <span key={group.groupId} style={styles.groupChip}>{group.name}（{group.profileCount}）<button type="button" onClick={() => deleteGroup(group)} title={`删除分组 ${group.name}`} style={styles.chipDelete}>×</button></span>)}</div>}
      </section>
      {error && <div style={styles.error} role="alert">{error}</div>}
      {loading ? <div style={styles.empty}>加载 SSH 资源中…</div> : profiles.length === 0 ? <div style={styles.empty}>还没有保存的服务器。新增后可一键连接并打开右侧终端。</div> : <div style={styles.groupedList}>{groups.map((group) => <section key={group.groupId}><h3 style={styles.groupHeading}>{group.name}</h3>{renderProfiles(groupedProfiles.get(group.groupId) ?? []) || <div style={styles.groupEmpty}>这个分组还没有服务器。</div>}</section>)}{ungrouped.length > 0 && <section><h3 style={styles.groupHeading}>未分组</h3>{renderProfiles(ungrouped)}</section>}</div>}
      {unmatchedKnownHosts.length > 0 && (
        <section style={styles.groupPanel}>
          <div style={styles.groupTitle}>已信任主机（未保存为资源）</div>
          <div style={styles.list}>{unmatchedKnownHosts.map((h) => {
            const key = `${h.host}:${h.port}`;
            return (
              <div key={key} style={styles.card}>
                <div style={styles.cardMain}>
                  <div style={styles.cardTitle}>{h.host}:{h.port}</div>
                  <div style={styles.meta}>{h.algorithm || "ssh-host-key"} · 首次信任 {new Date(h.firstSeenAt).toLocaleString()}</div>
                </div>
                <div style={styles.cardActions}>
                  <button type="button" onClick={() => setEditor({ mode: "new", profile: { profileId: undefined, name: h.host, host: h.host, port: h.port, username: "root", authKind: "password", hostKeyMode: "accept-new" } })} title="把该服务器保存为 SSH 资源（可改用户名与认证方式）" style={styles.secondary}>保存为资源</button>
                  <button type="button" onClick={() => setHostKeyPopup(h)} title="查看/复制/忘记主机指纹" aria-label={`查看 ${h.host}:${h.port} 的主机指纹`} style={styles.iconButton}><ShieldIcon trusted /></button>
                </div>
              </div>
            );
          })}</div>
        </section>
      )}
      {hostKeyPopup && (
        <HostKeyPopup host={hostKeyPopup.host} port={hostKeyPopup.port} known={hostKeyPopup} copied={copiedHostKey} onCopy={copyHostFingerprint} onForget={forgetHost} forgetBusy={forgetBusy} onClose={() => setHostKeyPopup(null)} />
      )}
      {editor && <ResourceEditor initial={editor.profile} groups={groups} api={api} credentials={credentials} onClose={() => setEditor(null)} onSaved={refresh} />}
    </div>
  );
}

const styles = {
  // Settings owns the foreground color in both light and dark appearances.
  // Do not fall back to a hard-coded dark label here: this client bundle is
  // rendered inside that surface and may not receive DSH's alias variables.
  page: { padding: "20px 2px", color: "inherit", maxWidth: 900 },
  pageHeader: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 18, marginBottom: 18 },
  heading: { margin: 0, fontSize: 18 }, description: { margin: "6px 0 0", fontSize: 13, color: "inherit", opacity: 0.76, lineHeight: 1.5 },
  list: { display: "grid", gap: 10 }, card: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: 14, border: "1px solid var(--dsw-alias-border-l2, #d8dce3)", borderRadius: 10 },
  cardMain: { minWidth: 0 }, cardTitle: { fontWeight: 650, fontSize: 14, display: "flex", gap: 8, alignItems: "center" }, address: { marginTop: 4, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }, meta: { marginTop: 5, fontSize: 12, color: "inherit", opacity: 0.76 },
  connected: { fontSize: 11, color: "#32c56c", background: "rgba(50,197,108,.16)", padding: "2px 6px", borderRadius: 99 }, cardActions: { display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 7 },
  // Keep the label paired with DSH's primary fill.  In the default dark theme
  // the fill is light, so a hard-coded white label becomes invisible.
  primary: { border: 0, borderRadius: 7, padding: "7px 11px", background: "var(--dsw-alias-button-primary-fill, #2d6cdf)", color: "var(--dsw-alias-label-primary-foreground, #fff)", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" }, secondary: { border: "1px solid rgba(127,127,127,.55)", borderRadius: 7, padding: "6px 10px", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" }, iconButton: { border: "1px solid rgba(127,127,127,.55)", borderRadius: 7, minWidth: 30, padding: "5px 7px", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 15, lineHeight: 1.1 }, danger: { border: 0, borderRadius: 7, padding: "6px 8px", background: "transparent", color: "#f07171", cursor: "pointer", fontSize: 13 },
  empty: { padding: 28, border: "1px dashed rgba(127,127,127,.55)", borderRadius: 10, color: "inherit", opacity: 0.76, textAlign: "center" },
  groupPanel: { border: "1px solid rgba(127,127,127,.55)", borderRadius: 10, padding: 12, marginBottom: 16 }, groupTitle: { fontSize: 13, fontWeight: 650, marginBottom: 8 }, groupCreate: { display: "flex", gap: 8, maxWidth: 440 }, groupChips: { display: "flex", gap: 7, flexWrap: "wrap", marginTop: 10 }, groupChip: { display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 7px", borderRadius: 99, background: "rgba(127,127,127,.16)", fontSize: 12 }, chipDelete: { border: 0, background: "transparent", color: "#f07171", cursor: "pointer", padding: 0, fontSize: 15, lineHeight: 1 }, groupedList: { display: "grid", gap: 18 }, groupHeading: { margin: "0 0 8px", fontSize: 14 }, groupEmpty: { padding: 12, color: "inherit", opacity: 0.76, border: "1px dashed rgba(127,127,127,.55)", borderRadius: 8, fontSize: 12 },
  snippetForm: { display: "grid", gridTemplateColumns: "minmax(100px,.8fr) minmax(180px,2fr) minmax(110px,.7fr) auto", gap: 8, marginTop: 10, alignItems: "center" }, snippetList: { display: "grid", gap: 7, marginTop: 10 }, snippetItem: { display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 10px", border: "1px solid rgba(127,127,127,.4)", borderRadius: 7, fontSize: 12 }, snippetScope: { marginLeft: 7, opacity: .7 }, snippetCommand: { marginTop: 4, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", opacity: .82, overflowWrap: "anywhere" }, fingerprint: { marginTop: 8, maxWidth: 560, overflowWrap: "anywhere", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, lineHeight: 1.45, opacity: 0.86 }, backdrop: { position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,.42)", display: "flex", alignItems: "center", justifyContent: "center" }, dialog: { width: 440, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 32px)", overflow: "auto", background: "var(--dsw-alias-bg-overlay, #fff)", color: "inherit", borderRadius: 12, padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,.28)", display: "flex", flexDirection: "column", gap: 11 }, dialogTitle: { fontSize: 16, fontWeight: 650 },
  field: { display: "flex", flexDirection: "column", gap: 5, fontSize: 13 }, hint: { color: "inherit", opacity: 0.76, fontWeight: 400 }, input: { width: "100%", boxSizing: "border-box", border: "1px solid rgba(127,127,127,.55)", borderRadius: 7, padding: "7px 8px", background: "transparent", color: "inherit", fontSize: 13 }, twoColumns: { display: "grid", gridTemplateColumns: "110px 1fr", gap: 10 }, check: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#f07171" }, actions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }, error: { padding: "8px 10px", borderRadius: 7, background: "rgba(240,113,113,.15)", color: "#ff8a8a", fontSize: 13 }
};
