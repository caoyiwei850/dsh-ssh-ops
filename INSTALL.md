# DSH Desktop 安装说明（AI / 自动化可执行）

> 本说明**仅针对 DSH Desktop 桌面版**（Electron 桌面应用）。DSH Desktop 使用 harness profile `web`，插件安装后必须**重启桌面应用**才生效。

## 0. 前置条件

- 已安装并运行 **DSH Desktop**。
- 已取得成品包 `dsh-ssh-ops-0.3.7.tgz`（来源：GitHub Releases 下载，或源码 `npm run pack:release` 构建产物 `release/` 下）。

### 兼容性

- 目标为 DSH Desktop / Web Profile `0.1.6` 系列；已验证 `0.1.6-alpha.1`。
- 提供 `sidebarRightTabs` 和 `sidebarRight` 的宿主使用官方右侧 SSH 标签；旧宿主会自动回退到浮动面板。
- 上传／下载字节流需要 Web Profile 的 `webServer` 与请求来源校验服务；不具备时保留既有 SFTP 操作。目录归档下载被有意禁用并返回 `501`，防止 SFTP chroot 与 SSH shell 命名空间不一致。

## 1. 定位 `dsh` 命令行

DSH Desktop 不保证 `dsh` 在系统 PATH 上。先探测：

```powershell
dsh --version
```

- 若打印版本号 → 直接进入第 2 步，命令用 `dsh ...`。
- 若报「无法识别 dsh」→ 改用桌面应用捆绑的 node + dsh bin，先定义变量（按实际安装目录替换 `<INSTALL_DIR>`）：

```powershell
$node = "<INSTALL_DIR>\DSH Desktop\resources\app\node_modules\node\bin\node.exe"
$dsh  = "<INSTALL_DIR>\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
```

> 本机示例：`<INSTALL_DIR>` = `G:\desktop-dsh`。

## 2. 安装插件

把 `<TARBALL>` 替换为 tgz 的绝对路径。

```powershell
dsh plugin --profile web add "<TARBALL>\dsh-ssh-ops-0.3.7.tgz"
```

若 `dsh` 不在 PATH，用：

```powershell
& $node $dsh plugin --profile web add "<TARBALL>\dsh-ssh-ops-0.3.7.tgz"
```

## 3. 校验安装结果

安装成功应满足全部 3 条（Windows 下 profile 目录为 `%APPDATA%\dsh-desktop\harness\profiles\web`）：

1. `profiles\web\package.json` 的 `dependencies` 含 `"dsh-ssh-ops"`；
2. 同一文件 `dsh.profile.bundles` 数组含 `"dsh-ssh-ops"`；
3. `profiles\web\node_modules\dsh-ssh-ops\lib\` 下存在 `index.js` 与 `client.js`。

## 4. 重启 DSH Desktop（必做，不可省略）

- 完全退出：系统托盘 → DSH Desktop 图标 → 右键 → **退出**；
- 重新打开 DSH Desktop。

（重启后 harness 才会加载新插件的 host 半；不重启插件不生效。）

## 5. 验证插件已加载

1. 打开任意会话，顶部标签区出现 **SSH** 按钮；
2. 点 **SSH** → 右侧出现 SSH 面板，可点 `＋` 连接服务器；
3. 在对话里要求 `ssh_write` 输入并回车，确认工具带 `press_enter` 参数（默认 `true`）。

## 6. 卸载 / 回滚

```powershell
dsh plugin --profile web remove dsh-ssh-ops
```

（或手动：从 `profiles\web\package.json` 移除 `dsh-ssh-ops` 依赖与 `bundles` 条目，然后重启 DSH Desktop。）

---

## 附：0.3.7 版本更新内容

1. **DSH 0.1.6 兼容**：已在 `0.1.6-alpha.1` 验证，并声明对应宿主 peerDependencies。
2. **主题可读性**：浅色模式的文件、转发、数据库、快速连接面板，以及深色模式的 SSH 资源／共享凭据表单均提升文字、输入框和按钮对比度。
3. **SFTP 符号链接**：指向目录的链接会按目录打开，不再尝试下载并仅显示泛化的 `Failure` 错误。

## 附：本地模拟测试（无远端服务器时）

用仓库内 `test-sshd.mjs` 在 `127.0.0.1` 起本地 SSH 服务器（插件自带 ssh2，零依赖）：

```powershell
node test-sshd.mjs 2222     # 服务器 A，端口 2222
node test-sshd.mjs 2223     # 服务器 B，端口 2223（测多标签）
```

- 用户名任意，密码 `test123`；
- 主机密钥持久化在 `test-sshd-hostkey.pem`，重启不变，避免反复触发指纹校验；
- 自检：`node test-client.mjs 2222`（连接 + exec + shell 回车）。

在 DSH Desktop 里连接 `127.0.0.1:2222`（用户名 `test` / 密码 `test123`）即可离线验证终端、多标签、`ssh_write` 回车等。
