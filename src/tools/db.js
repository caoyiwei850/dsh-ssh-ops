/**
 * Agent tools for database operations (MySQL/PostgreSQL/Redis/MongoDB).
 * Read-only SQL is lexically enforced host-side; destructive statements are
 * returned as copyable cards instead of executed.
 *
 * Every tool declares a cooperative timeoutMs and forwards `exec.signal` down
 * to the driver layer. A half-open transport (SSH tunnel silently dropped: no
 * error event, no data) leaves driver promises that never settle, and the
 * registry cannot hard-kill same-process code — so without a declared budget
 * the dsh timeout policy skips these tools entirely and a hung db_query spins
 * forever, uninterruptible. The budget sits above the db layer's own
 * client-side deadlines so the agent gets the specific message ("timed out
 * connecting…", "…cancelled") from the layer that knows what hung.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { backupSummary, pickSshConnectionId } from "../db-ops.js";
import { t } from "../i18n/core.js";

/**
 * Cooperative tool-call budget. It must sit above the db layer's own ceilings
 * AND above the largest per-connection query_timeout_ms override
 * (DB_QUERY_TIMEOUT_MAX_MS, 30 min) so an opted-in slow-database connection
 * is never cut off by the tool budget. Default connections are unaffected in
 * practice: every driver await is still bounded by the db layer's own
 * deadlines (the 35s op ceiling fires first), so this budget only matters as
 * the last-resort backstop.
 */
export const DB_TOOL_TIMEOUT_MS = 1_860_000;

