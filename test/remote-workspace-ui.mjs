// Remote workspace (issue #38), source-level wiring: where the editor lives,
// the three panel RPCs across api/descriptors/typert, the two-tab resource
// dialog that keeps the form from growing, and the sentence that keeps the
// boundary honest — sftp_* moves to the remote root, the native file tools do
// not. No DOM here, matching the repo's client-suite style.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const panel = await read("src/client/SshPanel.jsx");
const resources = await read("src/client/SshResources.jsx");
const workspaces = await read("src/client/ResourceWorkspaces.jsx");
const api = await read("src/client/api.js");
const descriptors = await read("src/descriptors.js");
const typert = await read("src/typert.js");
const messages = await read("src/i18n/messages.en.js");

// ── it lives beside 默认项目目录, not as an SSH panel tab ────────────────────
assert.match(resources, /import \{ ResourceWorkspaces \} from "\.\/ResourceWorkspaces\.jsx"/, "the resource editor mounts the workspace binder");
assert.doesNotMatch(panel, /SshWorkspaces|workspaces/, "the SSH panel no longer carries a workspaces tab");
assert.match(resources, /<ResourceWorkspaces api=\{api\} profileId=\{form\.profileId\} projectPath=\{form\.defaultProjectPath\} \/>/, "the binder is scoped to the resource being edited and sees its project directory");

// ── the dialog is two tabs, so it stops growing without bound ──────────────
assert.match(resources, /const \[formTab, setFormTab\] = useState/, "the editor tracks an active tab");
assert.match(resources, /\{formTab === "basic" && <>/, "基本 holds the coordinates and credentials");
assert.match(resources, /\{formTab === "advanced" && \(/, "高级选项 holds the rare knobs");
assert.match(resources, /t\("基本"\)/, "the first tab is labelled 基本");
assert.match(resources, /t\("高级选项"\)/, "the second tab is labelled 高级选项");
assert.match(resources, /资源信息与高级选项/, "the tab strip is announced for assistive tech");
assert.doesNotMatch(resources, /advancedOpen/, "the old collapse toggle is gone");

// ── three RPCs, wired the same way in every layer ──────────────────────────
for (const name of ["remoteWorkspaceList", "remoteWorkspaceSave", "remoteWorkspaceDelete"]) {
  assert.match(api, new RegExp(`\\b${name}\\(`), `${name} is on the panel API surface`);
  assert.match(api, new RegExp(`this\\.call\\("${name}"`), `${name} reaches the host RPC`);
  assert.match(descriptors, new RegExp(`def\\("${name}"`), `${name} is registered as an RPC`);
  assert.match(typert, new RegExp(`name: "${name}"`), `${name} is declared for the typed transport`);
}
assert.match(descriptors, /remoteWorkspaceSaveRequestSchema/, "the save RPC validates its request");
assert.match(descriptors, /remoteWorkspaceDeleteRequestSchema/, "the delete RPC validates its request");

// ── the UI says what the binding does and does not do ──────────────────────
assert.match(workspaces, /sftp_\*/, "the hint names sftp_* as the remote path");
assert.match(workspaces, /read\/write\/glob\/grep/, "the hint names the native tools that stay local");
assert.match(workspaces, /本地 bash/, "the hint warns that bash is still local");
assert.match(workspaces, /自动连接/, "auto-connect is an explicit, labelled choice");
assert.match(workspaces, /已连接/, "a binding shows whether its server is live");
assert.match(workspaces, /setAllBindings\(all\)/, "the editor sees bindings owned by other SSH resources too");
assert.doesNotMatch(workspaces, /disabled=\{bindingByPath\.has\(workspace\.path\)/, "a workspace bound to another resource can be selected for replacement");
assert.match(workspaces, /远端绝对路径/, "the remote root must be absolute");
assert.doesNotMatch(workspaces, /绑定后该工作区里的 sftp_/, "the long explainer paragraph is gone");
// The two fields keep separate meanings, but the operator never retypes the
// path: the resource's 默认项目目录 is offered as a one-click fill.
assert.match(workspaces, /projectPath/, "the binder accepts the resource's project directory");
assert.match(workspaces, /t\(`填入默认项目目录：\$\{suggestion\}`\)/, "the project directory can be filled in with one click");
assert.match(workspaces, /projectSuggestion !== form\.remotePath\.trim\(\)/, "the fill is hidden once the field already matches");

// ── every literal the tab renders has an English entry ─────────────────────
for (const key of ["基本", "高级选项", "远程工作区", "选择工作区…", "自动连接", "解除", "修改", "绑定"]) {
  assert.match(messages, new RegExp(`"${key}":`), `messages.en.js translates ${key}`);
}

console.log("remote workspace ui: tab wiring, three RPCs and the local/remote boundary passed");
