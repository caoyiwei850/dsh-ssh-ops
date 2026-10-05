# Changelog

## 0.3.16 - 2026-10-05

- **中英双语界面（自动跟随宿主）**：插件界面语言**始终跟随 DSH「设置 → 语言」**自动切换——包括运行中的切换（插件根订阅宿主 locale 变更，即时重绘面板、对话框、确认卡片、终端提示），不设手动语言开关（真机三轮反馈裁定）。宿主半（Agent 可见的工具结果、安全拦截消息、会话日志脱敏输出）经回写 RPC 即时并持久跟随同一语言。左侧设置菜单「SSH 资源」：标签注册为 getter 随宿主语言动态变化（此前一次性求值冻结在加载时语言——真机反馈：宿主切英文后标签仍中文；参照 @michengai/dsh-archive-manager 的 `label: () => locale.bind(NS)(key)` 注册方式）；图标用 DOM 标记法绘上终端形（宿主 `settings.section` 无 icon 字段、导航图标按 section id 硬编码，未知 id 一律齿轮——dshmarket/dsh-better-sidebar/dsh-skill-mcp-panel 均以同款 MutationObserver 方案自绘，本插件照做：样式表隐藏齿轮、CSS mask 绘出终端符号（几何 28→16 缩放自自绘图标，1.3px 描边），语言切换经观察器自动重认领）。自绘终端图标（侧栏引导页用）同步从实心蓝底白纹改为官方 outline 风格（currentColor、1.3px 官方中粗线），与相邻图标统一色调。宿主语言读取三级探测（`getSnapshot().active` → `getLocale().active` → 自有词典 bind 探针），形状对照真机 `dsh-client-locale` 包核验。实现为「中文为源语言 + 英文覆盖词典」（`src/i18n/`）：源码保留中文字面量包一层 `t()`，查不到词条优雅降级为中文；插值消息由模板模式引擎按字面段匹配回填。安全约束：策略类别等**标识符常量恒中文**（回收站改写按类别字符串匹配，翻译标识符会破坏 en 模式下的可逆删除），仅在展示点翻译；模块顶层不出现 `t()` 求值（否则冻结在 import 时的语言）。配套 `npm run i18n:extract` 覆盖率检查（t() 调用点 ↔ 词典双向比对 + 未包裹中文字符串检测，进 `test/i18n.mjs` 强制执行），新增界面字符串漏配词条会直接红。**翻译底稿与模式引擎源自 alexeyfadeev 的 PR #26**（其英文译文经词典反转复用；引擎分桶在他的英文为源场景下依赖空格分词，本仓改为字面前缀首字符并增加特异性排序），原词典存档于 `scripts/i18n-pr26-zh.dict.mjs` 备查，感谢贡献。
- **设置页自更新条**：**设置 → SSH 资源** 标题右侧新增版本徽标（vX.Y.Z，构建时从 package.json 注入客户端 bundle）、GitHub 仓库链接、**检查更新**（查询 npm registry 最新版并与本地 semver 对比，含预发布段比较）与**检查更新对话框**（真机反馈后对齐 @michengai/dsh-archive-manager 的规范流程）：点「检查更新」弹出对话框并自动检查——运行版本/最新版本/目标 profile 三行元信息（已是最新绿色、发现新版本提示、失败红色附原因）、分隔线下的**手工更新**区（展示 `dsh plugin --profile <profile> add dsh-ssh-ops@<ver> --registry=…` 完整命令 + 复制命令按钮），右下角**重新检查/自动更新**双按钮（自动更新仅在有新版本且环境支持时可用，否则置灰并附原因提示）。宿主 webServer 精确路由 `GET/POST /api/dsh-ssh-ops/update`；安装走 Desktop 的 `desktopPnpm.runPlugin` 通道或 web 宿主的 `dsh plugin add` 子进程；POST 受「本机回环 + 同源 + 插件专属头」三重校验，更新中防重入，错误信息不泄露本地路径。按钮摆放与样式照抄同插件的设置页头部：版本号内联在标题右侧（tertiary 灰 12px/500），GitHub/检查更新为宿主 Button 同款 outline 小按钮（28px 高、16px 图标：GitHub octocat + 官方 IconRefreshOutline 1.3px 描边，hover 用 `--dsw-alias-interactive-bg-hover`），一键更新为 primary 变体；CSS 参数取自 `dsh-client-ui-primitives` 的 Button.module.css。实现适配自 @michengai/dsh-archive-manager 的 plugin-updater（Apache-2.0），致谢。按用户要求不设「问题反馈」入口。注意：以 `link:` 挂载的开发工作区点一键更新会把 link 替换为 npm 安装版。
- **lib/ 构建产物出库**：`lib/`（宿主三件 + 客户端 bundle）从 git 移除并加入 `.gitignore`，由 `npm run build` 生成——PR diff 不再被数万行打包产物淹没，review 只看 src。配套：`test/db-lazy-load.mjs` 在缺少 lib 时自动先构建宿主包（fresh clone 直接 `npm test` 仍可过）；CI 把 build 调到 test 之前；从 git 直装（非 npm/tgz）需先 `npm install && npm run build`（README 已注明）。npm 包与 GitHub Release 资产不受影响（发布前本就构建）。
- **移除「从 ~/.ssh/config 导入」功能**：连接服务器弹窗底部的导入按钮取消（该功能此前已损坏——宿主读取实现存在 fs 回调用法定型错误，点击即报「The cb argument must be of type function」），整条链路一并摘除：客户端按钮与 `importSshConfig`、api 封装、宿主 `sshConfigImport` RPC 及其 descriptors/typert/schema 声明。添加服务器统一走资源表单或临时连接表单。
- **「已信任主机（未保存为资源）」支持直接删除**：该列表每张卡片新增「删除」图标按钮——与资源卡同款的垃圾桶图标（`iconDanger`），排列顺序也对齐资源卡（盾牌在前、垃圾桶随后），「保存为资源」文字按钮置于最后；点击经确认后移除该主机的信任记录，临时连接过的主机不再永久留在列表里。复用既有 `forgetHostKey` RPC，确认文案按此场景单独撰写（区分于指纹弹窗里面向「服务器重装/更换」的「忘记指纹」）。
- **资源表单布局紧凑化（新增/编辑 SSH 资源弹窗）**：「名称」与「主机」并排一行，「端口 / 用户名 / 分组」一行三列，「认证方式 / 共享凭据」随后——三排并入同一个三列基准栅格，所有列边界统一对齐在 1/3 与 2/3（主机、共享凭据各跨两列）；「默认项目目录」「主机指纹校验」「第二因素」整体折叠为底部「高级选项」（默认收起，编辑已设置过这三项任一项的资源时自动展开，折叠头带 ▸/▾ 指示与字段预告）。第二因素同步压缩为常规单行输入：密码认证时可整段粘贴 PEM，输入框随内容自动长高（封顶约 5 行后内部滚动），私钥认证时为密码输入框；长说明移入悬停提示，「清除已保存的第二因素」勾选保持原逻辑。
- **致谢**：本版本的双语界面由 [alexeyfadeev](https://github.com/alexeyfadeev) 的 [PR #26](https://github.com/caoyiwei850/dsh-ssh-ops/pull/26) 起步——模式引擎设计与其 564 条英文译文中 547 条原样采用（词典反转复用），原词典存档于 `scripts/i18n-pr26-zh.dict.mjs`；自更新条适配自 [@michengai/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager) 的 plugin-updater（Apache-2.0）。向两位贡献者致谢。

## 0.3.15 - 2026-10-05

- **双因素认证（密码 + 密钥，修真 bug）**：防火墙/交换机把 `AuthenticationMethods` 配成 `password,publickey`（或反序）后，同一条连接必须依次通过两个因素，此前认证模型是密码/私钥二选一的 union，第一因素过后手里没有第二凭据，这类设备必然登录失败。现在凭据升级为「主因素 + 可选相反类型的第二因素」：连接请求 `auth.secondary`、共享凭据与专属凭据的反向槽位（`PASSWORD`/`PRIVATE_KEY` 三个槽本来就都在，此前从不同时解析）、`profileConnect`/跳板链/`connect` 全部路径打通，ssh2 connectConfig 同时带上两种凭据。passphrase 槽复用规则：key 为主存主密钥口令，password 为主存第二因素密钥的口令。完全向后兼容——旧记录、旧请求一字不改照常工作，第二因素留空即单因素。UI：资源表单与共享凭据弹窗新增「第二因素（可选）」字段（带清除勾选），凭据列表显示「密码 + 私钥」组合标记；`credentialInfo`/`profileInfo` 新增 `secondaryConfigured`。
- **auth handler 修复 partial-success 后序列耗尽（同一 bug 的协议层）**：双因素设备每过一关都回 USERAUTH_FAILURE(partial success)，此前 handler 顺序单趟走完即返回 false——即使两个凭据都在配置里，`publickey,password` 顺序的设备也会在第二因素处断掉。现在收到 partial success 时重启方法序列（跳过无意义的 none 探测），并设有界保护防不合规服务器反复重报同一因素导致死循环；tracker 新增 `partialSuccesses` 计数。
- **测试**：105 项全通过；新增 `test/dual-factor.mjs` 九个用例——schema 向后兼容与同类型 secondary 拒绝、partial-success 重启序列（`none, password, [partial] → password, publickey`）、重启有界性、主/次双解析组合（password+key / key+password / 留空单因素）、connectConfig 双凭据装配。

- **SQL 词法扫描：navop 方言回归探针（测试加固），并实测否决 Oracle q'' 交替引号识别**：`test/db-safety.mjs` 移植 navop 连续两轮的方言回归现场——三段式 `COMMENT ON`（带引号点号标识符、注释含分号）必须完整成句、`ALTER TABLE "db"."t" ADD ...`、嵌套块注释双向探针（单层收口语义：早收口暴露的文本按活 SQL 处理，误拦方向安全；PG/MSSQL 真嵌套只会多扫文本，绝不漏检）、PG `E''` 转义串，以「破坏性动词门禁 + 只读门禁 + 语句切分数」三重断言落档（嵌套注释组仅断言破坏性动词门禁）。q'' 交替引号曾试做扫描器能力（把 `q'[...]'` 整段当字面量），复测实测否决并回退：本插件 SQL 通道是 MySQL/PG/SQLite/ClickHouse（无 Oracle），`q` 在所有这些方言里都是普通别名标识符，`SELECT q'[a'; DROP TABLE x; --]'` 在服务器上真会执行 DROP，而 Oracle 语义的整段吞掉会让两道门禁双双放行（漏检方向）；扫描器既有的普通引号规则（下一个未转义、未翻倍的引号收口）与 MySQL 串规则逐字符一致，本就无误，`src/db-safety.js` 留有注释防止该分支被当作遗漏重新引入，`q'[a'; DROP …` 两个绕过形态已固化为回归用例。

- **SQL 词法扫描：反斜杠引号与 PG dollar 引用（修两个同族既有漏检）**：扫描器此前对所有引号一律按 MySQL 默认施反斜杠转义，而 PG 普通字符串/引号标识符、MySQL 反引号标识符、SQLite 字符串不认 `\'` 转义——`SELECT 'a\'; DROP TABLE x; SELECT 'b'` 与 MySQL 反引号 `` `a\`; DROP …; --` `` 形态在对应服务器上真会执行 DROP，而扫描器把中段吞进字符串、两道门禁放行（HEAD 即有的漏检，本轮复测审查实测复现）。现在所有门禁对每条 SQL 同时跑「MySQL/ClickHouse 转义读法」与「字面读法（PG/SQLite/MySQL 反引号标识符）」：两种读法分词一致（不含引号前反斜杠的绝大多数查询）时行为不变；分歧时按通道取严——只读通道直接拒绝并提示改用 `''` 引号转义（所有方言读法一致），破坏性动词门禁取两读法并集，DROP 隔离改名的目标解析遇分歧拒绝解析、回落硬拦。PG `E''` 转义串经「独立 e/E 标识符紧邻引号即施转义」规则在两种读法下都精确（`freqE'…'` 的标识符尾部 E 不误认），既有 E'' 行为不变；写通道良性 `\'`（如 `VALUES ('can\'t stop')`）不受影响。另补齐 PG dollar 引用（`$$…$$` / `$tag$…$tag$`）识别：PG 空参数时 node-pg 走 simple-query 协议、多语句真会执行，`SELECT $$'$$; DROP TABLE t` 此前两道门禁放行；现在 dollar 区域按字面量跳过（tag 须标识符形态、不能以数字开头，`$1` 位置参数不误认；未闭合吞到结尾——服务端同样按未终止字符串报错、不执行），MySQL/SQLite/ClickHouse 无此语法且通道不支持多语句执行、不受影响。回归用例落进 `test/db-safety.mjs` 第 5/6 节。

- **会话日志批量删除（多选 + 全选）**：「会话日志」标题旁新增**全选**勾选（部分选中时呈半选态）与「删除所选（N）」按钮；每条日志行首增加复选框（勾选不触发打开日志），勾中行有淡蓝底色提示。批量删除沿用单条删除 RPC 逐条执行，先弹确认（不可恢复提示）；单条失败不中断其余删除，完成后刷新列表并把首条失败原因显示在错误条；正在查看的日志若在删除集合内，查看器自动清空。
- **移除旧版 DSH 浮动面板（抽屉）回退**：官方右侧边栏（`sidebarRightTabs` + `sidebarRight`）成为 SSH 终端 UI 的唯一宿主形态。删除 `SshDrawer.jsx`（固定定位、拖宽、聊天列让位、Desktop 标题栏对齐等全套旧占位逻辑）、`shell.overlay` 槽位注册、抽屉专属的会话顶栏按钮，以及 UI store 中只有抽屉在读的 `open` 状态与 `dsh-ssh-ops.panel-width` 宽度记忆。侧栏服务就绪的延迟等待逻辑保留（`activateSidebarWhenAvailable`），但不再有旧版回退：缺这两个 API 的宿主上 Agent 的 SSH/SFTP/数据库工具照常工作，只是不显示终端界面；侧栏注册失败改为仅报错（此前会回滚重建抽屉）。README/INSTALL 同步改为「官方侧栏 API 必需」。

## 0.3.14 - 2026-09-28

- **AI 自动连接已保存服务器（#25，默认关闭）**：新增操作者开关 **设置 → SSH 资源 → AI 自动连接**（`agentSettingsGet`/`agentSettingsSave` RPC，持久化在 `ssh_ops_settings` 存储域）。开启后 Agent 获得 `ssh_connect_profile` 工具：按名称（大小写不敏感，唯一子串亦可）或资源 id 连接已保存的 SSH 资源并设为当前连接，复用该资源已有的活连接而不重复建连，同时 `ssh_list` 会列出已保存服务器（仅坐标信息，不含凭据/跳板链）；连接成功后会在右侧面板显示目标终端；若 PTY 无法打开则报错并清理新建连接。未开启时 `ssh_connect_profile` 明确报错引导转人工，且不会暴露任何已保存资源；危险命令确认、安全审核边界不变。
- **Agent 连接自动上屏**：`list()` 通过 `agentSession` 和每次连接请求更新的 `agentRevealId` 传递可见性信号；插件根级轮询覆盖 SSH 面板未打开的场景，面板自身刷新提供快路径。浏览器据此聚焦 SSH 面板，并将目标排入服务器标签页；复用人工会话及关闭面板后再次连接也会重新上屏。同一请求按标记去重，卸载插件时停止轮询。
- **no-connection 报错结构化**：`ssh_exec`/`ssh_read`/`ssh_write`/SFTP/隧道等工具遇到不存在的 `connection_id` 或当前无活动连接时，开启自动连接才附带已保存资源清单并引导 `ssh_connect_profile`；关闭时只提示请操作者连接，不泄露保存的资源名。`selectConnection`/`openSession`/`disconnect` 同步受益。
- **修复：session-log 空/越界读取同步抛 ERR_OUT_OF_RANGE**（并行全量测试连续两轮稳定复现的真 bug，非本次功能引入）：日志文件存在但为 0 字节（`begin()` 建文件后首个分块尚未落盘的窗口）、或 `offset` 越过文件末尾时，`createReadStream` 以 `end < start` 构造会**同步**抛错、绕过 error 事件直接炸出异步链；同时 `begin()` 重放竞态缓冲块时未登记到 `flush()` 追踪，读侧可能永远等不到数据。两处都已修复并补回归用例（空文件/越界 offset 均返回空页），连续三轮 95 项全量测试通过。
- **兼容声明改为区间**：四个官方包的 `peerDependencies` 从逐预发布线改为无上界区间 `>=0.1.5-alpha.1`。宿主闸门以 `semver.satisfies(DSH运行时版本, 区间, { includePrerelease: true })` 判定，该区间对 `0.1.5` 起的全部宿主版本（含一切预发布）直接放行，宿主升级不再需要发版跟进。此前逐线声明频繁失效的根因是 caret 上界 `<0.x.0-0` 会把下一条线的预发布全部排除（已用宿主同款 semver 语义逐例验证），并在 DSH 桌面版 0.2.0-rc.1 真机验证插件加载正常。
- **回归测试**：覆盖资源名隐私、设置写盘失败、PTY 失败回滚、复用连接再次上屏、轮询启停，以及真实 `list()` 返回值经 DSH 严格工具 schema 校验。

## 0.3.13 - 2026-09-27

- **删除回滚余地：`rm` 确认后静默进远端回收站**：Agent 发起的 `rm`/`unlink`/`rmdir` 的确认卡片、提醒与终端显示**完全不变**；唯一变化在执行层——操作者点「执行」时，*简单*删除（单条命令、显式字面路径）先把目标移入服务器 `~/.dsh-trash/`（`manifest.tsv` 记录原绝对路径与时间）再算完成，24 小时后的过期项在下一次入站时顺带真删（不装任何定时任务）。对操作者无感，删错了 24 小时内可按 manifest 恢复；无法安全改写的删除（复合命令、`find -delete`、`shred`、非 POSIX shell 下的相对路径）批准即按原命令真跑。新增 `src/trash.js`（带引号感知的 tokenizer：引号内 `~` 不展开、含 Tab 的路径拒绝改写、同秒同名自动加后缀），POSIX/busybox 兼容脚本经真实 `/bin/sh` 在临时目录全流程验证（移动、manifest、恢复、过期清理、碰撞加缀）。
- **危险 SQL 自动备份**：`db_execute` 命中 `DROP`/`TRUNCATE`/`SHUTDOWN` 时先备份受影响的表再拦截——行数据走只读导出通道（SSH 连接落远端 `/tmp/dsh-backup-*.csv`，直连落 DSH 宿主临时目录），MySQL/SQLite 附带 DDL（PG 暂无）；`DROP DATABASE` 逐表备份（上限 20 张）。备份清单完整出现在工具结果与拦截消息里，备份失败如实标注。
- **`DROP TABLE` 隔离改名**：备份后自动 `RENAME` 为 `<表名>_to_be_dropped_<日期>`（重名加序号），数据保留可随时改回；**Agent 无法完成真删**——隔离表的最终 `DROP` 仅接受面板（人工）发起，Agent 发起会被明确拦截。mysql（`RENAME TABLE ?? TO ??`）/ pg（`ALTER TABLE ... RENAME`）/ sqlite 三方言覆盖；隔离名遵守标识符白名单（无连字符）。
- **安全黑名单封堵绕过向量（真实事故驱动）**：新增 `find -exec(dir) rm/unlink`、`xargs rm/unlink`、`rimraf`，以及 python/perl/ruby/php/node 一行流调用 `unlink`/`rmtree`/`rmSync`/`os.remove`/`shutil.rmtree`/`fs.rm` 等模式——此前 `rm` 被拦后 Agent 曾换用其它代码完成删除。
- **SFTP 目录批量上传/下载（新工具 `sftp_upload_dir` / `sftp_download_dir`）**：整棵目录树递归传输并自动建远端/本地目录结构。调度策略：小文件（≤512KiB）进并发上限 6 的工作池（目录树里大量小文件是延迟瓶颈，并行决定吞吐），大文件独占通道逐个传输（不让六条半载流抢带宽）；计数单调推进，单文件失败逐条上报不中断整批（结果里列出失败路径与原因）。新增 `src/sftp-dir.js`（纯调度层，可单测），接口描述符与 typert 声明同步扩展。
- **SSH 认证失败从一句空话变成结构化诊断**：此前登录失败只有 ssh2 的一行 "All configured authentication methods failed"，被设备中途掐断则表现为裸的连接关闭，Agent 无从判断下一步。现在连接层自定义 auth handler（顺序与 ssh2 默认一致：none → password → publickey → keyboard-interactive）逐项记录尝试过的方法与服务器最后宣布"仍然接受"的方法列表，失败时把二者连同阶段判定（认证被拒 / 传输中断 / 协议违规 / 未知）与可执行建议一起给出，例如"服务器仍接受 keyboard-interactive；插件已用保存的密码应答交互提示——若验证码是动态的请改在面板手动登录"。
- **keyboard-interactive 认证支持 + 中断自动降级**：密码登录现在默认带 keyboard-interactive（用保存的密码应答全部提示），只允许交互式认证的设备/MFA 门禁不再直接失败；若设备在交互提示进行中把传输掐断（老固件的常见行为），自动降级为纯 password 方法重试一次——只在认证确实开始之后才触发（`USERAUTH_FAILURE` 已收到或交互提示已应答），普通网络失败不会误入这条路径。跳板机链同样支持交互式认证。
- **数据库连接健壮性三件套**：① MySQL/PG 池启用 30s TCP keepalive，空闲 NAT/防火墙静默断链会主动暴露为 socket 错误而不是半开连接；② 池化连接空闲超过 30s 后复用前先做一次 10s 上限的活性 ping（`SELECT 1`），把"下一条真查询卡满 35s 超时"变成秒级失败，并**透明重连一次**（嫌疑连接以错误释放回池，绝不复用）；③ 连接传输中断时，打开中的手工事务逐个做有界 ROLLBACK 尝试并销毁/带错归还专用连接——池槽不再随断连泄漏。
- **修复：MySQL 未知字符集文本列不再显示为字节对象**：服务器把文本列的字符集报成 binary/unknown 时 mysql2 返回 Buffer，而原序列化器把 Buffer 检查写在 `JSON.stringify` 的 replacer 里——`Buffer.toJSON()` 先于 replacer 执行，该分支是死代码，文本一直以 `{"type":"Buffer","data":[…]}` 漏给 Agent。改为显式递归遍历（Buffer → UTF-8 字符串，Date/ObjectId/Decimal128/bigint 行为不变，嵌套在对象/数组里的 Buffer 也一并处理）。
- **测试**：94 项测试通过；本轮新增 ssh-auth（方法序列/诊断分类/降级触发条件）、db-keepalive（活性 ping/透明重连/断连事务收尾）、db-charset（Buffer 解码钉死 + 导出路径）、sftp-dir（调度策略边界 + 内存 SFTP 服务器上的目录上传/下载往返）四个用例文件；可逆化轮新增 trash（解析器/脚本生成/真实 shell 端到端/保留期）与 db-guard（备份先于改名、隔离改名、操作者专属清除、方言 SQL、备份失败降级）两个用例文件，safety 用例同步改写（卡片流程改用不可回收的 `shred`，回收站流程独立覆盖）。

## 0.3.12 - 2026-09-21

- **修复 #23：`db_list_connections` 在有连接时恒定失败**：`DbOpsManager.list()` 返回的 `username` 此前没有出现在 Agent 工具的严格输出 schema 中，`additionalProperties: false` 因而让 DSH 在渲染前拒绝整个结果。现在 schema 明确要求 `username: string | null`，与 RPC 契约和服务返回保持一致。
- **连接身份展示更完整**：Agent 列出数据库连接时同时显示数据库名、非敏感用户名、启用的 TLS 模式与 SSH 路由；SQLite 连接改为显示数据库文件路径，不再出现无意义的 `:0`。
- **回归护栏**：测试现在把真实服务输出经 RPC 同款 JSON 传输后送入 DSH 的 `validateJsonSchemaValue()`：`db_list_connections` 覆盖有账号、无账号与 SQLite 三类连接；`db_execute`、`db_tx_execute`、`db_describe_table`、`db_export` 的全部条件/复合形状（拦截卡片、事务行校验、mysql/sqlite 内省差异、内联与 SSH 远端导出）各配一个镜像服务端字面量的样例，防止服务返回和 Agent 工具 schema 再次漂移。

## 0.3.11 - 2026-09-19

- **修复 shell integration 的 shell 家族探测（真机验证发现）**：探测命令走的是带 cwd 标记的包装（每次 exec 都如此），且已启用 shell integration 的服务器自身还会输出 `133/633` 标记——探测输出因此恒为非空，插件**总是按 zsh 变体注入**，写进 bash 的 `precmd_functions+=(...)` 让整行脚本解析失败，OSC 133 从未真正生效（`shell` 状态恒为空、cwd/退出码取不到）。现在探测改为定界回答（`DSHSHELL:%s:END`）并取**最后一个**定界结果，对 cwd 标记与既有集成标记都免疫；补了污染场景的回归测试。
- **终端上下文的结果契约补上 `shell` 字段**：`terminalContextReadResultSchema` 与 typert 声明此前未包含该字段（实测值能通过，但契约与实际返回不一致），并加了"schema 必须保留 shell"的断言，防同类漂移。
- **测试**：69 项测试通过。

## 0.3.10 - 2026-09-19

- **新增数据库驱动：SQLite / ClickHouse / openGauss**：SQLite 使用宿主运行时的内置 `node:sqlite`（零新依赖，文件路径即连接，不支持的宿主给出明确报错）；ClickHouse 走 HTTP 接口（`?` 占位符翻译为带类型的 URL 参数，值永不进入语句文本；结果按 JSONCompact 解析，服务端行数上限做截断）；openGauss 与 PostgreSQL 同协议，复用同一驱动、独立默认端口。连接请求、资源记录、启动时 schema 与 typert 声明四处同步扩展；`host`/`port` 对 SQLite 变为可选。
- **表数据导出 CSV / JSON**：新增 `db_export` 接口与 agent 工具。复用查询的只读门禁与占位符绑定（导出不是第二条写通道），行上限默认 5 万、封顶 20 万；经 SSH 连接的库把文件写到服务器（默认 `/tmp/dsh-export-<连接>-<时间戳>.csv`，可用 SFTP 面板下载），直连的库 256KB 以内内联返回；结果工具栏新增「导出 CSV / 导出 JSON / 导出到服务器」。
- **动态 SOCKS5 隧道（`ssh -D`）**：新增 `tunnelStartDynamic` 与面板「动态 SOCKS5」模式——一个本地监听端口，客户端逐连接选择目标，每条连接经该服务器打开独立通道；BIND 与 UDP ASSOCIATE 明确回「命令不支持」而不是近似实现；隧道列表显示当前活动连接数。
- **会话录制与日志**：终端输出按会话落盘（默认 `~/.dsh/ssh-ops-logs`；单会话 8MB 上限，超出即截断并标记；目录 256MB 预算，超出按最旧轮换）。SSH 面板新增「日志」tab：列表（主机/时间/大小/截断状态）、分页预览、大小写不敏感搜索（命中行带偏移可直接跳转）、下载、删除。agent 侧新增 `ssh_session_log_list` / `ssh_session_log_search` / `ssh_session_log_read`，内容读取沿用终端上下文同一信任边界：操作者批准 + 自动脱敏。
- **Shell integration（OSC 133）**：新增 `enableShellIntegration`，向空闲的 bash/zsh 会话注入单行标记脚本；此后 `ssh_terminal_context` 返回 `shell`（当前目录、最后一条命令的退出码、是否停在提示符）。序列解析可跨 chunk 分片、兼容 BEL 与 ST 终止符，未终止的长序列会被丢弃而不是无限缓冲。
- **SFTP 面板增强**：文本编辑器（10MB 上限、UTF-8 BOM 剥离、前 8KB 含空字节判为二进制并拒绝、保存前校验 mtime 冲突）；目录名过滤；按服务器（用户@主机:端口）收藏常用路径；文件拖拽上传。
- **修复**：SQLite 连接不再尝试建立 SSH 隧道（此前选隧道时连接必然失败）；`sshConnectionId` 对 SQLite 仅作为导出目的地保留。
- **类型契约补全**：新增 `test/typert-sync.mjs` 守卫（descriptor ↔ 类型声明 ↔ 服务成员表 ↔ 驱动枚举四方对齐），并据此修好历史漂移——30 个从未声明的类型（batch\*、DbExplain/DbPreview/DbTx\*、已知主机、profileDisconnect 等）、14 个缺失的服务成员行，以及 `dbTypeSchema` 与启动时的 `dbProfileRecordSchema` 未包含新驱动类型（后者会让新类型资源记录无法通过启动校验）。
- **注入片段按 shell 家族拆分（实测修复）**：单行命令会被整行解析，POSIX sh 遇到 zsh 的数组语法会在 stderr 静默报错、整行作废（管道下看不见）。现在 `enableShellIntegration` 先探测 `$ZSH_VERSION`，再写入对应变体（bash/`PROMPT_COMMAND` 或 zsh/`precmd_functions`），两者都经真机确认能打出 `133;D;<code>`、`133;A` 与 `633;Cwd=` 标记。
- **终端搜索结果高亮改为绿色（用户实测反馈）**：原琥珀色实心 active 高亮在深色终端上把白字压成 1.32:1 对比度（几乎不可读），换成绿色系并保持半透明——active `rgba(35,134,54,.6)`、普通匹配 `rgba(46,160,67,.32)`、active 描边 `#7EE787`；实测合成对比度：深色主题 6.07:1（active）/ 8.30:1（普通），浅色主题 6.63:1 / 10.75:1，全部高于 WCAG 4.5:1 门槛。搜索 addon 不能改文字颜色（`foregroundColor` 未透出），所以靠"半透明混合主题底色"同时保住深浅两套主题的可读性。
- **终端内搜索（新增，用户点名补入）**：终端角落常驻一个放大镜按钮（tooltip 按平台显示 `⌘F`／`Ctrl+F`，点开自动聚焦输入框），快捷键也能直接唤起：macOS 用 `⌘F`（**不抢** `Ctrl+F`，留给 readline 的光标右移），其它平台 `Ctrl+F`，另在两端都接受终端原生的 `Ctrl+Shift+F`。查找条：输入即搜，输入即搜（命中计数 `当前/总数`、无匹配提示），`Enter`／`Shift+Enter` 前后跳转、`Esc` 关闭并清除高亮；基于 `@xterm/addon-search` 搜索实时滚动缓冲（会话自己的历史）。实现要点：高亮装饰属 xterm 的 proposed API，终端需开 `allowProposedApi`；另外查找走"带高亮失败即降级重搜"的辅助函数，遇到不支持的构建仍能跳转而不是静默无结果（这两点都是本轮真机调试抓出来的——隔离探针定位到 `You must set the allowProposedApi option to true`）。
- **日志预览改为行式渲染（用户实测反馈：提示符刷屏）**：交互式 shell 每次刷新都重打提示符（`\r` + `CSI K` + 提示符），真终端里覆盖同一行，而此前的纯文本视图把 CR/擦除丢掉，于是叠成几十行。现在按行缓冲渲染：处理回车覆盖、退格、制表位（8 列）与"擦除行"，其余序列剥离——实测某条真实会话 42 处提示符收敛为 2 处、5777 字节转成 27 行可读记录。仍然不是终端模拟器（不做光标上下移/滚屏/备用屏），文档已注明这一取舍。
- **不再产生 0 字节空日志 + 一键清理**：录制改为"首个输出字节到达时才建日志"（误开的标签页、探测连接等不再留下空记录）；日志面板在有 0 字节记录时显示「清理空日志」按钮（本次已清掉 22 条历史空日志）。
- **日志预览剥离终端转义序列（用户实测反馈）**：真实会话的日志里含大量 CSI/OSC 序列（颜色、`[K`、`[?2004h`、shell integration 的 `133/633/1337` 标记、OSC 7 cwd 上报），此前预览按字面量显示成 `]133;C ]133;D;0 …` 的乱码。现在展示层（预览、搜索命中行、下载的 .log、agent 工具输出）统一剥离为可读文本，**落盘仍保留原始字节**以便保真与后续解析；已对 28 条真实日志核验剥离后零残留。
- **导出到服务器支持自定义路径**：面板按钮改为先询问目标路径（留空用默认 `/tmp/dsh-export-*.csv`）。
- **离线测试台升级**（`test-sshd.mjs` / `test-sftp-server.mjs`）：新增沙箱化 SFTP 子系统（真实文件读写、越界拒绝）、`direct-tcpip` 转发（本地/动态隧道离线可用）、以及请求了 PTY 时启动真正的交互式 shell（有提示符，shell integration 可离线验证）。
- **测试**：67 项测试通过；新增 socks5（含真实转发往返：代理 → 上游回显）、session-log（存储层 + 服务层 + 接线契约）、shell-integration、sftp-files-ui、db-extra-drivers（SQLite 真实往返、ClickHouse 协议映射、两种导出目的地）、typert-sync 六个用例文件。

## 0.3.9 - 2026-09-18

- **兼容 DSH 0.1.6-alpha.2（typert create() 契约）**：新宿主的 typert loader 要求 `TYPERT.schemas` 条目与每个调用的 strict codec 携带 `create()` 工厂（浏览器端 web boot 用同一校验，旧形状 `{ name, schema }` 会让插件条目激活失败、侧边栏整体消失）。插件在 `sshError` schema 与全部调用描述符上补齐 `create`，同时保留 `schema` 字段——alpha.1 读 `.schema`、alpha.2 调 `create()`，双版宿主通吃。
- **修复官方侧栏注册冲突（alpha.2）**：宿主现在拒绝同一槽位出现同 id 的第二个条目。旧版抽屉按钮与官方侧栏按钮共用 `ssh-ops-tab-action`，而清理旧抽屉的代码排在侧栏注册之后，注册时抛出 "already has an entry" 并打断整条侧栏注册路径。现在按既定设计先释放抽屉再注册侧栏；注册中途失败会自动回滚重建抽屉，SSH 始终可达。
- **修复 #20：`defaultProjectPath` 为 `null` 的资源记录**：存储 schema 此前不接受 `null`，一条这样的记录会让整个资源配置域读取失败。现在 schema 接受 `null`（与「未填写」同义），并为 profile 写入路径补了「不填／设置／清空」三条往返测试。
- **数据库驱动懒加载**：MySQL、PostgreSQL、Redis、MongoDB 四种驱动与 `pg-cursor` 改为首次连接时动态 import，冷启动不再加载全部驱动。
- **测试**：60 项测试全部通过；侧栏生命周期用例更新为先清理后注册、失败回滚的新契约；新增 `test/domain-records.mjs`（凭据／数据库配置／已知主机的写入记录全部通过启动时 schema 往返校验）与 `test/db-lazy-load.mjs`（冷启动不加载任何驱动；四种驱动与 `pg-cursor` 各自在首次使用时动态装载）。

## 0.3.5 - 2026-09-13

- 移除不再维护的「运维模式」预设安装器及其随包预设资源，避免 npm 发布时生成无效的命令入口。
- **保存并进入远程项目目录**：每台 SSH 资源现在可保存一个可选的绝对路径「默认远程项目目录」。资源卡片会显示该目录，原「连接」按钮变为「进入项目」：连接后先打开交互终端，通过既有的空闲 shell/单 PTY 检查安全执行 `cd`，同时让 SFTP 文件页从同一路径开始。目录不是 shell 命令，拒绝相对路径和控制字符；旧资源保持原有登录目录行为。
- **SSH 资源迁入设置左侧菜单**：从“设置 → 插件 → SSH 资源”迁到官方 `settings.section`，成为与通用设置、模型同级的“SSH 资源”菜单项（终端图标）；原插件子页不再注册，不会出现两份资源配置。

## 0.3.4 - 2026-09-13

- **分栏各走一条独立通道（用户反馈）**：同一台已保存服务器在两个分栏各打开一次，现在会各建一条独立连接——两条通道、两个终端、互不干扰，各自保留自己的当前目录。此前默认复用同一条连接，而面板渲染的是该连接的第一个 shell，于是两栏共用同一个终端、敲字互相镜像，无法各操作各的。连接对话框新增「复用已打开的连接」选项（仅对已保存服务器显示，默认关闭）：勾选后本栏加入已有那条连接并共用其终端，适合想在同一终端里看着 Agent 干活的场景。
- **Agent 的作用目标可见、可切换**：新增 `selectConnection` 接口。面板上被 Agent 使用的连接带蓝色机器人徽标（RoyalBlue3）、标签整体蓝色描边，点击另一栏的服务器标签或终端区域即把 Agent 切到那一栏——Agent 省略 `connection_id` 的工具（`ssh_exec`、`sftp_*`、`tunnel_*`、待确认操作卡片）默认作用于它。切入已失效的连接会被拒绝并保留原有绑定，不会把 Agent 悬空；面板每 5 秒从宿主同步真实绑定，页面刷新不再由客户端猜测一个值。
- **不符合 RFC 4253 的 SSH 横幅不再连不上（用户反馈修复）**：ssh2 的横幅解析只接受 `SSH-2.0-` / `SSH-1.99-` 且软件版本必须非空、不含空格，其余写法一律抛出 `Invalid identification string`——这句话既不说是哪台设备，也不说是哪一行有问题；而系统 OpenSSH 对其中一部分（`SSH-2.0- OpenSSH` 多一个空格、`SSH-2.1-`）本来就能正常连上。现在**仅在 ssh2 确实因横幅拒绝之后**才重试一次：由插件自己接管这条流，把横幅那一行规范化后再交给 ssh2，对端的软件版本原样保留（ssh2 的兼容标志由它推导），绝不凭空编造版本号；成功时返回 `bannerRepair`，并在面板与工具结果里给出警告。确实无法使用的横幅（只支持 SSH-1 的设备、缺少软件版本）改为明确报出**对端原文**与原因，而不是重复 ssh2 的措辞，也不会反复重试。正常对端完全不走这条路径。
- **设置页点「连接」会真正打开并载入 SSH 窗口（用户反馈修复）**：此前在「设置 → 插件 → SSH 资源」点连接，只是把旧版抽屉的开关置为打开，既不会自动打开 SSH 窗口，SSH 窗口已开着时也不会把这个连接载进去。现在会请求打开官方侧栏的 SSH 标签，并把新连接直接交给对应窗格显示（跨窗格用一个待打开队列交接，由唯一一个窗格认领，不会两个窗格同时抢）。
- **测试**：新增 active-connection 与 ssh-banner 两个用例文件。后者把真实 ssh2 服务器放在一个会篡改横幅的代理之后，走生产连接路径验证修复——包括握手后的真实 shell 会话（证明字节未丢），以及纯函数级的横幅判定表；完整测试共 54 项通过。

## 0.3.3 - 2026-09-13

- **共享 SSH 凭据**：新增独立的 `ssh_ops_credentials` 存储单元与 `credentialList` / `credentialSave` / `credentialDelete` 三个接口，一台凭据（密码或私钥）可被多台服务器与跳板机共用。凭据放在独立单元而不是提升既有 profile 单元的版本——DSH 的 JSON 存储拒绝就地升版本，已有服务器配置绝不能导致宿主启动失败；旧记录无需迁移即可读取。删除时若仍被任何服务器或跳板链引用会拒绝并说明原因。密文只在宿主端解析后直接交给 ssh2，绝不回传浏览器。客户端在「设置 → 插件 → SSH 资源」新增共享凭据管理区（新增／编辑／删除，支持选择或拖入 PEM 私钥文件），连接对话框与资源编辑器均可选用共享凭据；服务器记录新增可选的 `credentialId`，显式传 `null` 可解绑回该服务器专属的凭据槽。
- **跳板机（ProxyJump）改用已保存服务器**：整条跳板链不再手填主机与认证信息，改为从已保存服务器中选择，密码／私钥／口令统一从凭据库解析，跳板同样可以复用共享凭据。保存与连接时会拒绝自指（服务器把自己设为跳板）、重复选择同一台、以及不存在的跳板资源；`profileConnect` 支持一次性覆盖某台服务器已保存的跳板链而不落库。旧记录里行内填写的跳板信息仍可读取。
- **已保存服务器连接复用**：同一台已保存服务器若已存在健康连接，再次点击「连接」会直接加入该连接而不是新建一条传输（`profileConnect` 的 `reuseExisting`）。跳板链被一次性覆盖时不复用，因为那是另一条路由。
- **终端跟随 DSH 明暗主题**：xterm 渲染在自己的 canvas 上，继承不了 CSS 文字色，原先固定深色背景在浅色主题下不可读。现提供完整的明／暗两套对比色板（含光标与选区），通过属性观察与 `prefers-color-scheme` 双向监听宿主主题，切换时立即重绘已经打开的终端；面板边框等颜色改为 CSS 变量以便随主题联动。
- **官方侧栏分栏按窗格独立工作（用户反馈修复）**：此前插件没有窗格概念，每个窗格都渲染同一份全局服务器列表，在任一窗格关闭标签都会立刻断开连接；而官方侧栏分栏时会把根节点从单窗格面板换成分栏容器，原窗格的面板体会被重新挂载。现在每个窗格维护独立的可见服务器与选中项，窗格身份取自宿主标签 id（重新挂载后不变），因此**开分栏不再清空原窗格的服务器与终端**、**新窗格默认空白、不继承已有服务器**；同一台服务器在两栏同时打开时共用一条传输，关掉其中一栏不影响另一栏，**两栏都关闭才真正断开宿主连接**。关闭整个 SSH 标签仍按既有契约不断开连接，但会释放引用，避免计数泄漏导致之后永远判断不出「最后一个」而无法断开；页面刷新后仍会收养宿主侧遗留的连接，使其可见可断。
- **测试**：新增分栏可见性、终端主题、连接复用三个用例文件；完整测试共 42 项通过。

## 0.3.2 - 2026-09-12

- **官方右侧 Sidebar 接入时序修复**：新版 DSH 的 `sidebarRightTabs` / `sidebarRight` 服务若晚于插件加载提供，SSH 不再永久误回退为独立抽屉。插件先保持旧版 DSH 的抽屉兼容路径，待两个服务就绪后释放抽屉并注册官方 SSH 标签；标签注册冲突时仍安全保留抽屉。
- **回归覆盖加强**：新增可执行 Sidebar 生命周期测试，覆盖服务晚注册、旧版宿主无服务和标签注册冲突三种分支；原有两阶段注册、无固定几何与终端池约束继续保留。
- **npm 安装包瘦身**：运行时包不再携带源码、截图和本地测试辅助程序；这些内容继续保留在 Git 仓库与 GitHub Release ZIP。压缩包从约 2.14 MB 降至约 0.54 MB。

## 0.3.1 - 2026-09-12

- **数据库半开连接不再卡死工具调用**：MySQL、PostgreSQL、Redis 与 MongoDB 的连接、取池连接、查询、游标读取、事务收尾及断开都增加客户端截止时间与取消信号传递。SSH 隧道或网络设备静默丢包时，调用会明确结束，受影响连接会被销毁而不会泄漏池槽位；`db_tx_commit` / `db_tx_rollback` 也可取消，事务结果不明时要求先核对数据。
- **旧版网络设备 SSH 兼容**：目标设备仅支持 `diffie-hellman-group14-sha1` 时，默认握手仅在明确的密钥交换不匹配后重试一次，并在工具结果和日志中显示降级警告；现代服务器保留默认算法。可通过 `legacy: true` 直接兼容，或 `legacy: false` 禁止降级。
- **侧栏终端图标**：更新为与新版官方 Sidebar 文件图标一致的填充样式。
- **测试**：新增半开 PostgreSQL、事务提交取消和旧 VRP 密钥交换的回归覆盖；完整测试共 38 项通过。

## 0.3.0 - 2026-09-10

- **ssh_exec 继承交互 shell 的当前目录（用户反馈修复）**：Linux 上存在唯一、空闲的 POSIX 交互 shell 时，通过同一 `SSH_CONNECTION`、TTY 与前台进程组定位它，成功进入 `/proc/<pid>/cwd` 后再执行命令，并把实际 `pwd` 作为 `cwd` 返回。后台 shell、多个候选、前台程序或不可访问目录均拒绝执行，避免相对路径落到错误位置；完全未检测到交互 shell 时沿用登录初始目录并明确标注。

- **接入官方右侧边栏（新版 DSH）**：SSH 终端从浮动面板改为官方右侧边栏的一个标签页，与内置「文件」标签并列。注册走官方公开的两段式路径——类型注册进 `ctx.sidebarRightTabs`（`kind: "ssh"`，页面型、无地址 patterns），面板体注册进按 id 分发的 `sidebar.right.pane.tab` 槽位，并附「SSH 终端」引导页入口，配与官方图标同风格的自绘终端图标（官方图标集无终端字形，16px 描边、1.3px 线宽、圆角端点，与文件夹图标视觉一致）。宽度、分栏、收起、全屏全部交由官方侧栏管理；聊天列不再被撑出右边距，删除了固定定位、独立拖宽与 better-sidebar 让位等旧占位逻辑，不再有覆盖与空白。会话顶栏的 **SSH** 按钮改为打开或聚焦该标签（`sidebarRight.openTab`，重复点击只聚焦、不重复创建；侧栏收起时点击自动展开），按钮高亮随标签可见性轮询同步；空状态的「添加服务器」改为蓝色实心 CTA 按钮（带悬停态），不再是一个不起眼的虚线加号。
- **连接生命周期与标签显示分离**：官方侧栏只渲染活动标签的面板体，切到「文件」即卸载 SSH 面板——为此新增终端常驻内存池（`terminal-pool.js`，按宿主 sessionId 键，LRU 上限 8）：卸载只解绑不销毁 xterm 实例，重开（重进标签、收起后再展开、切换聊天）通过重挂 `term.element` 恢复完整回看；同一会话被两个活动窗格同时挂载时，后者改为私有实例、绝不抢走前者的 DOM。卸载后宿主侧继续缓冲输出，重开时随流式通道自动补齐。
- **终端输出可靠续传**：宿主为终端历史维护单调位置，流式与轮询读取共享同一续传协议；标签重挂、流转轮询和多个分栏消费者都按位置读取，重复内容不会被误删，多消费者取消也不会重复回填。Agent 侧读取继续使用独立的 `captureBuffer`。
- **旧版 DSH 兼容回退**：客户端入口按 `ctx.get("sidebarRightTabs")` / `ctx.get("sidebarRight")` 特性检测（不硬注入，旧版不会卡在等待）；无官方侧栏时保持原浮动面板（抽屉拖宽、聊天列让位、Desktop 标题栏对齐逻辑原样迁入 `SshDrawer.jsx`）；官方侧栏上注册冲突（如 kind 被其他扩展占用）时同样回退。共享内容抽为 `SshPanel.jsx`（纯工作区，无外层几何），两个宿主复用；「设置 → 插件 → SSH 资源」两种模式不变。
- **文件页签新增「cd」按钮**：仅在交互 shell 空闲、输入行为空且终端状态可唯一确认时执行；草稿、前台程序或状态不明时明确拒绝，避免拼接并提交已有输入。
- **测试**：新增终端池、官方侧栏、目录继承和审查回归用例，覆盖 LRU、监听器清理、流式/轮询续传、多消费者、后台 shell、目录失效、终端草稿与安全 `cd`。

## 0.2.21 - 2026-09-06

- **终端输出流式推送**：宿主经 typert 流式 Remote（WebSocket mux）把终端输出实时推给面板，替代此前的 300ms 轮询长拉——持续输出（`top`、`tail -f`）更跟手；流不可用或中断时自动回落轮询，行为无感降级；闲置终端以 15s 心跳保活，安静但在线的会话不会被误判掉线。
- **批量执行并发上限**：`ssh_batch` 同时最多 4 台服务器并发连接执行（此前对所选服务器无界并发），结果仍按选择顺序返回。
- **宿主依赖基线升级到 0.1.2-rc.1**：`@deepseek-ai/dsh-*` 从 rc.7 显式升级（原 semver 范围被预发布规则锁死），对齐宿主 0.1.2/0.1.3 的 Remote/credentials/ModuleLoader 面，无破坏性变化。
- **工程化整备**：工具注册拆分至 `src/tools/`（ssh-session/sftp/tunnel/batch/db 五组）；终端输入策略门与操作员镜像共用同一状态机；断线重试判定从错误文案正则改为 ssh2 error code；`fail()` 错误信封单源；`sshConfigImport` 改异步读取；引入 eslint（flat config）+ .editorconfig，CI 新增 lint 步骤；测试迁移到 `node --test` 并新增 ssh_write 定向/凭据保存连接链路/SFTP 工具/流式推送五个测试文件（共 15 个）。
- **README 安全提示**：`ssh_connect`/`db_connect` 明文传参会进入对话记录，生产环境建议保存资源走加密凭据库。

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
