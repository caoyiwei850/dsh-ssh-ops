/**
 * Remote-workspace bindings for one saved SSH resource (issue #38).
 *
 * Rendered inside the resource editor's 高级选项 tab, next to the default
 * project directory, because a binding is a per-resource fact: "this DSH
 * workspace's files live on THIS server, under THIS directory".
 *
 * The binding deliberately does NOT turn the workspace into a remote mount.
 * DSH keeps treating the workspace as the host directory it always was; what
 * changes is (a) this plugin's SFTP tools default to the bound server and
 * resolve relative paths under the bound root, and (b) the conversation is
 * told where the files actually live. The copy below spells that split out for
 * the operator instead of promising transparent remote file I/O.
 */
import * as React from "react";
import { t } from "../i18n/core.js";
const { useEffect, useState } = React;

export function ResourceWorkspaces({ api, profileId, projectPath }) {
  const [bindings, setBindings] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ workspacePath: "", remotePath: "", autoConnect: true });

  const load = async () => {
    try {
      setError(null);
      const value = await api.remoteWorkspaceList();
      const all = Array.isArray(value?.bindings) ? value.bindings : [];
      setBindings(all.filter((binding) => binding.profileId === profileId));
      setWorkspaces(Array.isArray(value?.workspaces) ? value.workspaces : []);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
      setBindings([]);
    }
  };

  useEffect(() => {
    load();
  }, [profileId]);

  const save = async () => {
    if (!profileId || !form.workspacePath || !form.remotePath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.remoteWorkspaceSave({
        workspacePath: form.workspacePath,
        profileId,
        remotePath: form.remotePath.trim(),
        autoConnect: form.autoConnect
      });
      setForm({ workspacePath: "", remotePath: "", autoConnect: true });
      await load();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const unbind = async (workspacePath) => {
    setBusy(true);
    setError(null);
    try {
      await api.remoteWorkspaceDelete(workspacePath);
      await load();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const titleOf = (path) => workspaces.find((workspace) => workspace.path === path)?.title ?? path;
  const boundPaths = new Set((bindings ?? []).map((binding) => binding.workspacePath));
  // Only offered when it would actually change the field.
  const projectSuggestion = typeof projectPath === "string" ? projectPath.trim() : "";
  const suggestion = projectSuggestion.length > 0 && projectSuggestion !== form.remotePath.trim() ? projectSuggestion : null;

  return (
    <div style={styles.box}>
      <div style={styles.head}>
        <span style={styles.headTitle}>{t("远程工作区")}</span>
        <span style={styles.headHint}>{t("sftp_* 默认落在这个目录；原生 read/write/glob/grep 与本地 bash 不变")}</span>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {bindings === null ? (
        <div style={styles.empty}>{t("加载中…")}</div>
      ) : bindings.map((binding) => (
        <div key={binding.workspacePath} style={styles.row}>
          <div style={styles.rowBody}>
            <div style={styles.rowTitle}>
              <span style={styles.rowPath}>{binding.remotePath}</span>
              {binding.autoConnect && <span style={styles.chip}>{t("自动连接")}</span>}
              {binding.connected && <span style={{ ...styles.chip, color: "#3fb950", borderColor: "#2c6b45" }}>{t("已连接")}</span>}
            </div>
            <div style={styles.rowId} title={binding.workspacePath}>{titleOf(binding.workspacePath)}</div>
          </div>
          <button type="button" onClick={() => setForm({ workspacePath: binding.workspacePath, remotePath: binding.remotePath, autoConnect: binding.autoConnect })} disabled={busy} style={styles.btn}>{t("修改")}</button>
          <button type="button" onClick={() => unbind(binding.workspacePath)} disabled={busy} style={styles.btnDanger}>{t("解除")}</button>
        </div>
      ))}

      <div style={styles.formRow}>
        <select
          value={form.workspacePath}
          onChange={(event) => setForm({ ...form, workspacePath: event.target.value })}
          style={styles.input}
          aria-label={t("选择 DSH 工作区")}
          title={t("选择 DSH 工作区")}
        >
          <option value="">{t("选择工作区…")}</option>
          {workspaces.map((workspace) => (
            <option key={workspace.path} value={workspace.path} disabled={boundPaths.has(workspace.path) && workspace.path !== form.workspacePath}>
              {workspace.title ? `${workspace.title} — ${workspace.path}` : workspace.path}
            </option>
          ))}
        </select>
        <input
          value={form.remotePath}
          onChange={(event) => setForm({ ...form, remotePath: event.target.value })}
          placeholder={t("远端绝对路径，例如 /srv/app")}
          aria-label={t("远端绝对路径")}
          style={styles.input}
        />
        <button
          type="button"
          onClick={save}
          disabled={busy || !form.workspacePath || !form.remotePath.trim()}
          style={styles.btnPrimary}
        >
          {busy ? t("保存中…") : t("绑定")}
        </button>
      </div>
      {suggestion !== null && (
        // The resource's 默认项目目录 is almost always the same path; offer it
        // as a one-click fill instead of asking the operator to type it twice.
        <button type="button" onClick={() => setForm({ ...form, remotePath: suggestion })} style={styles.suggest} title={t("用这台服务器的默认项目目录作为远端根")}>
          {t(`填入默认项目目录：${suggestion}`)}
        </button>
      )}
      <label style={styles.checkRow}>
        <input type="checkbox" checked={form.autoConnect} onChange={(event) => setForm({ ...form, autoConnect: event.target.checked })} />
        <span>{t("文件操作时自动连接（受设置里的总开关约束）")}</span>
      </label>
    </div>
  );
}

const styles = {
  box: {
    display: "flex", flexDirection: "column", gap: 6, padding: 10, borderRadius: 8,
    border: "1px solid var(--dsw-alias-border-l4, #2a303a)", background: "var(--dsw-alias-bg-layer-1, #14181d)"
  },
  head: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
  headTitle: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #d7dbe2)" },
  headHint: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #9aa3b0)" },
  error: { padding: "5px 8px", fontSize: 12, color: "#f85149", background: "rgba(248,81,73,.08)", borderRadius: 6 },
  empty: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #8b93a1)", lineHeight: 1.6 },
  row: {
    display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 6,
    border: "1px solid var(--dsw-alias-border-l4, #232830)", background: "var(--dsw-alias-bg-layer-1, #101418)"
  },
  rowBody: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 },
  rowTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-primary, #d7dbe2)" },
  rowPath: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowId: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #8b93a1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  chip: { fontSize: 10, padding: "0 6px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l4, #3a414b)", color: "var(--dsw-alias-label-secondary, #9aa3b0)" },
  formRow: { display: "flex", gap: 6, flexWrap: "wrap" },
  input: {
    flex: "1 1 160px", minWidth: 0, background: "var(--dsw-alias-bg-layer-1, #101418)", border: "1px solid var(--dsw-alias-border-l4, #2a303a)",
    borderRadius: 6, color: "var(--dsw-alias-label-primary, #d7dbe2)", padding: "5px 8px", fontSize: 12, outline: "none"
  },
  btn: {
    background: "transparent", border: "1px solid var(--dsw-alias-border-l4, #3a414b)", color: "var(--dsw-alias-label-primary, #d7dbe2)",
    borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer", flex: "none"
  },
  btnPrimary: {
    background: "var(--dsw-alias-button-primary-fill, #2d6cdf)", color: "var(--dsw-alias-label-primary-foreground, #fff)", border: "none",
    borderRadius: 6, padding: "5px 14px", fontSize: 12, cursor: "pointer", flex: "none"
  },
  btnDanger: { background: "transparent", border: "1px solid #f85149", color: "#f85149", borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer", flex: "none" },
  suggest: {
    alignSelf: "flex-start", border: 0, padding: 0, background: "transparent", cursor: "pointer", font: "inherit",
    fontSize: 11, color: "var(--dsw-alias-button-primary-fill, #2d6cdf)", textAlign: "left", overflowWrap: "anywhere"
  },
  checkRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--dsw-alias-label-secondary, #9aa3b0)" }
};
