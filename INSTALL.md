# DSH Desktop 安装说明（AI / 自动化可执行）

> 本说明**仅针对 DSH Desktop 桌面版**（Electron 桌面应用）。DSH Desktop 使用 harness profile `web`，插件安装后必须**重启桌面应用**才生效。

## 0. 前置条件

- 已安装并运行 **DSH Desktop**。
- 已取得成品包 `dsh-ssh-ops-0.2.20.tgz`（来源：GitHub Releases 下载，或源码 `npm run pack:release` 构建产物 `release/` 下）。

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
dsh plugin --profile web add "<TARBALL>\dsh-ssh-ops-0.2.20.tgz"
```

若 `dsh` 不在 PATH，用：

```powershell
& $node $dsh plugin --profile web add "<TARBALL>\dsh-ssh-ops-0.2.20.tgz"
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

## 附：0.2.20 版本更新内容

1. **快捷命令页签**：SSH 面板增加独立「快捷命令」页签，内置常用运维模板，按名称或命令内容实时搜索；不会遮挡服务器标签或添加服务器按钮。
2. **轻量自定义命令**：页签默认只显示一枚「＋ 自定义」；按需展开紧凑表单，可创建全局、分组或单服务器命令，并在同一页签删除。点击命令仅填入终端、不自动执行。
3. **DSH Desktop 桌面版适配**：检测无边框窗口标题栏，SSH 面板顶端对齐侧栏「新会话」按钮上边沿，避免与系统关闭按钮重叠。
4. **多终端标签页**：多服务器标签 + 标签右侧 `×` 单独断开；面板顶部 `×` 仅隐藏面板；用标签条 `＋` 添加服务器。
5. **`ssh_write` 输入后回车**：新增 `press_enter`（默认 `true`），自动补 `\r`（回车 CR），使密码/`[Y/n]` 等 raw 模式提示可提交。
6. **`ssh_write` 指定终端执行**：可传 `connection_id` 指定目标终端（多服务器时明确要写哪台）；目标连接若无已开终端，自动打开一个再写入，不再出现「Sent 0 bytes」空写。

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
