# Changelog

## 0.2.20 - 2026-09-02

- **快捷命令库**：SSH 面板新增独立「快捷命令」页签，默认即显示可按名称或命令内容实时过滤的内置命令，不遮挡服务器标签或新建连接入口；再次点击该页签可回到终端。提供系统巡检、服务、Docker、日志、网络、磁盘、计划任务及 Ubuntu/RHEL/CentOS 安装更新模板；有影响的模板明确标记「会变更」。页签内用紧凑「＋ 自定义」按需展开表单，可保存全局、分组或单服务器命令，并在原处删除；点击任一命令仅填入终端输入行、不自动执行。命令保存在本机浏览器存储，界面禁止保存 sudo 密码、Token 或其他秘密。

## 0.2.19 - 2026-09-01

- **DSH Desktop 桌面版界面适配**：检测无边框窗口（Windows `titleBarOverlay` 36px 标题栏 / macOS 拖拽区），SSH 面板顶端运行时对齐侧栏「新会话」按钮上边沿，使面板顶部 `＋`/`×` 落到标题栏下方，不与系统「最小化/最大化/关闭」按钮重叠。
- **多终端标签页**：支持同时连接多台服务器，每台一个标签，标签右侧 `×` 单独断开、点标签切换终端（终端常驻、切换保留回看）；删除「打开终端/关闭终端」按钮，连接成功后自动开终端；面板顶部 `×` 改为仅隐藏面板不断开连接；会话自然退出后从连接活跃集合移除，标签可重开终端。
- **`ssh_write` 输入后回车**：新增 `press_enter`（默认 `true`），为 true 且输入末尾非换行时自动追加 `\r`（回车 CR）。物理回车键产生 `\r`，raw 模式提示（密码、`[Y/n]`、跳板机二次登录）只认 `\r` 不认 `\n`，故补齐 `\r` 使交互输入可提交。
- **修复**：设置页「连接并打开」成功路径清空面板残留错误（此前 host-key 变化等失败后成功重连，错误栏不消失）。
- **`ssh_write` 指定终端执行**：可传 `connection_id` 指定目标终端；目标连接无已开终端时自动打开 PTY 再写入（消除 "Sent 0 bytes" 空写）。
- **连接对话框「保存并连接」**：临时连接表单可直接保存为 SSH 资源并连接（凭据写入本机 DSH 凭据库）；面板注入 credentials 服务。
- **移除面板右上角冗余 `＋`**：连接对话框改由服务器标签条 `＋` 打开。
- 附本地测试工具 `test-sshd.mjs` / `test-client.mjs`（用 ssh2 起本地 SSH 服务器，密码 `test123`，主机密钥持久化），与 `INSTALL.md` 安装说明。

## 0.2.18 - 2026-08-31

- **对照 DSH 插件开发规范的全量评审与加固**（规范源自宿主 docs/defensive-patterns、capability-seams、cordis-primer、cookbook 及 typert/credentials/storage-domain/client 各包 README）：
  - **db_query 只读闸堵住 MySQL 版本注释绕过**：`/*!50000 DELETE … */` 会被服务器原样执行，此前 scanTokens 把它当普通注释整体跳过；现在 `/*!` + 数字版本号的内容按 SQL 词法扫描，普通注释与优化器 hint 行为不变（新增 3 个拦截用例，原注释豁免用例回归通过）。
  - **崩溃类隐患清零**：DB 隧道 net.Server 在 listen 成功后重挂常驻 error 监听（accept 阶段错误不再可能成为无监听 `error`）；redis `connect()` 失败路径补 `disconnect()` 终止 node-redis 无限自动重连。
  - **客户端资源回收**：`apply()` 此前丢弃三处 `slots.inject` 返回的 disposer、locale 注册不回滚，现全部收进 disposers（HMR/禁用时不再泄漏槽位）。
  - **原生运维 Agent 预设**：随包提供本地已验证的「运维模式」完整 DSH 预设（无本地 shell、保留本地文件编辑、SSH/SFTP/隧道/批量/数据库工具边界，及 `test-op` 验证技能）；通过显式安装器写入用户的 DSH 预设目录，不自动改写全局 persona。
  - **XtermView 长轮询加固**：错误路径指数退避（0.5s→4s 封顶），杜绝传输故障时零延迟请求风暴/微任务自旋；`await` 之后复查 `alive`，卸载后不再写已 dispose 的 xterm 或触发 setState；按键写队列在卸载后直接丢弃。
  - **× 断开不再被「重新收养」撤销**：`refreshConnections` 的自动重绑定只在恢复场景生效（页面刷新后回收僵尸连接），显式断开路径传 `adopt:false`——两台连接时点 × 断开一台后，不会悄悄把另一台设为活动连接。
  - **资源页轮询不闪烁**：5 秒轮询不再翻转 loading 旗标（此前列表每 5 秒整页卸载重挂、丢失滚动位置）。
  - **api 信封防御**：RPC 信封形状异常时抛带错误码的 `SshApiError` 而非 TypeError；传输层错误码透传（`no-session` 等可区分）；`read` 的 `data` 缺失不再 `atob(undefined)`。
  - **文件页竞态**：目录列表加单调序号守卫（慢响应不再覆盖新目录）；上传/删除/重命名完成后刷新当前目录而非快照回跳；migrate 过滤空 host 的 localStorage 遗留数据。
  - **SCP 兼容传输**：SFTP 子系统无法打开时，文件页自动进入 SCP 兼容模式；仅按远端完整路径支持单文件上传/下载，目录浏览与管理仍由 SFTP 独占。
  - **数据库面板**：⌘↵ 在表格预览模式不再执行编辑器里隐藏的 SQL（隐性写操作风险）；查询历史改用 `type:host:port:database:username` 稳定键（原运行时连接 id 每次重连都换，历史读不回且 localStorage 无限累积；不同账号互不混用）；切换连接时 QueryPane 以 `key` 重挂（结果区不再串台）；侧栏拖拽 window 监听器补卸载清理。
  - **SSH 顶栏按钮观察器节流**：MutationObserver 回调以 rAF 合并（此前聊天流式渲染时每次 DOM 变更都全页扫 tablist）。
  - 已知保留项：`cancelConnect` 与「服务器恰好已完成握手」的竞态（取消后连接仍可能建立，最优努力语义）；面板英文 locale 字典未接线（面板暂为中文专用）。

