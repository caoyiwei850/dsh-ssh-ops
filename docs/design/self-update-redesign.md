# 自更新模块重新设计草案

## 目标

让操作者检查并更新 dsh-ssh-ops，使用宿主自身的插件管理能力处理安装和回滚。新实现应由公开的功能需求和宿主接口重新设计；不得以现有改编模块为实现模板。历史版本及其许可记录继续保留。

## 宿主能力

DSH 0.2.2-alpha.2 的 pluginManager 提供 `listVersions(name, options, signal)` 和 `updateBundle(name, version, options)`。前者返回已安装版本和较新版本及兼容性；后者验证版本、安装，并在支持热更新时尝试恢复旧版本。安装源非 registry、包不可更新或宿主不兼容时，服务可能拒绝操作。参考 https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/boot/plugin-manager/src/index.ts 。

## 拟定交互

- 设置页展示已安装版本和“检查更新”。检查由宿主列出可更新版本；未安装为 registry 包、宿主无此能力或查询失败时明确显示原因，并指引用户进入宿主插件管理页或使用手工更新。
- 操作者确认具体目标版本后，使用宿主更新接口。显示正在处理、成功、需重启、失败及旧版本恢复情况；绝不将更新失败或回滚失败显示成成功。
- 较旧宿主不提供 `updateBundle` 时只提供手工操作指引，不猜测进程参数，不绕过宿主包管理或 minimumReleaseAge 策略。
- 更新前说明宿主可能卸载当前插件并中断其连接；避免在活跃 SSH 任务中静默更新。

## 重要验证

1. 在真实目标 Desktop 上确认服务可从插件取得，检查实际宿主版本；不可只凭上游源码推断运行时组合。
2. 更新操作可能卸载当前插件：由本插件注册的 HTTP 路由和浏览器界面可能先于更新结果被销毁。应优先让宿主的插件管理页面负责执行和展示状态，或使用生命周期独立于本插件的宿主接口；禁止把插件自身的回调仍能存活当成保证。
3. 覆盖 registry 安装、link/git 安装、版本不兼容、宿主不支持、查询失败、更新失败与恢复失败。验证同时发起请求和权限边界。
4. 核查设置页 UI、测试与其他文件中标注来源的材料；仅改写文件或删除来源注释不能证明独立实现。完成版权及第三方许可审查后再作声明。
5. 保留历史 Apache-2.0 来源及旧发行版记录。MongoDB 等其他依赖的许可另行管理。

## 隔离验证记录（2026-10-31）

- 当前安装的 Desktop `0.2.1-rc.5`：从应用的 `app.asar` 检查实际插件管理器产物，仅发现 `installBundle`，未发现 `listVersions`、`updateBundle`。
- 使用 npm 发布的 `@deepseek-ai/dsh-plugin-manager@0.2.2-alpha.2` 在临时 profile 启动真实服务：`link:` 安装的包被 `listVersions` 和 `updateBundle` 拒绝；模拟已安装的 registry 版 `dsh-ssh-ops@0.4.2` 可查询到 0.4.3。
- 非热更新 profile，未放行 `cpu-features` 与 `ssh2` 构建脚本：安装返回 `build-blocked`，profile 依赖仍为 0.4.2。放行后，pnpm 安装 0.4.3 成功，宿主返回 `restart-required / no-hmr`；可选原生构建因隔离环境缺 node-gyp 失败，未验证新插件重启后加载。
- 热更新 profile，未放行构建脚本：更新 0.4.3 失败，自动恢复 0.4.2 也因相同限制失败，profile 依赖项最终不存在。用测试插件的生命周期回调确认它在更新结束前被卸载。因此不能依赖目标插件自己的路由或界面显示最终结果。
- 测试仅作用于临时 profile；没有更新当前 Desktop 的 link 安装。以上结果不能保证其他宿主版本或环境行为一致。