export function registerDbTools(ctx, service, { onDemand = false } = {}) {
  // Older hosts lack step-time admission. Keep their database tools available.
  const conditional = onDemand && typeof ctx.tools.resolve === "function"
    && typeof ctx.tools.executable === "function" && typeof ctx.tools.get === "function"
    && typeof ctx.on === "function";
  const activated = new WeakSet();
  const deferredNames = new Set();
  const admittedSteps = new WeakMap();
  const when = (step) => {
    const cached = admittedSteps.get(step);
    if (cached !== undefined) return cached;
    const { agent } = step;
    // A restricted agent may be allowed to query an existing connection
    // without permission to list connections. The host still applies its
    // tool filter before evaluating this condition.
    const admitted = activated.has(agent)
      || agent.session?.requestHeader?.()?.tools?.some(({ name }) => deferredNames.has(name)) === true
      || ctx.tools.get("db_list_connections", agent) === undefined;
    admittedSteps.set(step, admitted);
    return admitted;
  };

  if (conditional) {
    ctx.on("tools/result", ({ agent, name }, result) => {
      if (agent && !result.isError && (name === "db_connect" || name === "db_list_connections")) {
        activated.add(agent);
      }
    });
  }

  const registerOperation = (options) => {
    const definition = defineTool(options);
    if (!conditional) return ctx.tools.register(definition);
    deferredNames.add(definition.name);
    return ctx.tools.register(definition, { when });
  };

  ctx.tools.register(defineTool({
    name: "db_connect",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Connect to a database and return its ID for later database tools. See via_ssh for loopback routing and ssl for TLS."
      + (conditional ? " On success, database operations become available next step." : ""),
    parameters: {
      type: { type: "string", enum: ["mysql", "postgresql", "opengauss", "sqlite", "clickhouse", "redis", "mongodb"], required: true, description: "Database type." },
      host: { type: "string", description: "Database host (required for every type except sqlite). When reached via SSH, this is the address as seen from the SSH server (127.0.0.1 if the DB runs on that server)." },
      port: { type: "integer", description: "Database port; defaults per type (3306 MySQL, 5432 PostgreSQL/openGauss, 8123 ClickHouse, 6379 Redis, 27017 MongoDB). Not used by sqlite." },
      database: { type: "string", description: "Database/schema name (MySQL/PostgreSQL/openGauss/ClickHouse, optional), the SQLite file path (required for sqlite), or numeric DB index (Redis)." },
      username: { type: "string", description: "Database username (not needed for Redis)." },
      password: { type: "string", description: "Database password." },
      ssl: { type: "string", enum: ["disabled", "preferred", "verify"], description: "'disabled' (default): plain TCP. 'preferred': TLS without certificate verification. 'verify': TLS with CA verification." },
      ssh_connection_id: { type: "string", description: "Tunnel via this SSH ID. Overrides via_ssh." },
      via_ssh: { type: "string", enum: ["auto", "yes", "no"], description: "Without an SSH ID: 'auto' (default) tunnels localhost/127.0.0.1 via the active server if connected; 'yes' requires that tunnel; 'no' connects directly." },
      query_timeout_ms: { type: "integer", description: "Statement deadline in ms: default 35000, range 1000–1800000. 0 disables it, subject to the tool-call limit." },
      name: { type: "string", description: "Optional display name." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          dbConnectionId: { type: "string", required: true },
          name: { type: "string", required: true },
          type: { type: "string", required: true }
        }
      },
      render(args, value) {
        return [{ type: "text", text: `Connected ${value.type} ${args.host}:${args.port} (id: ${value.dbConnectionId})` }];
      }
    },
    async execute(args, exec) {
      const routed = pickSshConnectionId({
        sshConnectionId: args.ssh_connection_id,
        viaSsh: args.via_ssh,
        host: args.host,
        resolveActive: () => service.resolveConnection(undefined)
      });
      if (routed.error) throw new Error(`db_connect failed: ${routed.error.message}`);
      const result = await service.dbConnect({
        type: args.type, host: args.host, port: args.port, database: args.database,
        username: args.username, password: args.password, ssl: args.ssl,
        sshConnectionId: routed.sshConnectionId, name: args.name, signal: exec?.signal,
        ...(args.query_timeout_ms !== undefined ? { queryTimeoutMs: args.query_timeout_ms } : {})
      });
      if (!result.ok) throw new Error(`db_connect failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "db_list_connections",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "List open database connections with IDs, endpoints and accounts."
      + (conditional ? " Call this before using an existing connection, even with a known ID, to enable query, write, export and transaction tools next step." : ""),
    parameters: {},
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          connections: { type: "array", required: true, items: {
            type: "object", additionalProperties: false,
            properties: {
              dbConnectionId: { type: "string", required: true },
              name: { type: "string", required: true },
              type: { type: "string", required: true },
              host: { type: "string", required: true },
              port: { type: "integer", required: true },
              database: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
              username: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
              ssl: { type: "string", required: true },
              sshConnectionId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
              createdAt: { type: "string", required: true }
            }
          }}
        }
      },
      render(_args, value) {
        if (!value.connections.length) return [{ type: "text", text: "No database connection is currently open." }];
        const lines = value.connections.map((c) => {
          const endpoint = c.type === "sqlite" ? (c.database ?? "(no file)") : `${c.host}:${c.port}`;
          const metadata = [
            c.type !== "sqlite" && c.database ? `db: ${c.database}` : null,
            c.username ? `user: ${c.username}` : null,
            c.ssl && c.ssl !== "disabled" ? `TLS: ${c.ssl}` : null,
            c.sshConnectionId ? "via SSH" : null,
            c.queryTimeoutMs !== undefined ? `query timeout: ${c.queryTimeoutMs === 0 ? "none" : `${Math.round(c.queryTimeoutMs / 1000)}s`}` : null
          ].filter(Boolean);
          return `- ${c.name} (${c.type}): ${endpoint}${metadata.length ? ` · ${metadata.join(" · ")}` : ""} (id: ${c.dbConnectionId})`;
        });
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(_args, exec) {
      const result = await service.dbListConnections({ signal: exec?.signal });
      if (!result.ok) throw new Error(`db_list_connections failed: ${result.error.message}`);
      return result.value;
    }
  }));

  registerOperation({
    name: "db_query",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Run read-only SQL on MySQL/PostgreSQL. Allows SELECT, SHOW, DESCRIBE, EXPLAIN and read-only WITH. Rejects writes, SELECT INTO, locking reads and modifying CTEs. Streams up to 200 rows. Use db_execute or db_tx_* for writes, db_run for Redis/MongoDB.",
    parameters: {
      db_connection_id: { type: "string", required: true, description: "A db_connection_id from db_connect." },
      sql: { type: "string", required: true, description: "SELECT statement. MySQL uses ? placeholders, PostgreSQL uses $1 placeholders." },
      params: { type: "array", description: "Placeholder values." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          columns: { type: "array", required: true, items: { type: "string" } },
          rows: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
          rowCount: { type: "integer", required: true },
          truncated: { type: "boolean", required: true }
        }
      },
      render(args, value) {
        const header = value.columns.join("\t");
        const body = value.rows.map((r) => value.columns.map((c) => r[c] ?? "").join("\t")).join("\n");
        let text = header.length > 0 ? `${header}\n${body}` : "(empty)";
        if (value.truncated) text += "\n[truncated to 200 rows]";
        return [{ type: "text", text }];
      }
    },
    async execute(args, exec) {
      const result = await service.dbQuery({ dbConnectionId: args.db_connection_id, sql: args.sql, params: args.params, signal: exec?.signal });
      if (!result.ok) throw new Error(`db_query failed: ${result.error.message}`);
      return result.value;
    }
  });

  registerOperation({
    name: "db_execute",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Write SQL on MySQL/PostgreSQL. DROP TABLE backs up and quarantines by rename. DROP DATABASE, TRUNCATE and SHUTDOWN are blocked after backup. Never retry or bypass those protections. Only the operator can finalize deletion in the database panel. Use db_run for Redis/MongoDB.",
    parameters: {
      db_connection_id: { type: "string", required: true },
      sql: { type: "string", required: true, description: "Write statement. MySQL uses ? placeholders, PostgreSQL uses $1 placeholders." },
      params: { type: "array", description: "Optional parameter values." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          affectedRows: { type: "integer", required: true },
          insertId: { oneOf: [{ type: "integer" }, { type: "string" }] },
          truncated: { type: "boolean", required: true },
          blocked: { type: "boolean" },
          reason: { type: "string" },
          sql: { type: "string" },
          quarantined: { type: "boolean" },
          renamedTo: { type: "string" },
          notice: { type: "string" },
          backup: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                target: { type: "string", required: true },
                path: { type: "string" },
                schemaPath: { type: "string" },
                bytes: { type: "integer" },
                truncated: { type: "boolean" },
                error: { type: "string" }
              }
            }
          }
        }
      },
      render(_args, value) {
        if (value.quarantined) {
          const lines = [t(`♻️ DROP 已转换为隔离改名（数据未删除，可随时改回）：${value.sql} → ${value.renamedTo}`)];
          if (Array.isArray(value.backup) && value.backup.length > 0) {
            lines.push(backupSummary(value.backup));
          }
          lines.push(value.notice ?? t("彻底删除请由操作者在数据库面板执行。"));
          return [{ type: "text", text: lines.join("\n") }];
        }
        if (value.blocked) {
          const backupNote = Array.isArray(value.backup) && value.backup.length > 0 ? `\n${backupSummary(value.backup)}` : "";
          return [{ type: "text", text: t(`⚠️ 已拦截：${value.reason ?? ""}\nSQL 未执行，请在数据库面板 SQL 编辑器粘贴执行：\n\`\`\`sql\n${value.sql ?? ""}\n\`\`\`${backupNote}\n请勿重试/绕行，由人工执行。`) }];
        }
        let text = `Affected ${value.affectedRows} row(s).`;
        if (value.insertId !== undefined) text += ` Insert id: ${value.insertId}.`;
        return [{ type: "text", text }];
      }
    },
    async execute(args, exec) {
      const result = await service.dbExecute({ dbConnectionId: args.db_connection_id, sql: args.sql, params: args.params, signal: exec?.signal, origin: "agent" });
      if (!result.ok) {
        if (result.error.code === "unsafe-sql") {
          const hasBackup = Array.isArray(result.error.backup) && result.error.backup.length > 0;
          return {
            affectedRows: 0, truncated: false, blocked: true,
            reason: result.error.message, sql: args.sql,
            ...(hasBackup ? { backup: result.error.backup } : {})
          };
        }
        throw new Error(`db_execute failed: ${result.error.message}`);
      }
      return result.value;
    }
  });

  registerOperation({
    name: "db_list_tables",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "List tables in the current MySQL/PostgreSQL schema. For MongoDB collection counts use db_run with countDocuments.",
    parameters: {
      db_connection_id: { type: "string", required: true }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { tables: { type: "array", required: true, items: { type: "string" } } } },
      render(_args, value) {
        return [{ type: "text", text: value.tables.length ? value.tables.join("\n") : "(no tables)" }];
      }
    },
    async execute(args, exec) {
      const result = await service.dbListTables({ dbConnectionId: args.db_connection_id, signal: exec?.signal });
      if (!result.ok) throw new Error(`db_list_tables failed: ${result.error.message}`);
      return result.value;
    }
  });

  registerOperation({
    name: "db_describe_table",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Describe a MySQL/PostgreSQL table: columns, indexes, foreign keys, estimated rows/size and MySQL CREATE TABLE DDL.",
    parameters: {
      db_connection_id: { type: "string", required: true },
      table: { type: "string", required: true, description: "Table name." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          table: { type: "string", required: true },
          columns: { type: "array", required: true, items: {
            type: "object", additionalProperties: false,
            properties: {
              name: { type: "string", required: true },
              type: { type: "string", required: true },
              nullable: { type: "boolean", required: true },
              key: { type: "string" },
              default: { oneOf: [{ type: "string" }, { type: "null" }, { type: "number" }] },
              extra: { oneOf: [{ type: "string" }, { type: "null" }] }
            }
          }},
          indexes: { type: "array", required: true, items: {
            type: "object", additionalProperties: false,
            properties: {
              name: { type: "string", required: true },
              unique: { type: "boolean", required: true },
              columns: { type: "array", required: true, items: { type: "string" } },
              definition: { oneOf: [{ type: "string" }, { type: "null" }], required: true }
            }
          }},
          foreignKeys: { type: "array", required: true, items: {
            type: "object", additionalProperties: false,
            properties: {
              name: { type: "string", required: true },
              column: { type: "string", required: true },
              foreignTable: { type: "string", required: true },
              foreignColumn: { type: "string", required: true }
            }
          }},
          ddl: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
          stats: {
            oneOf: [
              { type: "object", additionalProperties: false, properties: {
                estimatedRows: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
                dataBytes: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
                indexBytes: { oneOf: [{ type: "integer" }, { type: "null" }], required: true }
              } },
              { type: "null" }
            ],
            required: true
          }
        }
      },
      render(args, value) {
        const lines = [`${args.table}:`];
        lines.push(value.columns.map((c) => `${c.name}\t${c.type}\t${c.nullable ? "NULL" : "NOT NULL"}${c.default !== undefined && c.default !== null ? `\tDEFAULT ${c.default}` : ""}`).join("\n"));
        if (value.indexes?.length) {
          lines.push("", "indexes:");
          for (const idx of value.indexes) {
            const cols = idx.columns?.length ? ` (${idx.columns.join(", ")})` : "";
            const def = idx.definition ? ` — ${idx.definition}` : "";
            lines.push(`  ${idx.name}${idx.unique ? " UNIQUE" : ""}${cols}${def}`);
          }
        }
        if (value.foreignKeys?.length) {
          lines.push("", "foreign keys:");
          for (const fk of value.foreignKeys) lines.push(`  ${fk.column} → ${fk.foreignTable}.${fk.foreignColumn} (${fk.name})`);
        }
        if (value.stats) {
          const bits = [];
          if (value.stats.estimatedRows != null) bits.push(`~${value.stats.estimatedRows} rows`);
          if (value.stats.dataBytes != null) bits.push(`data ${(value.stats.dataBytes / 1048576).toFixed(2)}MB`);
          if (value.stats.indexBytes != null) bits.push(`index ${(value.stats.indexBytes / 1048576).toFixed(2)}MB`);
          if (bits.length) lines.push("", `stats: ${bits.join(", ")}`);
        }
        if (value.ddl) lines.push("", "DDL:", value.ddl);
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      const result = await service.dbDescribeTable({ dbConnectionId: args.db_connection_id, table: args.table, signal: exec?.signal });
      if (!result.ok) throw new Error(`db_describe_table failed: ${result.error.message}`);
      return result.value;
    }
  });

  registerOperation({
    name: "db_preview",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Sample MySQL/PostgreSQL table rows with pagination. Returns columns, rows and a planner row-count estimate.",
    parameters: {
      db_connection_id: { type: "string", required: true },
      table: { type: "string", required: true, description: "Table name, optionally schema-qualified (e.g. public.users)." },
      limit: { type: "integer", description: "Rows per page, 1-200, default 50." },
      offset: { type: "integer", description: "Rows to skip, default 0 (use for pagination)." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          table: { type: "string", required: true },
          columns: { type: "array", required: true, items: { type: "string" } },
          rows: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
          rowCount: { type: "integer", required: true },
          truncated: { type: "boolean", required: true },
          limit: { type: "integer", required: true },
          offset: { type: "integer", required: true },
          estimatedTotal: { oneOf: [{ type: "integer" }, { type: "null" }], required: true }
        }
      },
      render(_args, value) {
        const header = value.columns.join("\t");
        const body = value.rows.map((r) => value.columns.map((c) => r[c] ?? "").join("\t")).join("\n");
        const range = value.rowCount > 0 ? `${value.offset + 1}-${value.offset + value.rowCount}` : "0";
        const est = value.estimatedTotal != null ? ` (estimate ~${value.estimatedTotal})` : "";
        let text = `${value.table} rows ${range}${est}:\n${header.length > 0 ? `${header}\n${body}` : "(empty)"}`;
        if (value.truncated) text += "\n[truncated to 200 rows]";
        return [{ type: "text", text }];
      }
    },
    async execute(args, exec) {
      const result = await service.dbPreview({ dbConnectionId: args.db_connection_id, table: args.table, limit: args.limit, offset: args.offset, signal: exec?.signal });
      if (!result.ok) throw new Error(`db_preview failed: ${result.error.message}`);
      return result.value;
    }
  });

  registerOperation({
    name: "db_explain",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Get a MySQL/PostgreSQL JSON execution plan for SELECT/WITH. Applies the db_query read-only gate.",
    parameters: {
      db_connection_id: { type: "string", required: true },
      sql: { type: "string", required: true, description: "SELECT or WITH ... SELECT statement to explain." },
      params: { type: "array", description: "Placeholder values." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { plan: { type: "json", required: true } } },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value.plan, null, 2) }];
      }
    },
    async execute(args, exec) {
      const result = await service.dbExplain({ dbConnectionId: args.db_connection_id, sql: args.sql, params: args.params, signal: exec?.signal });
      if (!result.ok) throw new Error(`db_explain failed: ${result.error.message}`);
      return result.value;
    }
  });

  registerOperation({
    name: "db_export",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Export read-only SELECT/WITH rows to CSV or JSON. Over SSH, writes a remote file retrievable by SFTP. Direct connections return small results inline.",
    parameters: {
      db_connection_id: { type: "string", required: true },
      sql: { type: "string", required: true, description: "SELECT or WITH ... SELECT statement whose rows are exported." },
      format: { type: "string", enum: ["csv", "json"], description: "Export format; defaults to csv." },
      delimiter: { type: "string", enum: ["comma", "tab", "semicolon", "pipe"], description: "CSV field delimiter; defaults to comma." },
      header: { type: "boolean", description: "Include a header row in CSV output; defaults to true." },
      path: { type: "string", description: "Remote path to write to when the connection runs through SSH; defaults to /tmp/dsh-export-<connection>-<timestamp>.<ext>." },
      max_rows: { type: "integer", description: "Row cap for the export; defaults to 50000, maximum 200000." },
      params: { type: "array", description: "Placeholder values." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          format: { type: "string", required: true },
          columns: { type: "array", required: true, items: { type: "string" } },
          rows: { type: "integer", required: true },
          bytes: { type: "integer", required: true },
          truncated: { type: "boolean", required: true },
          path: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
          content: { type: "string" }
        }
      },
      render(_args, value) {
        const where = value.path !== null
          ? `written to ${value.path} (pull it with the SFTP tools)`
          : "returned inline";
        const more = value.truncated ? " [truncated at the row cap]" : "";
        return [{ type: "text", text: `db_export ${value.format}: ${value.rows} row(s), ${value.bytes} bytes ${where}${more}` }];
      }
    },
    async execute(args, exec) {
      const result = await service.dbExport({
        dbConnectionId: args.db_connection_id, sql: args.sql, format: args.format,
        delimiter: args.delimiter, header: args.header, path: args.path,
        maxRows: args.max_rows, params: args.params, signal: exec?.signal
      });
      if (!result.ok) throw new Error(`db_export failed: ${result.error.message}`);
      return result.value;
    }
  });

  registerOperation({
    name: "db_tx_begin",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Start a dedicated MySQL/PostgreSQL transaction. Write and verify with db_tx_execute, then commit or roll back. Rolls back after 5 minutes idle.",
    parameters: {
      db_connection_id: { type: "string", required: true }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { txId: { type: "string", required: true }, dbConnectionId: { type: "string", required: true } } },
      render(_args, value) {
        return [{ type: "text", text: `Transaction ${value.txId} started on ${value.dbConnectionId}. Run db_tx_execute next; finish with db_tx_commit or db_tx_rollback.` }];
      }
    },
    async execute(args, exec) {
      const result = await service.dbTxBegin({ dbConnectionId: args.db_connection_id, signal: exec?.signal });
      if (!result.ok) throw new Error(`db_tx_begin failed: ${result.error.message}`);
      return result.value;
    }
  });

  registerOperation({
    name: "db_tx_execute",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Run one statement in an open transaction. Verify changes with SELECT before committing. Blocks DROP, TRUNCATE and SHUTDOWN.",
    parameters: {
      tx_id: { type: "string", required: true },
      sql: { type: "string", required: true },
      params: { type: "array", description: "Placeholder values." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          affectedRows: { type: "integer", required: true },
          rowCount: { type: "integer", required: true },
          truncated: { type: "boolean", required: true },
          rows: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
          insertId: { oneOf: [{ type: "integer" }, { type: "string" }] }
        }
      },
      render(_args, value) {
        if (value.rowCount > 0) {
          const columns = value.rows[0] ? Object.keys(value.rows[0]) : [];
          const body = value.rows.map((r) => columns.map((c) => r[c] ?? "").join("\t")).join("\n");
          const header = columns.length > 0 ? `${columns.join("\t")}\n${body}` : "(empty)";
          const suffix = value.truncated ? "\n[truncated to 200 rows]" : "";
          return [{ type: "text", text: `${header}${suffix}` }];
        }
        let text = `Affected ${value.affectedRows} row(s).`;
        if (value.insertId !== undefined) text += ` Insert id: ${value.insertId}.`;
        return [{ type: "text", text }];
      }
    },
    async execute(args, exec) {
      const result = await service.dbTxExecute({ txId: args.tx_id, sql: args.sql, params: args.params, signal: exec?.signal });
      if (!result.ok) throw new Error(`db_tx_execute failed: ${result.error.message}`);
      return result.value;
    }
  });

  registerOperation({
    name: "db_tx_commit",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Commit an open transaction only after verifying changes with db_tx_execute.",
    parameters: { tx_id: { type: "string", required: true } },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { txId: { type: "string", required: true }, finished: { type: "boolean", required: true }, committed: { type: "boolean", required: true } } },
      render(_args, value) { return [{ type: "text", text: `Transaction ${value.txId} committed.` }]; }
    },
    async execute(args, exec) {
      const result = await service.dbTxCommit({ txId: args.tx_id, signal: exec?.signal });
      if (!result.ok) throw new Error(`db_tx_commit failed: ${result.error.message}`);
      return result.value;
    }
  });

  registerOperation({
    name: "db_tx_rollback",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Roll back an open transaction and undo its changes.",
    parameters: { tx_id: { type: "string", required: true } },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { txId: { type: "string", required: true }, finished: { type: "boolean", required: true }, rolledBack: { type: "boolean", required: true } } },
      render(_args, value) { return [{ type: "text", text: `Transaction ${value.txId} rolled back.` }]; }
    },
    async execute(args, exec) {
      const result = await service.dbTxRollback({ txId: args.tx_id, signal: exec?.signal });
      if (!result.ok) throw new Error(`db_tx_rollback failed: ${result.error.message}`);
      return result.value;
    }
  });

  registerOperation({
    name: "db_run",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Run Redis commands ({command,args}) or MongoDB collection operations ({collection,operation,filter,document,update,options}). For SQL use db_query or db_execute.",
    parameters: {
      db_connection_id: { type: "string", required: true },
      command: { type: "string", description: "Redis command name (e.g. GET, SET, KEYS, HGETALL)." },
      args: { type: "array", description: "Redis command arguments (as strings)." },
      collection: { type: "string", description: "MongoDB collection name." },
      operation: { type: "string", enum: ["find", "findOne", "insertOne", "updateOne", "deleteOne", "countDocuments"], description: "MongoDB operation." },
      filter: { type: "object", additionalProperties: true, description: "MongoDB query filter (for find/findOne/updateOne/deleteOne/countDocuments)." },
      document: { type: "object", additionalProperties: true, description: "MongoDB document to insert (insertOne)." },
      update: { type: "object", additionalProperties: true, description: "MongoDB update spec (updateOne)." },
      options: { type: "object", additionalProperties: true, description: "MongoDB update options (updateOne)." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { result: { type: "json" } } },
      render(_args, value) {
        const text = typeof value.result === "string" ? value.result : JSON.stringify(value.result, null, 2);
        return [{ type: "text", text }];
      }
    },
    async execute(args, exec) {
      const result = await service.dbRun({
        dbConnectionId: args.db_connection_id, command: args.command, args: args.args,
        collection: args.collection, operation: args.operation, filter: args.filter,
        document: args.document, update: args.update, options: args.options,
        signal: exec?.signal
      });
      if (!result.ok) throw new Error(`db_run failed: ${result.error.message}`);
      return result.value;
    }
  });

  registerOperation({
    name: "db_disconnect",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Close an open database connection when finished.",
    parameters: {
      db_connection_id: { type: "string", required: true }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { dbConnectionId: { type: "string", required: true }, disconnected: { type: "boolean", required: true } } },
      render(args) { return [{ type: "text", text: `Disconnected ${args.db_connection_id}` }]; }
    },
    async execute(args, exec) {
      const result = await service.dbDisconnect({ dbConnectionId: args.db_connection_id, signal: exec?.signal });
      if (!result.ok) throw new Error(`db_disconnect failed: ${result.error.message}`);
      return result.value;
    }
  });
}