## 0.2.17 - 2026-08-31

- **修复文件上传/下载二进制损坏**：客户端此前把文件内容当 UTF-8 文本处理（上传 `file.text()`、下载经 `TextDecoder` 再进 Blob），图片/压缩包等二进制文件必损坏。改为字节级 base64（`encodeBase64Bytes`/`decodeBase64Bytes`，`Uint8Array` 直传，不再经过文本解码），宿主端协议不变。已实测上传二进制文件完好，并以字节级往返回归测试固化。
- **临时连接私钥预检**：面板快速连接（临时连接）此前不做私钥格式校验，截断粘贴要到连接时才报认证失败；现与 SSH 资源编辑器共用 `privateKeyProblem` 预检，并补齐三类新拦截：空壳 key（只有 BEGIN/END 无主体）、首尾行类型不匹配、主体含非法字符（传统加密 PEM 的 `Proc-Type:`/`DEK-Info:` 头不误伤）。主表单与跳板机私钥一并覆盖。
- **彻底移除 `ssh_cluster_deprecated`**：该工具基于「所有已打开连接」群发命令且无需操作者确认，实际事故中用户点名升级一台、两台同时被升级（多连接恰好都在）。多机操作现在只能经 `ssh_batch`（操作者在面板勾选目标 + 一次性确认）。工具总数 30 → 29，README 两语言与 `test/batch.mjs` 断言同步更新。
- **修复 SSH 资源保存全链路**：客户端凭据服务此前取自不存在的 `ctx.connection.api.credentials` 路径，改为 cordis 注入 `remote.credentials`（`inject` 需显式声明嵌套服务，否则渲染即被错误边界吞掉、面板空白）；`credentials.set/unset` 调用改为宿主 Remote 的位置参数形态并按 `RemoteResult` 判错。
- **已信任主机一键收编**：「已信任主机（未保存为资源）」卡片新增「保存为资源」按钮，预填主机/端口直接进编辑器。
- **连接快速失败 + 可取消**：面板一键连接传 `readyTimeout=15s, retries=0`（批量/Agent 路径保持默认重试策略）；新增 `cancelProfileConnect` RPC（含 descriptors/schemas），连接中的握手被 `close` 事件立即打断，「连接中…」旁提供「取消」按钮。此前不可达主机会静默重试一分多钟，形如假死。
- **私钥保存格式校验**：录入私钥时校验 `BEGIN/END` PEM 首尾行完整（截断粘贴是「服务器拒绝认证」的高频根因），PPK 等 ssh2 不支持的格式在保存时即被挡下。
- **终端会话失效显式提示**：`dsh web` 进程重启会杀掉全部 SSH 会话，旧客户端在 `no-session` 时静默停摆、画面冻结，看起来像「Agent 命令不再回显」；现在 xterm 收到 `no-session` 会写入红色提示引导重新连接。

## 0.2.16 - 2026-08-29

