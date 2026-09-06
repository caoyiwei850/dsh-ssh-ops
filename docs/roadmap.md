# dsh-ssh-ops 工程路线图（2026-09-06 工程化整备后）

本轮（0.2.20 之后、0.2.21 之前）已完成的工程优化与后续待办。调研基线：宿主 `deepseek-harness` 0.1.3-alpha.1（插件依赖面 rc.7 → 0.1.2-rc.1 零破坏）。

## 已决策事项（勿反复重议）

- **宿主统一授权流 / `settings.models.provider-card`：暂不采纳。** 设置页录入与 SSH 操作语境割裂（SSH 密码发生在终端工作流里）；面板自绘表单 + 宿主加密凭据库的现有模式保留。若宿主将来支持「面板内发起、原地弹出录入」再评估。
- **错误信封保持现状。** 插件从不向 wire 抛 `RemoteError`，领域错误全部以 `{ok:false, error:{code,message}}` 信封随成功响应传输，code 为 hyphen 风格（`no-connection` 等）。宿主 0.1.2 起的失败词表（`<domain>/<reason>` + `RemoteErrorDetailsMap`）仅约束"抛出去"的 wire 级失败；未捕获异常由网关折叠为 `gateway/internal`。信封是客户端 `api.js` 与全部测试的既定契约，风格性迁移收益低。
- **密码录入入口保留在插件面板**（同第一条）。

## 本轮已完成

- hermes 移植 WIP 整体 stash（`git stash` 名 `hermes-wip`），main 回到纯 DSH 线。
- 仓库卫生：`.gitignore`（`.DS_Store`/`__pycache__`/`package-lock.json.bak-*`）、bak 文件退跟踪、`test/manual/db-integration.mjs` 真实 IP/密钥路径改环境变量。
- 依赖基线：`@deepseek-ai/dsh-*` 显式固定 `0.1.2-rc.1`（原 `^0.1.0-rc.7` 被 semver 预发布规则锁死）、`@deepseek-ai/cordis` ^4.0.2。
- 测试：迁 `node --test`；`manifest.mjs` 挂链；新增 ssh-write（终端定向/press_enter/策略门）、credentials（保存→引用→解析→清除全链路）、sftp-tools、terminal-stream 四个测试文件；`batchRun` 并发上限 4。
- 终端流式推送：typert `mode:'stream'` 的 `terminalStream`（WebSocket mux 承载），客户端优先流式、断流回落 300ms 轮询；宿主心跳 15s。
- 架构：`registerTools` 拆到 `src/tools/`（ssh-session/sftp/tunnel/batch/db 五组）；exec 双实现合并为 `collectExecOutput`；终端输入状态机统一到 `src/terminal-input.js`；断线瞬态判定改 ssh2 error code（`src/net-errors.js`）；`fail()` 单源（`src/envelope.js`）；`sshConfigImport` 改 async 读；魔法数字收拢常量。
- 工具链：eslint flat config + .editorconfig + CI lint 步骤；策略文案单源（`src/policy-messages.js`）；`npm run bump:readme` 同步 README 版本串；README 补凭据使用建议。

## 待办（按优先级）

1. **真机回归**：本机 dsh web（0.1.3-alpha.1）上验证流式终端推送（连一台真实服务器，观察输出是否即时、断流是否回落轮询）。
2. **客户端 i18n 双语化**：SshPanel 终端提示（会话失效/退出）、工具 render 文案仍是硬编码中文；接入 locale.js zh/en 双轨。宿主策略文案已单源到 `src/policy-messages.js`，迁移时直接搬。
3. **SshPanel.jsx 拆分**（1686 行/17 个 useEffect）：拆 useConnection/useTerminal/useFiles hooks。
4. **凭据记录半区**：宿主 0.1.2 的 `CredentialKey`（`<scope>/<id>` 记录）比三个独立 CredentialRef 更适合 SSH profile 的多字段凭据打包，且 `listRecords()` 支持卸载清理。涉及老数据迁移，单独立项。
5. **ssh_write 补 connection_id 队列化压力测试**、隧道 `tunnel_*` 测试。
6. **SSH 资源分组功能**：`group` 字段已存储（hermes 侧已预留），DSH 面板 UI 尚无分组展示。
7. 版本 tag 缺口：v0.2.14/v0.2.15 有 CHANGELOG 无 tag，下次发版时在 README/CHANGELOG 加一句说明即可。

## 宿主版本升级备忘

- 凭据事件改名：监听凭据变化用 `credentials/reference-updated`（旧 `credentials/updated` 已废弃）。
- `dsh.client.external` / `dsh.client.immediately` 可优化首屏（xterm 目前打进 bundle）。
- 宿主 0.1.3 出站请求遵循 `HTTP_PROXY/HTTPS_PROXY`，隧道/DB 探测文档可提示。
- typert loader 按 `./typert` 导入结果做进程缓存：运行中新增导出需重启宿主。
