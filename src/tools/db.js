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
import { pickSshConnectionId } from "../db-ops.js";

/** Cooperative tool-call budget; the db layer's own ceilings are all lower. */
export const DB_TOOL_TIMEOUT_MS = 60000;

export function registerDbTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "db_connect",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Connect to a database (MySQL, PostgreSQL, Redis, or MongoDB) so the agent can query or run commands in later db_query/db_execute/db_run calls. When an SSH server is connected, a loopback host (127.0.0.1/localhost) is automatically tunneled through the current server (via_ssh=auto), so 'connect to the database on the server' works without an internal connection id; pass via_ssh='no' to force a local connection, or ssh_connection_id to pick a specific server. For cloud-managed databases requiring TLS, set ssl to 'verify' (public-CA certs) or 'preferred' (self-signed certs). Returns a db_connection_id.",
    parameters: {
      type: { type: "string", enum: ["mysql", "postgresql", "redis", "mongodb"], required: true, description: "Database type." },
      host: { type: "string", required: true, description: "Database host. When reached via SSH, this is the address as seen from the SSH server (127.0.0.1 if the DB runs on that server)." },
      port: { type: "integer", required: true, description: "Database port (e.g. 3306 MySQL, 5432 PostgreSQL, 6379 Redis, 27017 MongoDB)." },
      database: { type: "string", description: "Database/schema name (MySQL/PostgreSQL/MongoDB) or numeric DB index (Redis)." },
      username: { type: "string", description: "Database username (not needed for Redis)." },
      password: { type: "string", description: "Database password." },
      ssl: { type: "string", enum: ["disabled", "preferred", "verify"], description: "TLS mode: 'disabled' (default) plain TCP; 'preferred' encrypt without cert verification (self-signed cloud DBs); 'verify' encrypt and verify CA (public-CA cloud DBs)." },
      ssh_connection_id: { type: "string", description: "Optional. An existing SSH connection id to tunnel through, reaching databases on private networks. Takes precedence over via_ssh." },
      via_ssh: { type: "string", enum: ["auto", "yes", "no"], description: "Tunnel routing when ssh_connection_id is omitted: 'auto' (default) tunnels loopback hosts (127.0.0.1/localhost) through the current SSH server; 'yes' always tunnels through the current server; 'no' always connects directly." },
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
        sshConnectionId: routed.sshConnectionId, name: args.name, signal: exec?.signal
      });
      if (!result.ok) throw new Error(`db_connect failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "db_list_connections",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "List currently open database connections (db_connection_id, type, host, port). Use it only when the user asks which databases are connected.",
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
              ssl: { type: "string", required: true },
              sshConnectionId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
              createdAt: { type: "string", required: true }
            }
          }}
        }
      },
      render(_args, value) {
        if (!value.connections.length) return [{ type: "text", text: "No database connection is currently open." }];
        return [{ type: "text", text: value.connections.map((c) => `- ${c.name} (${c.type}): ${c.host}:${c.port}${c.sshConnectionId ? " via SSH" : ""} (id: ${c.dbConnectionId})`).join("\n") }];
      }
    },
    async execute(_args, exec) {
      const result = await service.dbListConnections({ signal: exec?.signal });
      if (!result.ok) throw new Error(`db_list_connections failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "db_query",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Run a read-only SQL query on a connected MySQL or PostgreSQL database and return columns and rows. Read-only is LEXICALLY ENFORCED: only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH(read-only) statements pass; write verbs, SELECT INTO, FOR UPDATE locking reads and data-modifying CTEs are rejected (use db_execute for writes, db_tx_* for verified change workflows). For Redis or MongoDB, use db_run instead. Results stream and are capped at 200 rows; queries time out after 30s.",
    parameters: {
      db_connection_id: { type: "string", required: true, description: "A db_connection_id from db_connect." },
      sql: { type: "string", required: true, description: "SELECT statement. MySQL uses ? placeholders, PostgreSQL uses $1 placeholders." },
      params: { type: "array", description: "Optional parameter values for placeholders." }
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
  }));

  ctx.tools.register(defineTool({
    name: "db_execute",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Run a write SQL statement (INSERT/UPDATE/DELETE/CREATE/ALTER) on a connected MySQL or PostgreSQL database. Destructive statements (DROP/TRUNCATE/SHUTDOWN, detected by leading statement verb so keywords inside string literals or comments are not false-positives) are not executed by the agent: the SQL is returned as a copyable card to paste into the database panel's SQL editor and run manually. For Redis or MongoDB, use db_run instead.",
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
          sql: { type: "string" }
        }
      },
      render(_args, value) {
        if (value.blocked) {
          return [{ type: "text", text: `⚠️ 已拦截：${value.reason ?? ""}\nSQL 未执行，请在数据库面板 SQL 编辑器粘贴执行：\n\`\`\`sql\n${value.sql ?? ""}\n\`\`\`\n请勿重试/绕行，由人工执行。` }];
        }
        let text = `Affected ${value.affectedRows} row(s).`;
        if (value.insertId !== undefined) text += ` Insert id: ${value.insertId}.`;
        return [{ type: "text", text }];
      }
    },
    async execute(args, exec) {
      const result = await service.dbExecute({ dbConnectionId: args.db_connection_id, sql: args.sql, params: args.params, signal: exec?.signal });
      if (!result.ok) {
        if (result.error.code === "unsafe-sql") {
          return { affectedRows: 0, truncated: false, blocked: true, reason: result.error.message, sql: args.sql };
        }
        throw new Error(`db_execute failed: ${result.error.message}`);
      }
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "db_list_tables",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "List tables in the current schema of a connected MySQL or PostgreSQL database. For MongoDB, use db_run with operation 'countDocuments' on a collection instead.",
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
  }));

  ctx.tools.register(defineTool({
    name: "db_describe_table",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Full structural introspection of a table in a connected MySQL or PostgreSQL database: columns (name, type, nullable, default), indexes, foreign keys, row-count/data-size estimates from planner statistics, and the MySQL SHOW CREATE TABLE DDL.",
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
  }));

  ctx.tools.register(defineTool({
    name: "db_preview",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Sample rows of a table (SELECT * with LIMIT/OFFSET) on a connected MySQL or PostgreSQL database without hand-writing SQL. Returns columns, rows, and a row-count estimate from planner statistics (no full-table COUNT). The table identifier is validated against injection; limit/offset are bound as parameters.",
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
  }));

  ctx.tools.register(defineTool({
    name: "db_explain",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Get the execution plan of a SELECT/WITH query (MySQL EXPLAIN FORMAT=JSON / PostgreSQL EXPLAIN (FORMAT JSON)) on a connected database, e.g. to check index usage before optimizing. The statement must pass the same lexically read-only gate as db_query.",
    parameters: {
      db_connection_id: { type: "string", required: true },
      sql: { type: "string", required: true, description: "SELECT or WITH ... SELECT statement to explain." },
      params: { type: "array", description: "Optional parameter values for placeholders." }
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
  }));

  ctx.tools.register(defineTool({
    name: "db_tx_begin",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Begin an interactive transaction on a dedicated connection (MySQL/PostgreSQL) for verified change workflows: db_tx_begin → db_tx_execute (the write) → db_tx_execute (SELECT to verify) → db_tx_commit or db_tx_rollback. Idle transactions are rolled back automatically after 5 minutes.",
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
  }));

  ctx.tools.register(defineTool({
    name: "db_tx_execute",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Run one statement inside a transaction opened with db_tx_begin. Use SELECT there to verify the effect of your write before committing. Destructive verbs (DROP/TRUNCATE/SHUTDOWN) remain blocked.",
    parameters: {
      tx_id: { type: "string", required: true },
      sql: { type: "string", required: true },
      params: { type: "array", description: "Optional parameter values for placeholders." }
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
  }));

  ctx.tools.register(defineTool({
    name: "db_tx_commit",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Commit a transaction opened with db_tx_begin. Call this only after db_tx_execute verification looked right.",
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
  }));

  ctx.tools.register(defineTool({
    name: "db_tx_rollback",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Roll back a transaction opened with db_tx_begin, undoing every statement executed in it.",
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
  }));

  ctx.tools.register(defineTool({
    name: "db_run",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Run a command on a connected Redis or MongoDB database. Redis: pass {command, args} (e.g. command='GET', args=['mykey'], or command='KEYS', args=['*']). MongoDB: pass {collection, operation} where operation is 'find'|'findOne'|'insertOne'|'updateOne'|'deleteOne'|'countDocuments', plus filter/document/update as needed. For MySQL/PostgreSQL, use db_query or db_execute instead.",
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
  }));

  ctx.tools.register(defineTool({
    name: "db_disconnect",
    timeoutMs: DB_TOOL_TIMEOUT_MS,
    description: "Close a database connection opened with db_connect. Use it when the user is done querying a database.",
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
  }));
}