- **数据库工程化重构：本次发布为该批最终集成状态**（承接 0.2.15 工作流，补齐并压实「工程师连库工程化」全链路）：
  - **db_query 词法级真只读闸**：`assessReadOnlySql` 以单遍 `scanTokens`（复用字符串/注释剥离架构）扫描，`statementVerbs` 由 `scanTokens` 派生去重。只放行 SELECT/SHOW/DESCRIBE/EXPLAIN/纯查询 WITH；拦截写动词子查询、PG 数据修改 CTE（`WITH x AS (DELETE…)`）、`SELECT INTO @var/OUTFILE`、`FOR UPDATE/FOR SHARE` 锁读、`REPLACE INTO`、SET/GRANT/CALL 等（`SHOW CREATE TABLE` 与 `REPLACE()` 字符串函数豁免，引号列名不误伤）。
  - **流式行数钳制 + 查询超时**：MySQL 查询流逐行收取、到 200+1 行即 destroy（连接一并废弃）；超时（`PROTOCOL_SEQUENCE_TIMEOUT`）与协议级 fatal 错误改为**销毁**池连接而非归还复用，避免协议状态错乱的连接被复用。pg 走 pg-cursor portal 分批取、`statement_timeout` 30s 参数绑定设置、用完 RESET。
  - **交互式事务工作流** `db_tx_begin` / `db_tx_execute` / `db_tx_commit` / `db_tx_rollback`：从池中独占连接执行 START TRANSACTION、变更后 SELECT 验证再决定提交/回滚，闲置 5 分钟自动回滚，显式断开前先回滚未结事务；事务内 DROP/TRUNCATE/SHUTDOWN 依旧拦截。
  - **结构化探查**：`db_describe_table` 补齐索引 / 外键 / DDL / 行数与容量估计（MySQL 补 information_schema.KEY_COLUMN_USAGE 参数绑定外键查询）；新增 `db_preview`（表名分页采样、标识符白名单校验、全表行数估计）与 `db_explain`（`EXPLAIN FORMAT=JSON`）。
  - **数据库面板 UI**：侧栏表树（选中连接自动加载表清单）、预览视图（分页 / 行数估计 / 结构摘要）、查询结果一键导出 CSV（含 BOM，Excel 中文兼容）、按连接存 localStorage 的查询历史（最近 50 条，下拉回填）。
  - **DB 传输丢失崩溃修复**：四类 DB 客户端统一挂 `error` 监听 + `record.dead` 幂等清理（node-redis 额外 `disconnect()` 终止对已关闭隧道端口的无限自动重连），绝不 throw；之后对该 id 的 `db_run`/`db_query` 明确报 "not found" 引导重连。
- **pg-cursor 必须外置打包**：内联 pg-cursor 会把其深路径 `require("pg/lib/result.js")` 打进 lib，dsh web 启动即崩；改 `build-host.mjs` external + lib 运行时直接 import（src 本就是普通 ESM import）。
- **测试**：新增只读闸 30 例（放行 13 / 拦截 17）、db-ops 扩展（ssl 映射 / ssh 隧道路由 / 传输丢失 / 标识符与预览 SQL 构造 / 事务状态机 / MySQL 外键 / mysql 分页连接生命周期）、hostkey、batch；`npm test` 全绿。

## 0.2.15 - 2026-08-28

