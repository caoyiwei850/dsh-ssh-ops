# DSH 0.2.2-rc.1 兼容检查（2026-11-05）

## 版本事实

- GitHub 于 2026-11-04 13:07 UTC 发布 dsh-v0.2.2-rc.1，标记为 prerelease；不是稳定版 0.2.2。
- 相比 alpha.3，compare 返回四个提交，文件变化主要为 package.json 版本及 Cordis 供应商组件版本调整。
- 当前本机 Desktop 为 0.2.1-rc.5；插件以 link: 指向此工作区，版本仍为 0.4.3。
- 来源：https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1
- 差异：https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.2-alpha.3...dsh-v0.2.2-rc.1

## 接口结论

- 官方设置图标插槽 settings.section.icon 已在本地适配，同时保留旧宿主回退。需在新 Desktop 验证实际图标尺寸、深浅主题和热卸载。
- 本地更新入口已改为宿主插件管理页指引，保留可选服务注入。registry 安装的更新和恢复状态仍需通过新宿主完整验证；link 安装不能替代此验证。
- 当前使用 tools.register / defineTool；未调用变更的 tools.resolve / executable。systemPrompt.context 和 getContextOrder 仍存在。未使用 session projection 注册、agent/request 路由改写或 PTC bootstrap SSH helper。
- 未发现仅为此次 rc.1 必须修改 SSH/SFTP/数据库业务逻辑的证据。
- engines.dsh 和官方 peer 区间 >=0.1.5-alpha.1 不会仅因 rc.1 版本号而拒绝加载；区间放行不是运行兼容性的保证。

## 验证

在 /tmp/dsh-rc1-ssh-audit-20261105 隔离安装 Cordis 4.1.0 及 rc.1 的 tools、typert-protocol、storage-domain、credentials、storage、llm、agent、scope、session、system-prompt、user-approval、client-ui-slots。通过临时 Node loader 将 @deepseek-ai 导入指向这些包，未改工作区依赖或当前 Desktop。

运行 ask-gate、domain-records、typert-sync、client-apply-reentrancy、settings-nav-icon、remote-workspace-service、sftp-tools、ssh-write，共 9 个 Node 测试项通过。

限制：这些测试有模拟服务、槽位和执行对象；不是完整宿主端到端、真实 SSH 或 Desktop 界面验证。没有执行线上插件更新。

## 发布前待办

1. 增加或建立隔离的 rc.1 兼容检查环境，避免只依赖当前 0.1.2-rc.1 开发包和旧 Cordis 测试；同时维持声明支持的旧版回归。
2. 在新 Desktop 验证设置、终端、可选服务注入、官方图标及旧版回退；执行真实 SSH/SFTP 和审批批准、拒绝、取消流程。
3. 使用隔离 registry 安装验证宿主更新入口、正常更新、构建阻止、失败恢复和重启提示。
4. 更新 INSTALL 的过时版本/profile/path 说明、README 的已验证版本与发布说明。当前新增搜索、传输列表、更新入口替换及图标适配仍未发布。
5. 按用户约定，完成验证后再决定发布；许可切换不在当前范围。
