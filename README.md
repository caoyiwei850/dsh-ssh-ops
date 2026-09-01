**中文** · [English](./README.en.md)

---

# DSH SSH Ops

> DeepSeek Harness 的 SSH 运维插件：在主对话中驱动当前服务器，同时在右侧保留真实的交互式终端，并集成文件管理、端口转发与数据库管理。

![License](https://img.shields.io/badge/license-MIT-green)
![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)
![version](https://img.shields.io/badge/version-0.2.19-blue)

> **v0.2.19 新增**：DSH Desktop 桌面版界面适配、多终端标签页、`ssh_write` 输入后自动回车（`press_enter`）。桌面版安装说明见 **[INSTALL.md](./INSTALL.md)**。

## 示例

主对话直接指挥已连接的服务器，右侧保留真实交互式终端，支持文件管理（SFTP）、端口转发与数据库管理：

![SSH 主界面](https://raw.githubusercontent.com/caoyiwei850/dsh-ssh-ops/main/assets/screenshots/ssh-main-view.png)

![文件管理（SFTP）](https://raw.githubusercontent.com/caoyiwei850/dsh-ssh-ops/main/assets/screenshots/ssh-files-tab.png)

![端口转发](https://raw.githubusercontent.com/caoyiwei850/dsh-ssh-ops/main/assets/screenshots/ssh-tunnels-tab.png)

![数据库管理界面](https://raw.githubusercontent.com/caoyiwei850/dsh-ssh-ops/main/assets/screenshots/db-panel.png)

![SSH 资产管理](https://raw.githubusercontent.com/caoyiwei850/dsh-ssh-ops/main/assets/screenshots/ssh-resources.png)

## 能做什么

- 在会话右侧打开可调整宽度的 xterm.js SSH 终端；与 **DSH-better-sidebar** 同时启用时，终端会自动停靠在侧栏左边，不会覆盖文件侧栏或右上角控制按钮。
- 在 **设置 → 插件 → SSH 资源** 中管理任意数量的服务器和分组；顶部的 **SSH** 仅显示或隐藏右侧终端。
- 服务器名称、地址、端口、用户名、认证类型和分组保存到 DSH 本地存储；数量不设上限。
- 密码、PEM 私钥和私钥口令仅保存到 DSH 官方本机凭据库 `~/.dsh/.credentials.yaml`（owner-only 权限）；浏览器存储、Agent 上下文、工具结果和资源列表均不会读取或显示秘密内容。
- 主对话自动识别当前右侧已连接服务器，无需向用户索取内部连接 ID。
- Agent 发出的 `ssh_exec` 命令会显示在右侧终端，并将退出码、输出、耗时、超时和截断状态回传给主对话分析。
- 对手动终端输出提供按需 `ssh_read` 读取；不会静默把人工终端内容塞入对话上下文。
- 输出给模型前会脱敏私钥、Bearer Token、常见密码/API Key（含裸 `sk-` 开头的密钥）和数据库连接口令。
- **连接稳定性**：SSH 连接启用 keepalive（20 秒间隔、3 次判定），NAT/防火墙不再静默丢弃空闲连接；传输意外断开后指数退避自动重连（上限 30 秒），命令中途掉线透明重试一次，瞬时连接失败自动重试 3 次（认证失败除外）；显式断开或插件卸载不触发重连，重连后远程隧道自动重新注册。
- **主机指纹校验（TOFU）**：SSH 连接校验服务器主机公钥指纹——首次连接记录并信任，之后指纹变化即拒（防中间人 / 误连重装机）。每台服务器可选 `accept-new`（默认）/`verify`（拒绝未知）/`off`；指纹变化时**不重试、不自动重连**，提示用「忘记指纹」重置。设置 → SSH 资源可按服务器设置校验模式、管理已信任指纹并一键忘记。校验在用户认证前，与登录账号/密码无关，同一台服务器换人登录不会被挡。
- **文件管理**：SSH 面板「文件」页签，基于 SFTP 浏览服务器目录树，支持上传、下载、新建目录、删除与重命名；对话中也可用 `sftp_*` 工具直接操作。
- **端口转发**：SSH 面板「转发」页签，可建立本地转发（本机 → 服务器可达目标）与远程转发（服务器 → 本机），实时查看与停止隧道；对话中也可用 `tunnel_*` 工具。
- **多机批量**：主对话说「批量执行 <命令>」，Agent 创建批量任务，右侧 SSH 面板弹出勾选弹窗，列出 SSH 资源中已保存的全部服务器（**含未连接的**）供手动勾选，确认后并发执行（每台用保存凭据建连 → 执行 → 断开），结果按服务器分节展示（成功绿 / 失败红）。批量目标与当前打开的连接完全无关，可勾选未连接的服务器；命中安全策略时「命令 + N 台目标」一次性确认，不再逐台弹窗。旧的 `ssh_cluster`（基于已打开连接、无需确认即群发）已彻底移除：多机操作只能经 `ssh_batch` 由操作者勾选确认，杜绝「点名一台、全量执行」。
- **数据库**：SSH 面板「数据库」页签，支持连接 MySQL / PostgreSQL / Redis / MongoDB，可手动执行 SQL 查询或命令并查看结果表格；对话中也可用 `db_*` 工具直接操作。
  - 支持 `db_connect` 自动 SSH 隧道：连了服务器后，回环地址（127.0.0.1 / localhost / ::1）的数据库自动经当前服务器隧道访问内网库；`via_ssh` 可选 `auto`（默认）/`yes`/`no`，显式 `ssh_connection_id` 优先级最高。
  - 支持 SSL 三档（`disabled` 不加密 / `preferred` 加密不验证 / `verify` 加密+验证 CA）适配云托管数据库。
  - 数据库连接可保存为资源（profile），重启后一键重连；密码加密存储于 DSH 凭据库；已保存资源支持重命名与折叠分组。
  - **工程化闭环**：`db_query` 词法级真只读闸（只放行 SELECT/SHOW/DESCRIBE/EXPLAIN/纯查询 WITH，拦截写动词子查询、PG 数据修改 CTE、`SELECT INTO`、`FOR UPDATE` 锁读）；查询流式截断 200 行 + 30s 超时（MySQL destroy 池连接、PG 用 cursor 分批取）；交互式事务工作流 `db_tx_begin/execute/commit/rollback`（独占连接、变更后验证、闲置 5 分钟自动回滚）；`db_describe_table` 带索引/外键/DDL/行数与容量估计；`db_preview` 分页采样、`db_explain` 执行计划。数据库面板含表树、预览视图、一键导出 CSV（含 BOM，Excel 中文兼容）、查询历史（localStorage 50 条）。DB 传输层意外断开不再崩进程（四类客户端统一处理，绝不 throw）。
  - 高危 SQL（`DROP DATABASE`/`SCHEMA`/`TABLE`、`TRUNCATE`、`SHUTDOWN`）自动拦截，按**语句动词**识别（跳过字符串/注释、支持多语句），不会误杀字符串字面量里的关键字。

## 安全边界

DSH 自身权限机制仍然有效。本插件额外阻止 Agent 工具执行明显不可逆或破坏性操作，例如删除文件、删库、格式化磁盘、`terraform destroy`、`kubectl delete`、`docker prune`、强制 Git 清理以及重启/关机。

Agent 命中上述黑名单时不会被静默拒绝：插件会创建一条一次性的**待确认**记录，并立即在整个视口**弹出确认模态**（含完整命令、风险原因与「执行 / 撤销」按钮；Esc、点遮罩或「稍后在面板中处理」可暂时收起，全部处理完自动关闭；面板重开时仍未处理的会再次弹出）。未处理项同时常驻在右侧 SSH 面板「终端」窗口上方，卡片默认折叠为单行摘要（命令 + 主机名 + 常驻执行/撤销按钮），最新一条自动展开，点击展开风险说明与完整命令。只有操作者点击红色「执行」才会将命令发送到服务器（自动追加回车）；「撤销」清除该记录。危险命令**不再预填到终端命令行**——输入行始终为空，操作者不可能因误按回车而执行。多条危险命令作为独立卡片排队。若当时没有活跃的终端会话、或命令含 Tab 等无法安全发送到 PTY 的控制字符，则降级为在对话中返回一张可复制的命令卡片，供操作者粘贴到终端执行。普通运维操作（配置 SSL、安装软件包、修改配置、重载服务等）可以正常通过 DSH 的权限流程执行。

同样的模型覆盖 `sftp_delete`（不再由 Agent 直接删，改为将等价 `rm -rf <路径>` 加入待确认队列）和 `db_execute` 的高危 SQL（`DROP`/`TRUNCATE`/`SHUTDOWN`）：高危 SQL 保持现有模式，返回带 ```sql 代码块的卡片，供操作者粘贴到数据库面板的 SQL 编辑器手动执行。SQL 判断按**语句动词**识别（跳过字符串/注释、支持多语句、按 `;` 切分），不会误杀字符串字面量里的关键字，高频增删改查正常放行。

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:caoyiwei850/dsh-ssh-ops#v0.2.19
```

安装后重启 DSH Web：

```bash
dsh web
```

然后打开任意会话，点击顶部的 **SSH** 标签，使用右侧面板连接服务器。

### 从发布压缩包安装

从 [GitHub Releases](https://github.com/caoyiwei850/dsh-ssh-ops/releases/tag/v0.2.19) 下载 `dsh-ssh-ops-0.2.19.tgz` 后：

```bash
dsh plugin --profile web add /path/to/dsh-ssh-ops-0.2.19.tgz
dsh web
```

`dsh-ssh-ops-0.2.19.zip` 适用于离线审阅或二次开发；解压后可在目录中执行 `npm install && npm run build`。

## 使用方式

1. 打开 **设置 → 插件 → SSH 资源**，新建分组或服务器资源；PEM / `.key` 文件可直接导入。
2. 保存的资源可直接“连接并打开”，并自动创建右侧 PTY 终端。编辑时秘密字段留空会保持原值；清除凭据需要显式确认。
3. 顶部 **SSH** 仅控制右侧终端的显示和隐藏；右上角 `+` 可选择已保存资源，或创建不落盘的临时连接。
4. 在主对话中直接说“查询服务器内存使用情况”或“配置 Nginx SSL 证书”。主 Agent 只能操作当前活动连接，不能枚举保存资源、读取凭据或自动用保存凭据连接。
5. 需要数据库时，让 Agent 调 `db_connect`（或自己在「数据库」页签新建连接），随后即可在对话中查询/执行。
6. 可选：安装内置「运维模式」原生预设：`npx --package=dsh-ssh-ops dsh-ssh-ops-install-ops-preset`。重启 DSH 后，在新对话中选择「运维模式」。已存在同名预设时安装器不会覆盖；要用包内版本更新可加 `--force`。

### 运维 Agent 预设

插件随包提供 DSH 原生「运维模式」预设（`.agent-presets/ops`）：它去除了本地 shell，保留本地文件编辑；服务器操作经 dsh-ssh-ops 的 SSH/SFTP/隧道/批量/数据库工具完成，并附带 `test-op` 变更验证技能。预设采用显式安装与选择，不会自动改写全局 persona 或已有会话。

### Agent 工具

共 29 个 Agent 工具，省略 `connection_id` / `db_connection_id` 时默认作用于当前活动连接，**无需先调 `ssh_list` / `db_list_connections`**。

#### SSH（6）

| 工具 | 用途 |
| --- | --- |
| `ssh_list` | 查看当前活动连接的安全元数据（不包含保存资源或秘密）；仅在用户问“连了哪台”时用 |
| `ssh_connect` | 建立 SSH 连接（密码或私钥）并设为当前服务器 |
| `ssh_exec` | 在当前服务器执行 Agent 命令，回传退出码/输出/耗时/超时/截断/脱敏状态 |
| `ssh_read` | 按需读取右侧终端缓冲输出（不静默塞入对话） |
| `ssh_write` | 向指定终端写入交互输入；`press_enter`（默认 true）自动补回车提交（可传 `connection_id` 指定目标服务器的终端） |
| `ssh_disconnect` | 断开当前连接及其 shell 会话 |

#### SFTP（6）

| 工具 | 用途 |
| --- | --- |
| `sftp_list` | 列出远程目录条目（含大小/mtime/权限） |
| `sftp_read` | 读取远程文件内容（默认上限 4 MiB） |
| `sftp_write` | 写入远程文件（创建或覆盖） |
| `sftp_mkdir` | 新建远程目录 |
| `sftp_delete` | 删除远程文件或空目录（**不直接执行**，改为把 `rm -rf <路径>` 加入待确认队列或返回可复制卡片） |
| `sftp_rename` | 重命名/移动远程路径 |

#### 端口转发（3）

| 工具 | 用途 |
| --- | --- |
| `tunnel_start` | 建立本地转发（`local`，本机 → 服务器可达目标）或远程转发（`remote`，服务器 → 本机） |
| `tunnel_list` | 列出活动隧道 |
| `tunnel_stop` | 按 `tunnel_id` 停止隧道 |

#### 批量执行（1）

| 工具 | 用途 |
| --- | --- |
| `ssh_batch` | 基于 SSH 资源中已保存服务器（含未连接的）创建批量执行任务，由操作者在面板勾选确认后并发下发，结果按服务器分节；**仅当用户明确要求多机批量时使用**（旧的 `ssh_cluster` 已彻底移除，多机操作无免确认路径） |

#### 数据库（14）

| 工具 | 用途 |
| --- | --- |
| `db_connect` | 连接 MySQL / PostgreSQL / Redis / MongoDB；回环地址自动经当前 SSH 服务器隧道，SSL 三档可选 |
| `db_list_connections` | 列出已打开的数据库连接（仅用户询问时用） |
| `db_query` | 在 MySQL/PostgreSQL 上跑**词法级强制只读**查询（仅放行 SELECT/SHOW/DESCRIBE/EXPLAIN/纯查询 WITH；拒绝写动词、`SELECT INTO`、`FOR UPDATE` 锁读、数据修改 CTE）；结果流式截断 200 行，30s 超时；支持 `?` / `$1` 占位符 |
| `db_execute` | 执行写语句（INSERT/UPDATE/DELETE/CREATE/ALTER）；高危 SQL（DROP/TRUNCATE/SHUTDOWN）不执行，返回可复制卡片 |
| `db_list_tables` | 列出 MySQL/PostgreSQL 当前 schema 的表 |
| `db_describe_table` | 完整表结构：列、索引、外键、行数/容量估计、MySQL 附 `SHOW CREATE TABLE` DDL |
| `db_preview` | 按表名分页采样数据（LIMIT/OFFSET 参数绑定，标识符白名单防注入），附全表行数估计，无需手写 SQL |
| `db_explain` | 查看查询执行计划（EXPLAIN FORMAT=JSON），检查索引使用 |
| `db_tx_begin` / `db_tx_execute` / `db_tx_commit` / `db_tx_rollback` | 交互式事务工作流：开事务 → 执行变更 → SELECT 验证 → 提交/回滚（独占连接，闲置 5 分钟自动回滚） |
| `db_run` | 在 Redis 上跑命令（`command`+`args`），或在 MongoDB 上跑 `find`/`findOne`/`insertOne`/`updateOne`/`deleteOne`/`countDocuments` |
| `db_disconnect` | 关闭数据库连接 |

> `db_query` 用于 SQL 只读查询，`db_execute` 用于 SQL 写操作，`db_run` 用于 Redis/MongoDB。MySQL 用 `?` 占位符、PostgreSQL 用 `$1` 占位符。

## 开发

```bash
npm install
npm test
npm run build
npm run pack:release
```

推送与 `package.json.version` 一致的 `vX.Y.Z` tag 时，GitHub Actions 会测试、构建并从同一个 `.tgz` 同时发布 npm 包和 GitHub Release。首次启用前，在仓库 Secrets 配置 `NPM_TOKEN`。

生成物位于 `release/`：

- `dsh-ssh-ops-0.2.19.tgz`：可直接被 DSH 安装。
- `dsh-ssh-ops-0.2.19.zip`：完整离线源码包。

## 许可

[MIT](LICENSE)
