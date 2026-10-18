谢谢这份需求，方向我认同：远程工作区比再加一个运维功能都重要。已经按你提的 P0（路径 C）做完了，下一个版本带上。路径 A 仍然是当前的死路——我核对了宿主运行时源码，是三个各自独立的硬点，硬拼出来只会得到「read 打到远端、grep 只搜本地」的静默错误，比不支持更糟。下面是逐条回复。

### 1) 方向与插件归属

留在 dsh-ssh-ops 里，不拆新插件。远程工作区的操作面就是 `ssh_exec` / `sftp_*` 和 SFTP 面板，两者共用同一套连接、凭据、known_hosts 与路径解析；拆开就要复制一份连接层，长期会长出两套「同一台服务器」的状态。运维工具集不是另一个产品，它是远程工作区的 UI。

### 2) 路径 A 的宿主侧可行性

不可行。三个独立的硬点：

- `ctx.fs` 由单个 cordis 插件挂载，二选一：`@deepseek-ai/dsh-fs-local`，或包装它的 `@deepseek-ai/dsh-fs-sandbox`。`FileSystem extends Service`，构造函数就是 `super(ctx, "fs")`，一个 cordis 树里只有一个 fs 服务实例，没有「按工作区注册后端」的位置。`LocalFileSystem` 的 Config 只有 `cwd` 和 `diffBasisMaxBytes`，而 `cwd` 是解析默认值，不是包含边界。
- `glob` / `grep` 根本不经过 `ctx.fs`：`@deepseek-ai/dsh-tool-fs-search` 直接 spawn 打包在 `@vscode/ripgrep` 里的本地 rg 二进制、用 argv 向量跑。fs 后端换成远端，搜索仍然只搜本地。
- shell 侧同理，只有本地 `@deepseek-ai/dsh-subprocess-local` + `@deepseek-ai/dsh-terminal-bash`（本地 PTY），没有远端执行后端。

另外 `ctx.fs` 的 target 是 provider 私有对象、跨 provider 不可解释，真接远端要写完整的 `FileSystem` 子类再解决按工作区路由。这三件事缺一不可。值得提上游，我会提，标题方向是「per-workspace execution world / filesystem backend routing」，上面三条就是论据。

### 3) 先落哪一步（已实现）

入口：**设置 → SSH 资源 → 编辑资源 → 高级选项 → 远程工作区**（就在「默认项目目录」下面）。「编辑 SSH 资源」这次分成了「基本 / 高级选项」两页签，常用字段在基本，这类低频设置都在高级选项。

- 绑定 = 「一个 DSH 工作区 + 一台已保存服务器 + 一个远端绝对路径」。绑定存在插件自己的 storage domain 里，不碰 DSH 的工作区记录（`workspaceRegistry` 要求路径 realpath 存在，也没有 remote/kind 字段）。可改、可解除；删掉服务器资源时，它的绑定一并删除，不留孤儿。
- 填路径不用敲两遍：资源里填了「默认项目目录」的话，绑定那一行的路径框下面会出现一行「填入默认项目目录：/…」，点一下即填入。这两个字段语义不同所以没有合并——项目目录决定你手动点「进入项目」时终端和文件页签落在哪，绑定只决定 AI 的 `sftp_*` 落在哪。
- 提示词声明：绑定生效时会话的系统提示里多一段（`ctx.systemPrompt.context({name, order, text})`，order 取 `WORKING_DIRECTORY` 之后）：远端根在哪、该用什么工具、以及禁令——远端根之外拒绝写、删除走服务器端 `~/.dsh-trash`、本地 `read`/`write`/`edit`/`glob`/`grep` 与 bash 仍在操作者机器上，不要把它们的 not found 当成远端缺文件。
- `sftp_*` 默认落远端：8 个工具的相对路径以远端根解析，会话在工作区子目录时该子目录 1:1 映射到远端根下；绝对路径必须仍在根内，越界按 `remote-workspace-outside` 拒绝并报出根路径；显式传了别的 `connection_id` 按 `remote-workspace-offline` 拒绝——绑定绝不会静默改写到另一台机器。未绑定的工作区行为一字不变。
- 连接闸门复用既有三层：先复用该服务器已活的连接；否则要求绑定勾了「文件操作时自动连接」**且**设置页的「允许 AI 自动连接已保存服务器」总开关为开，才自动建连，并立即在右侧面板打开终端——自动连上的机器操作者始终看得见。任一条件不满足就诚实报 `remote-workspace-offline` 并指路「去面板连一下这台，或给这个工作区开自动连接」。
- 还没做（计划中）：终端打开时的 cwd 直接落远端根、SFTP 面板默认落点跟随绑定。这两处要改连接路径，比文件工具那条链路更靠后。
- @ 补全不跟随：它走 DSH 本地的 file-reference，属上游能力。这是已知限制，不是 bug。

回答你担心的「write 绕过命令档位」：路径 C 下天然不成立。原生 `read`/`write`/`edit` 只写本地 fs，远端工作区里写只能走 `sftp_write`，删除走 `sftp_delete` 并落到服务器端 `~/.dsh-trash`（可恢复）。命令档位只管命令，文件写入由插件的包含性检查约束。

### 4) SSH 入口是否按需显示

会做「只有存在已保存资源或活动会话时才显示」，但默认保持可见。多数用户把它当主力入口，直接藏起来像功能没了。实现上做成可折叠、无资源时不占位，而非整体移除。

### 5) 与 dsh-remote-ssh 共存

有真实语义冲突。dsh-remote-ssh 是「本地镜像目录 + 同步」，文件真的落在本地，斜杠命令和补全也在本地生效；这里的远程工作区是「本地目录只作身份，文件直连远端」，本地目录里没有内容。同一个目录被两套机制映射，就是同一路径两个真源，写冲突和「改了没生效」都会从这里冒出来。建议不要在同一个工作区同时启用；插件检测到这种配置会给出提示，这条是计划中，未实现。

### 接下来

路径 C 会随下一个版本发布，发布后我在这里补一句版本号。终端 cwd 跟随、SFTP 落点跟随、冲突提示是计划中；@ 补全跟随、远端搜索、远端 shell 需要上游，等 per-workspace execution world 的接缝出现再评估，上游 issue 提了我会把链接回在这里。
