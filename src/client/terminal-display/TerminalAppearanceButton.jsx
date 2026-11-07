import * as React from "react";
import { t } from "../../i18n/core.js";
import { useLanguage } from "../locale.js";
import { TerminalDisplaySettings } from "./TerminalDisplaySettings.jsx";

function AppearanceDialog({ onClose }) {
  const ref = React.useRef(null);
  const titleId = React.useId();
  const close = () => { ref.current?.close(); onClose(); };
  React.useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    style={{ padding: 0, width: "min(1120px, calc(100vw - 32px))", maxWidth: "calc(100vw - 24px)", maxHeight: "min(840px, calc(100vh - 24px))",
      border: "1px solid var(--dsh-ssh-ops-border, #3a414b)", borderRadius: 10, color: "var(--dsh-ssh-ops-text, #d7dbe2)",
      background: "var(--dsh-ssh-ops-surface, #161b21)", boxShadow: "0 12px 40px rgba(0,0,0,.22)", overflow: "hidden" }}>
    <div onClick={(event) => event.stopPropagation()} style={{ display: "flex", flexDirection: "column", maxHeight: "min(840px, calc(100vh - 24px))", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px 10px", flexShrink: 0 }}>
        <h3 id={titleId} style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{t("终端外观")}</h3>
        <button type="button" autoFocus onClick={close} aria-label={t("关闭外观设置")} title={t("关闭")}
          style={{ border: "none", background: "transparent", color: "var(--dsh-ssh-ops-muted, #8b93a1)", width: 24, height: 24, cursor: "pointer", fontSize: 18 }}>×</button>
      </div>
      {/* The body fills the capped dialog height so the scheme list, not the
          whole dialog, becomes the scroll area (laptop-height windows). */}
      <div className="dsh-appearance-body"><TerminalDisplaySettings /></div>
    </div>
  </dialog>;
}
export function TerminalAppearanceButton({ style }) {
  useLanguage();
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef(null);
  return <>
    <button ref={trigger} type="button" style={style} aria-label={t("终端外观")} title={t("终端外观")} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3a9 9 0 1 0 0 18h1.2a2.3 2.3 0 0 0 1.7-3.8 1.3 1.3 0 0 1 1-2.2h1.6a3.5 3.5 0 0 0 3.5-3.5A8.8 8.8 0 0 0 12 3Z" />
        <circle cx="7.5" cy="10.5" r=".9" /><circle cx="10" cy="6.8" r=".9" />
        <circle cx="14.5" cy="7" r=".9" /><circle cx="17.5" cy="10" r=".9" />
      </svg>
    </button>
    {open && <AppearanceDialog onClose={() => { setOpen(false); trigger.current?.focus(); }} />}
  </>;
}
