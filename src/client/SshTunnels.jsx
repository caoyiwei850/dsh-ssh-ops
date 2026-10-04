/**
 * Port forwarding tab: start/stop local and remote tunnels through the
 * connected server, and list active tunnels.
 */
import * as React from "react";
import { t } from "../i18n/core.js";
const { useEffect, useState } = React;

export function SshTunnels({ api, connectionId }) {
  const [tunnels, setTunnels] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [kind, setKind] = useState("local");
  const [bindAddr, setBindAddr] = useState("127.0.0.1");
  const [bindPort, setBindPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState("");
  const [targetHost, setTargetHost] = useState("127.0.0.1");
  const [targetPort, setTargetPort] = useState("");

  const load = async () => {
    if (!connectionId) return;
    try {
      const value = await api.tunnelList(connectionId);
      setTunnels(Array.isArray(value?.tunnels) ? value.tunnels : []);
    } catch (err) {
      setError(err?.message ?? String(err));
      setTunnels([]);
    }
  };

  useEffect(() => {
    if (connectionId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const isDynamic = kind === "dynamic";
  const canStart = isDynamic ? Boolean(bindPort) : Boolean(remoteHost.trim() && remotePort);

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "dynamic") {
        await api.tunnelStartDynamic(
          connectionId,
          bindAddr.trim() || "127.0.0.1",
          bindPort ? Number(bindPort) : 0
        );
      } else if (kind === "local") {
        await api.tunnelStartLocal({
          connectionId,
          bindAddr: bindAddr.trim() || "127.0.0.1",
          bindPort: bindPort ? Number(bindPort) : 0,
          remoteHost: remoteHost.trim(),
          remotePort: Number(remotePort)
        });
      } else {
        await api.tunnelStartRemote({
          connectionId,
          bindAddr: bindAddr.trim() || "127.0.0.1",
          bindPort: bindPort ? Number(bindPort) : 0,
          remoteHost: remoteHost.trim(),
          remotePort: Number(remotePort),
          targetHost: targetHost.trim() || "127.0.0.1",
          targetPort: Number(targetPort)
        });
      }
      setShowForm(false);
      setRemoteHost("");
      setRemotePort("");
      setTargetPort("");
      load();
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (tunnelId) => {
    setBusy(true);
    setError(null);
    try {
      await api.tunnelStop(connectionId, tunnelId);
      load();
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={tunnelStyles.root}>
      <div style={tunnelStyles.toolbar}>
        <span style={tunnelStyles.title}>{t("Port forwarding")}</span>
        <button onClick={() => setShowForm(!showForm)} style={tunnelStyles.btn} title={t("New tunnel")}>{t("+")}</button>
        <button onClick={load} disabled={busy} style={tunnelStyles.btn} title={t("Refresh")}>↻</button>
      </div>

      {error && <div style={tunnelStyles.error}>{error}</div>}

      {showForm && (
        <div style={tunnelStyles.form}>
          <div style={tunnelStyles.formRow}>
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={tunnelStyles.input}>
              <option value="local">{t("Local forward (this machine → a target reachable from the server)")}</option>
              <option value="remote">{t("Remote forward (server → this machine)")}</option>
              <option value="dynamic">{t("Dynamic SOCKS5 (ssh -D; this machine becomes a proxy exit)")}</option>
            </select>
          </div>
          <div style={tunnelStyles.formRow}>
            <input value={bindAddr} onChange={(e) => setBindAddr(e.target.value)} placeholder={t("Bind address")} style={tunnelStyles.input} />
            <input value={bindPort} onChange={(e) => setBindPort(e.target.value)} placeholder={t("Bind port (0 = random)")} style={tunnelStyles.input} />
          </div>
          {!isDynamic && (
            <div style={tunnelStyles.formRow}>
              <input value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder={kind === "local" ? t("Remote target host") : t("Server listen host")} style={tunnelStyles.input} />
              <input value={remotePort} onChange={(e) => setRemotePort(e.target.value)} placeholder={kind === "local" ? t("Remote target port") : t("Server listen port")} style={tunnelStyles.input} />
            </div>
          )}
          {isDynamic && (
            <div style={tunnelStyles.empty}>{t("Clients pick their own destination after connecting to the bind address, and all traffic leaves through this server. For a fixed port, set the bind port to a non-zero value.")}</div>
          )}
          {kind === "remote" && (
            <div style={tunnelStyles.formRow}>
              <input value={targetHost} onChange={(e) => setTargetHost(e.target.value)} placeholder={t("Local target host")} style={tunnelStyles.input} />
              <input value={targetPort} onChange={(e) => setTargetPort(e.target.value)} placeholder={t("Local target port")} style={tunnelStyles.input} />
            </div>
          )}
          <div style={tunnelStyles.formRow}>
            <button onClick={start} disabled={busy || !canStart} style={tunnelStyles.btnPrimary}>
              {busy ? t("Starting…") : t("Start")}
            </button>
            <button onClick={() => setShowForm(false)} style={tunnelStyles.btn}>{t("Cancel")}</button>
          </div>
        </div>
      )}

      <div style={tunnelStyles.list}>
        {!tunnels ? (
          <div style={tunnelStyles.empty}>{t("Loading…")}</div>
        ) : tunnels.length === 0 ? (
          <div style={tunnelStyles.empty}>{t("No tunnels yet. Click “+” to add one, or ask me in the conversation to create one with tunnel_start.")}</div>
        ) : (
          tunnels.map((t) => (
            <div key={t.tunnelId} style={tunnelStyles.row}>
              <div style={tunnelStyles.rowBody}>
                <div style={tunnelStyles.rowTitle}>
                  <span style={{ ...tunnelStyles.dot, background: t.active ? "#3fb950" : "#8b93a1" }} />
                  <span>{t.kind === "dynamic" ? t("Dynamic SOCKS5") : t.kind === "local" ? t("Local") : t("Remote")}</span>
                  <span style={tunnelStyles.rowAddr}>{t.bindAddr}:{t.bindPort}</span>
                  {t.kind === "dynamic" ? (
                    <span style={tunnelStyles.rowAddr}>
                      {t.connections > 0 ? t(`Active connections ${t.connections}`) : t("Waiting for a connection")}
                    </span>
                  ) : (
                    <>
                      <span style={tunnelStyles.arrow}>→</span>
                      <span style={tunnelStyles.rowAddr}>{t.remoteHost}:{t.remotePort}</span>
                    </>
                  )}
                </div>
                <div style={tunnelStyles.rowId}>{t.tunnelId}</div>
              </div>
              <button onClick={() => stop(t.tunnelId)} disabled={busy} style={tunnelStyles.btnDanger}>{t("Stop")}</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const tunnelStyles = {
  root: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 6 },
  toolbar: { display: "flex", alignItems: "center", gap: 6, flex: "none" },
  title: { flex: 1, fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary, #d7dbe2)" },
  btn: {
    background: "var(--dsw-alias-bg-layer-1, transparent)", border: "1px solid var(--dsw-alias-border-l4, #3a414b)", color: "var(--dsw-alias-label-primary, #d7dbe2)",
    borderRadius: 6, padding: "3px 8px", fontSize: 12, cursor: "pointer", flex: "none"
  },
  btnPrimary: {
    background: "var(--dsw-alias-button-primary-fill, #2d6cdf)", color: "var(--dsw-alias-label-primary-foreground, #fff)", border: "none", borderRadius: 6,
    padding: "4px 14px", fontSize: 12, cursor: "pointer"
  },
  btnDanger: {
    background: "transparent", border: "1px solid #f85149", color: "#f85149",
    borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer", flex: "none"
  },
  form: { display: "flex", flexDirection: "column", gap: 6, padding: 8, background: "var(--dsw-alias-bg-layer-1, #181c22)", borderRadius: 8, flex: "none" },
  formRow: { display: "flex", gap: 6 },
  input: {
    flex: 1, background: "var(--dsw-alias-bg-layer-1, #101418)", border: "1px solid var(--dsw-alias-border-l4, #2a303a)", borderRadius: 6,
    color: "var(--dsw-alias-label-primary, #d7dbe2)", padding: "5px 8px", fontSize: 12, outline: "none", minWidth: 0
  },
  error: {
    padding: "6px 10px", fontSize: 12, color: "#f85149",
    background: "rgba(248,81,73,.1)", border: "1px solid rgba(248,81,73,.3)", borderRadius: 6, flex: "none"
  },
  list: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 },
  row: {
    display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
    background: "var(--dsw-alias-bg-layer-1, #181c22)", border: "1px solid var(--dsw-alias-border-l3, #262b33)", borderRadius: 8
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-primary, #d7dbe2)" },
  rowAddr: { fontFamily: "monospace", fontSize: 12, color: "var(--dsw-alias-label-secondary, #9aa3af)" },
  arrow: { color: "var(--dsw-alias-label-tertiary, #5b6472)" },
  dot: { width: 8, height: 8, borderRadius: "50%", flex: "none" },
  rowId: { fontSize: 10, color: "var(--dsw-alias-label-tertiary, #5b6472)", fontFamily: "monospace", marginTop: 2 },
  empty: { margin: "auto", fontSize: 12, color: "var(--dsw-alias-label-secondary, #8b93a1)", textAlign: "center", padding: "0 12px" }
};
