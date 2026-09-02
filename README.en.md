[中文](./README.md) · **English**

---

# DSH SSH Ops

> An SSH operations plugin for DeepSeek Harness: drive the current server from the main conversation while keeping a real interactive terminal on the right, with built-in file management, port forwarding, and database management.

![License](https://img.shields.io/badge/license-MIT-green)
![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)
![version](https://img.shields.io/badge/version-0.2.20-blue)

> **New in v0.2.20**: a dedicated **Command Library** tab in the SSH panel, with searchable built-in operations commands and a compact in-tab **+ Custom** editor for global, group, or per-server commands. Choosing a command only fills the terminal input; it never runs automatically.

## Screenshots

Drive the connected server directly from the main conversation, with a real interactive terminal on the right and panels for files (SFTP), tunnels, and databases:

![SSH main view](https://raw.githubusercontent.com/caoyiwei850/dsh-ssh-ops/main/assets/screenshots/ssh-main-view.png)

![File management (SFTP)](https://raw.githubusercontent.com/caoyiwei850/dsh-ssh-ops/main/assets/screenshots/ssh-files-tab.png)

![Port forwarding](https://raw.githubusercontent.com/caoyiwei850/dsh-ssh-ops/main/assets/screenshots/ssh-tunnels-tab.png)

![Database management](https://raw.githubusercontent.com/caoyiwei850/dsh-ssh-ops/main/assets/screenshots/db-panel.png)

![SSH resources](https://raw.githubusercontent.com/caoyiwei850/dsh-ssh-ops/main/assets/screenshots/ssh-resources.png)

## What it does

- Open a resizable xterm.js SSH terminal on the right of a session. When **DSH-better-sidebar** is also enabled, the terminal docks to the left of the sidebar instead of covering the file sidebar or the top-right controls.
- Manage any number of servers and groups under **Settings → Plugins → SSH Resources**; the top **SSH** toggle only shows or hides the right-side terminal.
- **Command library**: the SSH panel has a dedicated Command Library tab with system inspection, service, Docker, logs, networking, storage, scheduler, and Ubuntu/RHEL/CentOS install/update templates. Search matches command names and contents. Custom commands are managed inside this tab; they are stored only in browser local storage and must never contain passwords, tokens, or other secrets.
- Server name, address, port, username, auth type, and group are stored in DSH local storage; there is no count limit.
- Passwords, PEM private keys, and passphrases are stored **only** in DSH's official local credentials store `~/.dsh/.credentials.yaml` (owner-only permissions). Browser storage, agent context, tool results, and resource lists never read or display secrets.
- The main conversation auto-detects the currently-connected server on the right; the agent never has to ask the user for an internal connection id.
- Commands the agent runs via `ssh_exec` are echoed in the right-side terminal, and the exit code, output, duration, timeout, and truncation status are returned to the main conversation for analysis.
- Manual terminal output is read on demand via `ssh_read`; it is never silently injected into the conversation context.
- Output sent to the model is redacted for private keys, Bearer tokens, common passwords/API keys (including bare `sk-`-prefixed keys), and database passwords.
- **Connection stability**: SSH connections enable keepalive (20s interval, 3 checks), so NAT/firewalls no longer silently drop idle connections. Transport drops trigger exponential-backoff auto-reconnect (capped at 30s); a command that drops mid-run is retried once transparently. Transient connection failures auto-retry 3 times (auth failures excluded). Explicit disconnect or plugin unload never triggers reconnect; remote tunnels re-register automatically after a reconnect.
- **Host-key verification (TOFU)**: SSH connections verify the server's host public-key fingerprint — first connect records and trusts it, later changes are rejected (guards against MITM / re-provisioned servers). Per-server `hostKeyMode` selects `accept-new` (default) / `verify` (reject unseen) / `off`; on a changed fingerprint the connection is **not retried and not auto-reconnected**. Settings → SSH Resources lets you set the mode per server and manage trusted fingerprints with one-click forget. Verification runs before user authentication, so it is independent of who logs in or which password they use — the same server with an unchanged key never blocks another admin or vendor.
- **File management**: a Files tab in the SSH panel browses the server's filesystem over SFTP with upload, download, mkdir, delete, and rename. The `sftp_*` tools can also be used directly in the conversation.
- **Port forwarding**: a Tunnels tab starts local forwards (this machine → server-reachable target) and remote forwards (server → this machine), with a live tunnel list and stop control. The `tunnel_*` tools can also be used directly.
- **Multi-server batch**: say "batch exec <command>" in the conversation and the agent creates a batch task; the SSH panel pops a selection dialog listing **all saved servers (including not-yet-connected ones)** from SSH Resources for you to tick, then runs it concurrently after confirmation (each via its saved credentials: connect → run → disconnect), presenting results grouped per server (green success / red failure). The batch target is completely independent of the currently-open connection. When the command hits the safety policy, it is confirmed once as "command + N targets" rather than per-server. The legacy `ssh_cluster` (which fanned out over open connections with no confirmation) has been removed entirely: multi-server work goes only through `ssh_batch`'s operator-ticked confirmation, so a one-server request can never silently hit every connection.
- **Databases**: a Database tab connects to MySQL / PostgreSQL / Redis / MongoDB, runs SQL queries or commands manually, and shows results in a table. The `db_*` tools can also be used directly.
  - `db_connect` auto-tunnels over SSH: once a server is connected, loopback hosts (127.0.0.1 / localhost / ::1) are automatically tunneled through the current server to reach intranet databases. `via_ssh` selects `auto` (default) / `yes` / `no`; an explicit `ssh_connection_id` takes precedence.
  - Three SSL modes (`disabled` plain / `preferred` encrypt-without-verify / `verify` encrypt+verify-CA) for cloud-managed databases.
  - Database connections can be saved as profiles for one-click reconnect after restart; passwords are encrypted in the DSH credentials store; saved resources support renaming and collapsible grouping.
  - **Engineering loop**: `db_query` is a lexical read-only gate (only SELECT/SHOW/DESCRIBE/EXPLAIN/read-only WITH pass; write-verb subqueries, PG data-modifying CTEs, `SELECT INTO`, and `FOR UPDATE` locking reads are rejected); queries stream with a 200-row cap and 30s timeout (MySQL destroys the pool connection, PG paginates via a cursor); an interactive transaction workflow `db_tx_begin/execute/commit/rollback` (dedicated connection, verify-then-commit, auto-rollback after 5 min idle); `db_describe_table` reports indexes/foreign keys/DDL/row-count and size estimates; `db_preview` paginates samples, `db_explain` shows the plan. The database panel adds a table tree, preview view, one-click CSV export (with BOM for Excel), and query history (last 50 per connection in localStorage). DB transport loss no longer crashes the process (handled uniformly across all four clients, never throwing).
  - High-risk SQL (`DROP DATABASE`/`SCHEMA`/`TABLE`, `TRUNCATE`, `SHUTDOWN`) is auto-blocked, detected by **statement verb** (skipping strings/comments, supporting multi-statement), so keywords inside string literals are never false-positives.

## Security boundary

DSH's own permission mechanism remains in effect. This plugin additionally stops agent tools from executing clearly irreversible or destructive operations, such as deleting files, dropping databases, formatting disks, `terraform destroy`, `kubectl delete`, `docker prune`, forced Git cleanup, and reboot/shutdown.

When the agent hits the blocklist it is not silently refused: the plugin creates a one-shot **pending-confirmation** record and immediately pops a viewport-wide confirmation modal (full command, risk reason, and **Execute** / **Undo** buttons; Esc, clicking the backdrop, or "handle later in the panel" dismisses it temporarily — it closes automatically once every queued command is handled, and still-unhandled items pop up again when the panel reopens). Unhandled items also stay as cards above the SSH panel's terminal, collapsed to a one-line summary (command + host + always-visible Execute/Undo); the newest starts expanded, clicking expands the risk reason and full command. Only the operator's red **Execute** button submits the command (sending it to the server with Enter); **Undo** clears the record. The command is never pre-filled into the terminal — the input line stays empty, so the operator cannot accidentally run a blocked command by pressing Enter. Multiple dangerous commands queue independently as separate cards. If no live terminal session exists, or the command contains control characters like Tab that cannot be safely sent to a PTY, it degrades to a copyable command card returned in the conversation for the operator to paste into the terminal. Ordinary ops (configure SSL, install packages, edit configs, reload services) flow through DSH's normal permission process.

The same model covers `sftp_delete` (the agent no longer deletes directly; instead the equivalent `rm -rf <path>` is queued for confirmation) and `db_execute` high-risk SQL (`DROP`/`TRUNCATE`/`SHUTDOWN`): high-risk SQL keeps the same pattern, returning a card with a ```sql code block for the operator to paste into the database panel's SQL editor and run manually. SQL detection works by **statement verb** (skipping strings/comments, splitting on `;` for multi-statement), so keywords inside string literals are never false-positives, and high-frequency CRUD passes through normally.

## Installation

### From GitHub (recommended)

```bash
dsh plugin --profile web add github:caoyiwei850/dsh-ssh-ops#v0.2.20
```

Then restart DSH Web:

```bash
dsh web
```

Open any session, click the top **SSH** tab, and use the right-side panel to connect to a server.

### From a release archive

Download `dsh-ssh-ops-0.2.20.tgz` from [GitHub Releases](https://github.com/caoyiwei850/dsh-ssh-ops/releases/tag/v0.2.20), then:

```bash
dsh plugin --profile web add /path/to/dsh-ssh-ops-0.2.20.tgz
dsh web
```

`dsh-ssh-ops-0.2.20.zip` is for offline review or further development; extract it and run `npm install && npm run build` in the directory.

## Usage

1. Open **Settings → Plugins → SSH Resources** and create a group or server resource; PEM / `.key` files can be imported directly.
2. A saved resource can be "connect & open" to auto-create a right-side PTY terminal. When editing, leaving a secret field blank keeps the existing value; clearing credentials requires explicit confirmation.
3. The top **SSH** only toggles the right-side terminal; the `+` in the top-right picks a saved resource or creates a non-persistent temporary connection.
4. In the main conversation, just say "check server memory usage" or "configure the Nginx SSL certificate". The agent can only operate the active connection; it cannot enumerate saved resources, read credentials, or auto-connect using saved credentials.
5. For databases, have the agent call `db_connect` (or create a connection yourself in the Database tab), then query/execute from the conversation.
6. Optional: install the bundled native “Operations mode” preset with `npx --package=dsh-ssh-ops dsh-ssh-ops-install-ops-preset`. Restart DSH, then select “Operations mode” for a new conversation. An existing preset is never overwritten; add `--force` to update it from the package.

### Operations Agent preset

The package includes a native DSH “Operations mode” preset (`.agent-presets/ops`): it removes the local shell while retaining local file editing; server work uses dsh-ssh-ops SSH/SFTP/tunnel/batch/database tools, and it includes the `test-op` change-validation skill. Installation and selection are explicit, so it never changes the global persona or existing sessions automatically.

### Agent tools

There are 29 agent tools. Omitting `connection_id` / `db_connection_id` targets the active connection — **no need to call `ssh_list` / `db_list_connections` first**.

#### SSH (6)

| Tool | Purpose |
| --- | --- |
| `ssh_list` | List open SSH connections and identify the active server; only when the user asks which is connected |
| `ssh_connect` | Connect over SSH (password or private key) and make it the current server |
| `ssh_exec` | Run a command on the current server; returns exit code/output/duration/timeout/truncation/redacted state |
| `ssh_read` | Read buffered output from the right-side terminal on demand (never silently injected) |
| `ssh_write` | Send interactive input to a terminal; `press_enter` (default true) appends Enter so prompts are submitted like a real keypress (use `connection_id` to target a specific server's terminal) |
| `ssh_disconnect` | Close the current connection and its shell sessions |

#### SFTP (6)

| Tool | Purpose |
| --- | --- |
| `sftp_list` | List remote directory entries (with size/mtime/mode) |
| `sftp_read` | Read a remote file's contents (default cap 4 MiB) |
| `sftp_write` | Write text to a remote file (create or overwrite) |
| `sftp_mkdir` | Create a remote directory |
| `sftp_delete` | Delete a remote file or empty dir (**not executed directly**; queues `rm -rf <path>` for confirmation or returns a copyable card) |
| `sftp_rename` | Rename or move a remote path |

#### Port forwarding (3)

| Tool | Purpose |
| --- | --- |
| `tunnel_start` | Start a local forward (`local`, this machine → server-reachable target) or a remote forward (`remote`, server → this machine) |
| `tunnel_list` | List active tunnels |
| `tunnel_stop` | Stop a tunnel by `tunnel_id` |

#### Batch execution (1)

| Tool | Purpose |
| --- | --- |
| `ssh_batch` | Create a batch task over saved servers (including not-yet-connected ones) from SSH Resources; the operator ticks targets in the panel before it is dispatched concurrently, results grouped per server — **only when the user explicitly asks for multi-server batch** (the legacy `ssh_cluster` is removed entirely; there is no confirmation-free multi-server path) |

#### Database (14)

| Tool | Purpose |
| --- | --- |
| `db_connect` | Connect to MySQL / PostgreSQL / Redis / MongoDB; loopback hosts auto-tunnel through the current SSH server; three SSL modes |
| `db_list_connections` | List open database connections (only when the user asks) |
| `db_query` | Run a **lexically enforced read-only** query on MySQL/PostgreSQL (only SELECT/SHOW/DESCRIBE/EXPLAIN/read-only WITH pass; write verbs, `SELECT INTO`, `FOR UPDATE` locking reads and data-modifying CTEs are rejected); results stream with a 200-row cap and 30s timeout; supports `?` / `$1` placeholders |
| `db_execute` | Run a write statement (INSERT/UPDATE/DELETE/CREATE/ALTER); high-risk SQL (DROP/TRUNCATE/SHUTDOWN) is not executed, returns a copyable card |
| `db_list_tables` | List tables in the current schema of MySQL/PostgreSQL |
| `db_describe_table` | Full structure: columns, indexes, foreign keys, row-count/size estimates, plus MySQL `SHOW CREATE TABLE` DDL |
| `db_preview` | Paginated table sampling (bound LIMIT/OFFSET, injection-safe identifier whitelist) with a full-table row estimate — no SQL needed |
| `db_explain` | Execution plan (EXPLAIN FORMAT=JSON) to check index usage |
| `db_tx_begin` / `db_tx_execute` / `db_tx_commit` / `db_tx_rollback` | Interactive transaction workflow: begin → write → SELECT-verify → commit/rollback (dedicated connection, auto-rollback after 5 min idle) |
| `db_run` | Run a command on Redis (`command`+`args`), or `find`/`findOne`/`insertOne`/`updateOne`/`deleteOne`/`countDocuments` on MongoDB |
| `db_disconnect` | Close a database connection |

> Use `db_query` for read-only SQL, `db_execute` for SQL writes, and `db_run` for Redis/MongoDB. MySQL uses `?` placeholders; PostgreSQL uses `$1` placeholders.

## Development

```bash
npm install
npm test
npm run build
npm run pack:release
```

Pushing a `vX.Y.Z` tag that matches `package.json.version` runs tests, builds the release assets, and publishes the same tarball to npm and GitHub Releases. Configure the repository `NPM_TOKEN` secret before the first release.

Artifacts are written to `release/`:

- `dsh-ssh-ops-0.2.20.tgz`: installable directly by DSH.
- `dsh-ssh-ops-0.2.20.zip`: full offline source archive.

## License

[MIT](LICENSE)
