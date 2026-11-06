import * as React from "react";
import { t } from "../../i18n/core.js";
import { splitPatterns, patternProblem, MAX_PATTERN_LENGTH, MAX_PATTERNS, MAX_SCHEME_TEXT } from "./scheme.js";

export function PatternTags({ label, text, disabled, onChange }) {
  const patterns = React.useMemo(() => splitPatterns(text), [text]);
  // Compile each tag once per text change instead of twice per render (the
  // inline error and every chip used to call patternProblem separately); a
  // maximum scheme of 43 entries x 64 tags re-renders the whole tree on every
  // keystroke in the preview, where this duplication was measurable.
  const problems = React.useMemo(() => new Map(patterns.map((source) => [source, patternProblem(source)])), [patterns]);
  // Two separate drafts: the trailing input only adds new tags, while a chip
  // edits its own value in place. Sharing one draft used to leak the edited tag
  // into the add field (and a blur race closed the just-opened chip editor).
  const [draft, setDraft] = React.useState("");
  const [editDraft, setEditDraft] = React.useState("");
  const [editing, setEditing] = React.useState(null);
  const [error, setError] = React.useState("");
  const input = React.useRef(null);
  const editInput = React.useRef(null);
  React.useEffect(() => {
    if (editing === null) return;
    const node = editInput.current;
    if (!node) return;
    node.focus();
    node.select?.();
  }, [editing]);
  const fits = (next) => {
    if (next.length > MAX_PATTERNS || next.join("\n").length > MAX_SCHEME_TEXT) { setError(t("每项最多 64 个标签，总长度最多 8192 个字符。")); return false; }
    return true;
  };
  const commitAdd = () => {
    // While a chip editor is open it owns the edit; a blur of the trailing
    // input must not clobber it.
    if (editing !== null) return true;
    const source = draft.trim();
    if (!source) { setDraft(""); setError(""); return true; }
    const problem = patternProblem(source);
    if (problem) { setError(problem === "pattern-too-long" ? t("每条正则最多 512 个字符。") : t("正则表达式无效，请检查括号和转义。")); return false; }
    const next = [...patterns];
    if (next.length >= MAX_PATTERNS) { setError(t("每项最多 64 个标签。")); return false; }
    next.push(source);
    const unique = [...new Set(next)];
    if (!fits(unique)) return false;
    onChange(unique.join("\n")); setDraft(""); setError(""); return true;
  };
  const commitEdit = () => {
    if (editing === null) return true;
    const source = editDraft.trim();
    if (!source) { setEditing(null); setEditDraft(""); setError(""); return true; }
    const problem = patternProblem(source);
    if (problem) { setError(problem === "pattern-too-long" ? t("每条正则最多 512 个字符。") : t("正则表达式无效，请检查括号和转义。")); return false; }
    const next = [...patterns];
    next[editing] = source;
    const unique = [...new Set(next)];
    if (!fits(unique)) return false;
    onChange(unique.join("\n")); setEditing(null); setEditDraft(""); setError(""); return true;
  };
  const beginEdit = (index, source) => { setEditDraft(source); setEditing(index); setError(""); };
  const invalid = patterns.some((source) => problems.get(source));
  return <div style={{ minWidth: 0 }}>
    <div className="dsh-pattern-tags" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, minHeight: 28,
      border: `1px solid ${error || invalid ? "#e5484d" : "var(--dsh-ssh-ops-border, #3a414b)"}`, borderRadius: 6, padding: 4,
      background: "var(--dsh-ssh-ops-input, #101418)", opacity: disabled ? 0.55 : 1 }}>
      {patterns.map((source, index) => <span key={`${index}:${source}`} style={{ display: "inline-flex", alignItems: "center", maxWidth: "min(240px, 100%)", borderRadius: 4,
        background: "var(--dsh-ssh-ops-tab, #1a1f26)", border: "1px solid var(--dsh-ssh-ops-border, #3a414b)", outline: editing === index ? "1px solid currentColor" : undefined }}>
        {editing === index
          ? <input ref={editInput} data-tag-editor="" aria-label={t(`编辑 ${label} 标签 ${source}`)} value={editDraft} maxLength={MAX_PATTERN_LENGTH} spellCheck={false}
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => { setEditDraft(event.target.value); setError(""); }}
              onBlur={commitEdit}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") { event.preventDefault(); commitEdit(); }
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditDraft(""); setEditing(null); setError(""); }
              }}
              style={{ minWidth: 0, width: Math.min(190, Math.max(48, (editDraft.length + 1) * 7)), fontFamily: "monospace", fontSize: 11, lineHeight: "20px",
                padding: "0 5px", border: 0, outline: 0, background: "transparent",
                color: problems.get(source) ? "#e5484d" : "inherit" }} />
          : <button type="button" disabled={disabled} title={source} aria-label={t(`编辑 ${label} 标签 ${source}`)}
              onMouseDown={(event) => event.preventDefault()} onClick={() => beginEdit(index, source)}
              style={{ minWidth: 0, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "monospace", fontSize: 11, lineHeight: "20px", padding: "0 5px",
                border: 0, background: "transparent", color: problems.get(source) ? "#e5484d" : "inherit", cursor: "text" }}>{source}</button>}
        <button type="button" disabled={disabled} aria-label={t(`删除 ${label} 标签 ${source}`)} onMouseDown={(event) => event.preventDefault()}
          onClick={() => { onChange(patterns.filter((_, i) => i !== index).join("\n")); setDraft(""); setEditing(null); setEditDraft(""); setError(""); input.current?.focus(); }}
          style={{ border: 0, background: "transparent", color: "var(--dsh-ssh-ops-muted, #8b93a1)", padding: "0 4px", fontSize: 12, cursor: "pointer", lineHeight: "20px" }}>×</button>
      </span>)}
      <input ref={input} data-pattern-input="" aria-label={t(`${label} 标签输入`)} disabled={disabled} value={draft} maxLength={MAX_PATTERN_LENGTH} spellCheck={false}
        placeholder={t("关键词或正则，Enter 添加")} onChange={(event) => { setDraft(event.target.value); setError(""); }}
        onBlur={commitAdd} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") { event.preventDefault(); commitAdd(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(""); setError(""); }
          if (event.key === "Backspace" && !draft && patterns.length) { beginEdit(patterns.length - 1, patterns.at(-1)); }
        }}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text");
          if (!pasted.includes("\n")) return;
          event.preventDefault();
          const added = splitPatterns(pasted);
          if (added.some(patternProblem)) { setError(t("正则表达式无效，请检查括号和转义。")); return; }
          const next = [...patterns, ...added];
          const unique = [...new Set(next)];
          if (!fits(unique)) return;
          onChange(unique.join("\n")); setDraft(""); setError("");
        }}
        style={{ flex: "1 1 110px", minWidth: 80, width: 110, border: 0, outline: 0, padding: "3px 4px", fontFamily: "monospace", fontSize: 11, lineHeight: "20px", color: "inherit", background: "transparent" }} />
    </div>
    {(error || invalid) && <div role="alert" style={{ color: "#e5484d", fontSize: 11, marginTop: 5 }}>{error || t("存在无效正则，请点击标签修改。")}</div>}
  </div>;
}