- **批量执行重构（对话触发 + 已保存服务器勾选）**：旧的「批量」面板菜单（基于当前已连接服务器）移除。现在在对话里说「批量执行 <命令>」，Agent 创建批量任务，右侧 SSH 面板弹出勾选弹窗，列出 SshResources 已保存的全部服务器（含未连接的）供手动勾选，确认后并发执行（对每台用保存凭据建连 → 执行 → 断开），结果按服务器分节展示（成功绿 / 失败红）。批量目标与当前打开的连接完全无关，可勾选未连接的服务器。
- **危险命令批量确认**：批量命令命中安全策略时，弹窗顶部醒目提示风险原因；确认范围 =「命令 + N 台目标」一次性确认，不再逐台弹窗。
- **新 Agent 工具 `ssh_batch`**：替代 `ssh_cluster`（后者基于已打开连接，已废弃并改名 `ssh_cluster_deprecated`）。`ssh_batch` 只创建批量任务、不直接执行，由操作者在面板勾选确认后才真正下发命令——危险命令在 Agent 侧被阻止，等待操作者确认。
- **批量弹窗打磨**：点遮罩收起后不再被下一秒轮询重新顶起（同一任务只自动弹一次，新任务到达才会再弹；未处理任务常驻顶部提示条可手动重开）；执行出错时弹窗保留并显示错误而非直接关闭。移除旧的「批量」面板菜单及全部关联死代码。新增 `test/batch.mjs` 覆盖 batchPlan/batchRun/runCommandOnProfile/execRawOnClient/ssh_batch 全链路。
- **批量弹窗收尾修正**：支持 Esc 关闭与点遮罩收起（执行进行中两者禁用，避免丢结果）；执行成功后「执行」按钮防二次点击（任务已被消费，再点必然报错）；`ssh_batch` 的 `timeout_ms` 在 `batchPlan` 内统一钳制到 1s–120s（工具直调路径此前绕过 RPC 的 zod 校验）。
- **修复 DB 传输层断连崩进程（历史 crash 根因）**：node-redis v4 客户端从未挂 `error` 监听——经 SSH 隧道的闲置 Redis 连接一旦遇到隧道重置/NAT 掐断，socket 意外关闭 emit 的 `'error'` 无监听器即成未捕获异常，直接崩掉整个 web 进程（对应 web.log 中已出现过的 `SocketClosedUnexpectedlyError`）。现 `db_connect` 建连后统一为四类 DB 客户端挂传输丢失处理：移除死连接记录、关闭隧道、`console.warn` 记入 web.log，绝不 throw；之后对该 id 的 `db_run`/`db_query` 明确报 "not found" 引导重新连接。仅 Redis 额外调用 `client.disconnect()` 终止其对已关闭隧道端口的无限自动重连（node-redis v4 默认永久重试且客户端不 emit `'close'`）。幂等：显式断开后的迟到事件不重复清理。`test/db-ops.mjs` 新增传输丢失回归用例。
- **数据库能力按「工程师连库工程化流程」全面升级**（摸底定位 → 采样分页 → 只读探查 → 事务变更 → 性能诊断 → 导出）：
  - **db_query 词法级真只读**：新增 `assessReadOnlySql`（src/db-safety.js，token 级扫描，复用字符串/注释剥离架构）。查询通道只放行 SELECT/SHOW/DESCRIBE/EXPLAIN/纯查询 WITH；拒绝写动词子查询、PG 数据修改 CTE（`WITH x AS (DELETE...)`）、`SELECT INTO OUTFILE/@var`、`FOR UPDATE/FOR SHARE` 锁读、`REPLACE INTO`、SET/GRANT/CALL 等（`SHOW CREATE TABLE` 与 `REPLACE()` 字符串函数豁免，保留字列名带引号不误伤）。
  - **流式行数钳制 + 查询超时**：MySQL 走 `pool.getConnection()` + 查询流逐行收取、到 200+1 行即 destroy（连接一并废弃）；pg 新增 `pg-cursor` 依赖走 portal 分批取、到上限即 close。替换原先"全量拉回再切 200"的行为——大表查询不再有整表进内存的风险。每查询 30s 超时（mysql per-query `timeout`；pg `set_config('statement_timeout', $1)` 参数绑定设置，用完 RESET）。
  - **`db_describe_table` 完整结构化**：列信息之外新增索引（mysql `SHOW INDEX` / pg `pg_indexes`）、外键（information_schema）、行数与容量估计（information_schema.TABLES / pg_class）、mysql 附 `SHOW CREATE TABLE` DDL。
  - **新工具 `db_preview`**：按表名分页采样（默认 50 行/页，`LIMIT/OFFSET` 参数绑定），标识符白名单校验（拒绝 `t; DROP TABLE x` 等），附 information_schema/pg_class 全表行数估计——不用手写 SELECT 即可翻页看数据。
  - **新工具 `db_explain`**：`EXPLAIN FORMAT=JSON`（mysql）/ `EXPLAIN (FORMAT JSON)`（pg），仅限 SELECT/WITH 且过只读闸，用于查索引使用与优化。
  - **交互式事务工作流 `db_tx_begin` / `db_tx_execute` / `db_tx_commit` / `db_tx_rollback`**：从池中独占连接执行 START TRANSACTION，变更后可 SELECT 验证再决定提交/回滚；DROP/TRUNCATE/SHUTDOWN 在事务内依旧拦截；闲置 5 分钟自动回滚；显式断开连接前先回滚未结事务；传输层断连直接清理事务簿。
  - **数据库面板 UI**：侧栏新增**表树**（选中 mysql/pg 连接自动加载表清单，可刷新）；点表名进入**预览视图**（上一页/下一页、行数估计、「结构」按钮展示索引/外键/DDL 摘要）；查询结果一键**导出 CSV**（含 BOM，Excel 中文兼容）；新增**查询历史**（按连接存 localStorage 最近 50 条，下拉回填）。
  - 新 RPC 七个（dbPreview/dbExplain/dbTxBegin/dbTxExecute/dbTxCommit/dbTxRollback + describe 扩展字段），schemas → descriptors → api 三层同步；工具总数 24 → 30。
  - 新增测试：只读闸 30 例（放行 13 / 拦截 17，含多语句走私、CTE 写、锁读、注释/字符串不误伤）、标识符与预览 SQL 构造、事务状态机（mock 池：begin/execute/commit/rollback/断开回滚）。
  - **复审收尾**：MySQL 分支补结构化外键查询（information_schema.KEY_COLUMN_USAGE，表名参数绑定，此前仅 pg 有）；`db_query` 流式路径的超时（`PROTOCOL_SEQUENCE_TIMEOUT`，mysql2 超时只放弃在途命令不动连接）与协议级 fatal 错误改为**销毁**池连接而非归还，避免协议状态错乱的连接被复用（普通服务端错误仍归还复用）；db-safety.js 两套词法遍历去重为单一 `scanTokens` 实现（`statementVerbs` 由其派生，行为由既有用例回归锁定）。
  - 兼容性：不新增任何 DSH 宿主 API 依赖（peerDependencies 保持为空、@deepseek-ai/* 运行时从核心解析），pg-cursor 内联打包进 lib（其对 pg 8.x 深引用已验证；将来 pg 升 9.x 需同步升 pg-cursor），storage 域结构未动、老会话/老数据双向安全。


## 0.2.14 - 2026-08-27

- **危险命令改为打断式确认弹窗**：1 秒轮询发现新的待确认命令时，整个视口弹出带遮罩的确认模态（含完整命令、风险原因、「执行 / 撤销」），不再依赖用户自己发现；点遮罩、Esc 或「稍后在面板中处理」可暂时收起，命令全部处理完自动关闭。同一条确认只会弹一次（「稍后处理」不会被下一秒轮询重新顶起）；面板重开时仍未处理的会再次弹出。
- **终端页内联卡片紧凑化**：卡片默认折叠为单行摘要（⚠ + 命令等宽截断显示 + 主机名，右侧常驻「执行 / 撤销」按钮），点击命令行展开风险说明与完整命令；最新一条自动展开。多条排队时不再需要在 260px 小滚动区里翻找。
- **修正误导文案**：此前提示「请到右侧 SSH 面板的『待确认』页签」，但 UI 中并不存在该页签。所有工具返回与终端通知统一改为描述真实的确认卡片位置（弹出式确认卡）。
- **取消终端预填**：危险命令不再预填到 SSH 命令行，消除「命令在终端但回车被拦」的矛盾；命令只能通过确认卡片的「执行」按钮提交（自动追加回车），终端输入行始终为空，操作者不可能因误按回车而执行。

## 0.2.13 - 2026-08-21

- **主机指纹 TOFU 校验**：SSH 连接（目标机与 proxyJump 跳板）现校验服务器主机公钥指纹——首次连接记录（`accept-new`，OpenSSH accept-new 语义），之后指纹变化即拒（防中间人 / 误连重装机）。指纹存于 DSH 本地 `ssh_ops_known_hosts` 存储域，按 `host:port` 索引，重启不丢。
  - 新增 `hostKeyMode`（每台服务器可设）：`accept-new`（默认，首次信任、变化才拒）/ `verify`（拒绝未知主机）/ `off`（关闭，不推荐）。
  - 主机指纹不匹配 / 未知主机时连接**不重试、不自动重连**，返回明确错误并提示用「忘记指纹」重置；避免对重装 / 被劫持服务器的重连风暴。
  - 主机指纹错误信息现带出 `Expected / Presented SHA256:` 实际指纹并引导带外核验，便于和服务器上 `ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub` 比对。
  - 校验发生在用户认证之前，与“谁登录、用什么密码”无关：同一台服务器指纹不变，任何管理员 / 厂家都能正常连，不会被挡。
- **proxyJump 跳板主机指纹失败保留结构化错误码**：此前跳板 host-key 不匹配抛的是无 `.code` 的普通 Error，会被 `connectClient` 当瞬时失败重试、且 `scheduleReconnect` 的 host-key 停止重连判断匹配不上（code 丢失）。现修复为 `hopError.code` 透传 + 跳板链 host-key 失败直接返回不重试，reconnect 抑制对跳板链同样生效。`test/hostkey.mjs` 新增回归用例覆盖。
- **已知主机指纹 UI 合并进服务器列表**：移除独立的「已知主机指纹」大块面板；每台已保存服务器卡片左侧加**绿色盾牌图标**（已信任=绿、未信任=灰禁用），点击弹窗查看 host:port / 算法 / `SHA256:` 指纹、复制指纹、忘记指纹。未保存为资源的已信任主机仅在列表尾部以极简行显示（仅有时出现），同样点盾牌弹窗。更省 SSH 资源面板空间。
- 新增 `src/hostkey.js`（纯函数 + `KnownHosts` 适配器，单测覆盖三模式与存取）与 `test/hostkey.mjs`（已纳入 `npm test`）。
- 新增 `listKnownHosts` / `forgetHostKey` 操作员 RPC（**非 Agent 工具**——Agent 不能重置主机信任）。
- 新增 `.github/workflows/ci.yml`：Node 20 / 22 矩阵跑 `npm ci` + `npm test` + `npm run build`。
- 将 `@deepseek-ai/cordis` 等 5 个运行时包声明为 devDependencies，使干净 CI 能跑测试（不影响发布插件的运行时解析，不触发 0.2.6 修复的 Windows persona 冲突——那是 peerDeps 才会）。

## 0.2.12

- 修复「关闭终端」后再点 SSH 面板右上角 × 不真正断开连接的问题：`closePanel` 原先用从 `ui.connections` 派生的 `active` 对象作守卫，关闭终端后该对象在渲染时可能拿不到，导致 `if (active)` 跳过 `disconnect`、只隐藏面板，底层 SSH 连接保留在注册表里、工具通道还开着。改为直接用 store 的 `activeConnectionId` 调 `disconnect`，只要还有当前连接就一定断开。

## 0.2.11

- SSH 终端内联待确认卡：Agent 发起的危险 `ssh_exec` / `sftp_delete` 分别排队，在终端窗口上方逐条审阅目标服务器、风险原因和完整命令，并可单独「执行」或「撤销」。
- 「执行」是唯一提交入口：确认令牌、终端会话和原始预填行会在提交前复核；会话关闭、令牌失效或输入已变更都会拒绝执行。
- Agent 预填的危险命令不再允许键盘 Enter 提交；Ctrl-C、编辑、撤销和会话关闭均会作废待确认记录。人工从零输入的命令保持原有行为。
- 省略 `connection_id` 时，危险操作确认会正确解析到当前已连接服务器（与 `ssh_exec` / SFTP 工具同一语义）。
- 修复 SSH 资源设置页深色模式下「新增服务器」「连接并打开」等主按钮文字不可读：主按钮前景色改用 DSH 对应 foreground token（`--dsw-alias-label-primary-foreground`），与主填充色（`--dsw-alias-button-primary-fill`）配对。

## 0.2.10

- Compatible with DSH-better-sidebar: the SSH drawer now docks to the left of an open right sidebar and yields the collapsed sidebar's top-right toggle cluster.

## 0.2.9 - 2026-08-20

- **高危命令预填确认**：Agent 触发删除/销毁类命令（`rm`、`DROP`、`mkfs`、`docker prune`、`kubectl delete`、`terraform destroy`、强制 Git 清理、重启/关机等）时，不再仅返回一段拒绝文本。插件现在会把该命令**预填进右侧 SSH 终端的输入行**（不附回车），并贴一行黄色提示「已为你预填命令，按 Enter 执行 / Ctrl-C 取消」，操作者确认后按一下 Enter 即可执行、按 Ctrl-C 取消，免去复制/sshpass 的来回折腾，仍保留「最后一下由人按下」的安全模型。
- **修复拦截后无可复制命令**：此前 `ssh_exec` 命中安全策略时直接抛错、错误分支不进 `render`，导致对话里拿不到可复制的命令（取决于模型是否重写）。现在改为返回带 ```bash 代码块的命令卡片；未打开终端会话或命令含 Tab 等控制字符无法安全预填时，自动降级为该复制卡片。
- **防 Agent 重试/绕行级联**：拦截改返回成功形状卡片后，Agent 不再因 tool error 反复重试（此前约 3 次/秒），也消除了"删不掉→核心目标完不成→自行下载 sshpass 绕行→刷屏"的级联诱因。卡片与拦截文案均显式标注「未执行」「请勿重试/绕行」「由人工确认执行」。局限：黑名单为关键词级、非沙箱，`python -c "os.remove(...)"` 等不含关键词的调用理论上可绕过字符串匹配——靠卡片文案告诫 Agent 勿绕行兜底，执意绕行属 LLM 行为问题，非插件层能完全根治。
- **拦截提示精简**：测试反馈拦截提示过长、关键信息（未执行/请勿重试/由人确认）可能被界面截断。已将 `ssh_exec`/`sftp_delete`/`db_execute` 卡片与 `ssh_write` 拦截文案压缩为单行标题 + 命令/代码块 + 一行告诫，重要信息前置可见。
- **`sftp_delete` 收口**：此前 `sftp_delete` 完全无安全检查、Agent 可直接删文件/目录。现统一改为不直接执行，而是把等价 `rm -rf <POSIX 引用的路径>` 预填进右侧终端（或降级为复制卡片），由操作者按 Enter 确认。
- **SQL 判断机制优化**：数据库增删改查远比系统操作频繁，旧的全文本正则会把字符串字面量/注释/列名里的 `DROP`/`TRUNCATE`/`SHUTDOWN` 关键字误杀（如 `INSERT ... VALUES('...TRUNCATE...')`）。改为按**语句动词**识别：跳过字符串/注释、按 `;` 切分多语句，仅拦截首动词为 `DROP`/`TRUNCATE`/`SHUTDOWN` 的语句，多语句注入 `SELECT 1; DROP TABLE x` 仍被拦。`DELETE FROM`（无 WHERE）维持放行（事务内常见合法批量操作）。
- **`db_execute` 拦截改卡片**：高危 SQL 不再抛错，改为返回带 ```sql 代码块的卡片，供操作者粘贴到数据库面板的 SQL 编辑器手动执行。
- **会话镜像漂移修复**：右侧终端的人工按键（raw `write()` 路径）现在会同步 `inputLine`/`inputKnown` 镜像。此前人工在终端敲入的删除行对 Agent 的按键门不可见，存在被后续 Agent 发送的 Enter 偷渡提交的风险；现已根除。
- `ssh_cluster` 同步适配新的拦截返回形状，集群场景下的高危命令按各连接报告 blocked 而非崩溃。

## 0.2.8 - 2026-08-18

- **`db_connect` 自动 SSH 隧道**：不再要求 Agent 提供内部连接 id。未传 `ssh_connection_id` 时新增 `via_ssh` 参数（`auto` 默认 / `yes` / `no`）：`auto` 下 host 为回环地址（127.0.0.1 / localhost / ::1）且当前已连接服务器时，自动通过当前服务器建立隧道访问其内网数据库；`yes` 强制走当前服务器；`no` 强制直连本机。显式 `ssh_connection_id` 优先级最高。
- **输出脱敏补强**：裸 `sk-` 开头的 API Key（无 `KEY=` / `Authorization:` 前缀，如 `export OPENAI_API_KEY="sk-..."` 或日志里的 `sk-...`）现在也会被脱敏为 `sk-***`。
- **修复 `render()` 返回类型**：`sftp_list` / `sftp_read` / `sftp_write` / `sftp_mkdir` 等工具的 `render` 改为返回 `ContentBlock[]`，避免 DSH 会话出现 `content.some is not a function` 崩溃。
- **修复 `tunnel_list` 返回字段**：`targetHost` / `targetPort` 在本地转发（无目标字段）时不再序列化为 `undefined`，避免工具返回值校验失败损坏会话。

## 0.2.7 - 2026-08-18

- **修复工具 output schema 字段缺失导致会话损坏**：`tunnel_list` 缺 `targetHost`/`targetPort`/`active`，`tunnel_start`（remote 类型）缺 `targetHost`/`targetPort`。工具返回值不通过 `additionalProperties: false` 校验时，DSH 无法生成合法 tool-result，导致会话历史出现"有 tool-call 无 tool-result"的消息，会话永久损坏（`SessionPersistenceCorruptionError`）。
- 0.2.5 已修复的 `sftp_list` 缺 `mode` 字段属同一类问题。

## 0.2.6 - 2026-08-18

- **彻底修复 Windows 端 persona 冲突**：移除全部 `@deepseek-ai/*` 的 `peerDependencies` 声明（cordis / dsh-tools / dsh-credentials / dsh-storage-domain / dsh-typert-protocol），防止 pnpm 安装时将这些核心包连同其子依赖（dsh-system-prompt 等）重复安装到 profile 插件层，导致 `deployment:persona` 被注册两次。运行时由 Node 模块解析从 DSH 运行时的 node_modules 加载单一实例。
- 0.2.5 的 `dsh.client.inject` 精简保留。

## 0.2.5 - 2026-08-18

- 修复 Windows 端安装后模型选择/会话恢复报错 `prompt section "deployment:persona" is already registered`：精简 `dsh.client.inject` 列表，移除 DSH 核心包的重复声明（仅保留 `dsh-client-runtime`），避免 bundle 构建时重复注入。
- 修复 `sftp_list` 工具 output schema 缺少 `mode` 字段导致返回校验失败。

## 0.2.4 - 2026-08-17

- 数据库「已保存」列表支持折叠/展开，带数量标记。
- 已保存的数据库资源支持重命名（✎ 按钮），便于区分同名默认连接（如 redis:127.0.0.1）。
- 打开数据库标签时不再自动弹出「新建连接」表单。
- README 截图路径修复为绝对 URL，新增数据库管理和 SSH 资产管理截图。

## 0.2.3 - 2026-08-17

- 新增**数据库功能**：支持连接 MySQL / PostgreSQL / Redis / MongoDB 四种数据库。
  - 新增「数据库」页签：左侧连接列表（可拖动分隔线调整宽度）+ 右侧 SQL/命令编辑器 + 结果表格；Ctrl/Cmd+Enter 执行。
  - SQL 库自动判断读写：SELECT/SHOW/DESC 走只读查询（db_query），其余走写操作（db_execute）；Redis 输命令（db_run），MongoDB 输 collection+operation+filter。
  - 支持 SSH 隧道访问内网数据库（选 SSH 资源后 host 默认 127.0.0.1）；支持 SSL 三档（disabled / preferred / verify）适配云托管数据库。
  - 数据库连接可保存为资源（profile），重启后一键重连；密码加密存储于 DSH 凭据库。
  - 高危 SQL（DROP DATABASE/SCHEMA/TABLE、TRUNCATE、SHUTDOWN）自动拦截。
  - 新增 8 个 Agent 工具：`db_connect` / `db_list_connections` / `db_query` / `db_execute` / `db_list_tables` / `db_describe_table` / `db_run` / `db_disconnect`。
- 修复深色模式下设置面板「新增 SSH 资源」弹窗文字不可见：CSS token 名从错误的 `--dsw-alias-background` / `--dsw-alias-border` / `--dsw-alias-brand` 修正为 `--dsw-alias-bg-overlay` / `--dsw-alias-border-l2` / `--dsw-alias-brand-primary`。
- 修复 esbuild 打包 mysql2 等 DB 驱动导致的 ESM `require("node:buffer")` 报错：将 mysql2/pg/redis/mongodb 设为 external，运行时从 node_modules 原生加载。
- 标签栏「批量执行」改为「批量」。

## 0.2.2 - 2026-08-17

- 修复 SSH 连接空闲后静默断开的问题：连接启用 keepalive（20 秒间隔、3 次判定），NAT/防火墙不再丢弃空闲连接，坏链接也能快速被发现。
- 新增断线自愈：传输意外断开后自动重连（指数退避，上限 30 秒）；执行命令、开终端、SFTP、隧道操作前会等待连接恢复，命令中途掉线自动透明重试一次，不再需要手动重新连接。
- 新增瞬时连接失败重试：网络抖动或服务器瞬时拒绝（如扫描器高峰期）时自动重试 3 次（退避间隔），认证失败除外。
- 显式断开或插件卸载不会触发自动重连；重连成功后远程隧道自动重新注册。

## 0.2.1 - 2026-08-16

- Files tab: single-click selects, double-click opens folders (or downloads files); download/rename/delete buttons appear inline on the selected row.
- Files tab: folder and file icons now render as SVG (yellow folder, white file) instead of emoji.
- Tab switching keeps the terminal session alive (tabs hide with CSS instead of unmounting, so xterm output is preserved).
- Added an error boundary per tab so a crash in Files/Tunnels never closes the SSH panel.
- Tab labels always show in Chinese.
- Replaced README screenshots with the new main view, files tab, and tunnels tab.

## 0.2.0 - 2026-08-16

- Added a **Files** tab to the SSH panel: browse the connected server's filesystem over SFTP, with directory listing, upload, download, mkdir, delete, and rename.
- Added a **Tunnels** tab to the SSH panel: start/stop local port forwards (host → server-reachable target) and remote port forwards (server → this machine), with a live tunnel list.
- Added Agent tools: `sftp_list`, `sftp_read`, `sftp_write`, `sftp_mkdir`, `sftp_delete`, `sftp_rename`, `tunnel_start`, `tunnel_list`, and `tunnel_stop`.

## 0.1.1 - 2026-08-16

- Added Settings → Plugins → SSH Resources for durable server inventory management.
- Removed the previous 20-server cap; resources can now be organized into any number of named groups.
- Stored server metadata in DSH local storage and passwords, PEM private keys, and passphrases in DSH's owner-only local credentials provider.
- Added saved-resource connect, safe credential replacement/clearing, resource deletion isolation, and non-persistent temporary connections.
- Kept the top SSH action focused on showing or hiding the right-side terminal, while the Agent is restricted to the active connection and cannot inspect saved credentials.
- Fixed the SSH terminal action so it mounts only beside Conversation / Trajectory, not in the Settings plugin tabs.
- Fixed SSH Resources text, controls, and status colors to inherit the active DSH appearance, including dark mode.

## 0.1.0 - 2026-08-15

- Initial DSH SSH operations plugin release.
- Right-side resizable xterm.js terminal with password and PEM/private-key authentication.
- Current-connection Agent tools: `ssh_connect`, `ssh_exec`, `ssh_read`, `ssh_write`, and `ssh_disconnect`.
- Structured command evidence, bounded output capture, model-side secret redaction, and prompt restoration.
- Guardrails that block destructive Agent commands while retaining manual operator control in the terminal.
