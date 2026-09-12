/**
 * Zod schemas for the dsh-ssh-ops wire contract. Bundled into both faces:
 * the host typert manifest validates incoming args and outgoing results, and
 * the client contribution validates the same envelope on the browser side.
 */
import { z } from "zod";

export const sshErrorSchema = z.object({
  code: z.string(),
  message: z.string()
});

export function okSchema(value) {
  return z.object({ ok: z.literal(true), value });
}

export function resultSchema(value) {
  return z.union([
    okSchema(value),
    z.object({ ok: z.literal(false), error: sshErrorSchema })
  ]);
}

// ── auth ────────────────────────────────────────────────────────────────────

export const passwordAuthSchema = z.object({
  kind: z.literal("password"),
  password: z.string()
});

export const keyAuthSchema = z.object({
  kind: z.literal("key"),
  privateKey: z.string(),
  passphrase: z.string().optional()
});

export const authSchema = z.union([passwordAuthSchema, keyAuthSchema]);

// ── host-key TOFU policy ─────────────────────────────────────────────────────
// accept-new: trust on first use, reject on change (OpenSSH accept-new).
// verify:     reject unseen hosts, reject on change.
// off:        skip host-key verification entirely (not recommended).

export const hostKeyModeSchema = z.enum(["accept-new", "verify", "off"]);

// ── connect ─────────────────────────────────────────────────────────────────

export const connectRequestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  auth: authSchema,
  readyTimeout: z.number().int().min(1000).max(120000).optional(),
  // Legacy KEX opt-in for old VRP/IOS devices that only offer SHA-1 group14.
  // Omitted → the plugin retries once automatically when the handshake fails
  // on KEX selection; true → use the legacy set up front (no downgrade
  // warning); false → modern algorithms only, no automatic retry.
  legacy: z.boolean().optional(),
  name: z.string().optional(),
  hostKeyMode: hostKeyModeSchema.optional(),
  proxyJump: z.array(z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().min(1),
    auth: authSchema,
    readyTimeout: z.number().int().min(1000).max(120000).optional(),
    hostKeyMode: hostKeyModeSchema.optional()
  })).optional()
});

export const connectResultSchema = resultSchema(
  z.object({
    connectionId: z.string(),
    name: z.string().optional(),
    host: z.string(),
    port: z.number(),
    username: z.string(),
    // Set when the handshake needed the legacy KEX set; `warning` carries the
    // user-facing explanation so a weakened transport is never silent.
    legacyFallback: z.boolean().optional(),
    warning: z.string().optional()
  })
);

// ── list ────────────────────────────────────────────────────────────────────

export const listRequestSchema = z.object({});

export const connectionInfoSchema = z.object({
  connectionId: z.string(),
  name: z.string().optional(),
  host: z.string(),
  port: z.number(),
  username: z.string(),
  connected: z.boolean(),
  sessions: z.array(z.string())
});

export const listResultSchema = resultSchema(
  z.object({
    connections: z.array(connectionInfoSchema),
    activeConnectionId: z.string().nullable()
  })
);

// ── saved SSH resources ────────────────────────────────────────────────────

const profileIdSchema = z.string().uuid();
const groupIdSchema = z.string().uuid();
export const profileAuthKindSchema = z.enum(["password", "key"]);

const profileMetadataSchema = z.object({
  name: z.string().min(1).max(120),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(128),
  authKind: profileAuthKindSchema,
  hostKeyMode: hostKeyModeSchema.default("accept-new")
});

export const profileSaveRequestSchema = profileMetadataSchema.extend({
  profileId: profileIdSchema.optional(),
  groupId: groupIdSchema.nullable().optional()
});

export const profileCredentialRefsSchema = z.object({
  password: z.string(),
  privateKey: z.string(),
  passphrase: z.string()
});

export const profileInfoSchema = profileMetadataSchema.extend({
  profileId: profileIdSchema,
  groupId: groupIdSchema.nullable(),
  groupName: z.string().nullable(),
  credentialConfigured: z.boolean(),
  passphraseConfigured: z.boolean(),
  connected: z.boolean()
});

export const profileSaveResultSchema = resultSchema(
  z.object({
    profile: profileInfoSchema,
    credentialRefs: profileCredentialRefsSchema
  })
);

export const profileListRequestSchema = z.object({});
export const profileListResultSchema = resultSchema(
  z.object({ profiles: z.array(profileInfoSchema) })
);

export const profileDeleteRequestSchema = z.object({ profileId: profileIdSchema });
export const profileDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean() }));

export const profileDisconnectRequestSchema = z.object({ profileId: profileIdSchema });
export const profileDisconnectResultSchema = resultSchema(z.object({ disconnected: z.number().int().min(0) }));

export const profileConnectRequestSchema = z.object({
  profileId: profileIdSchema,
  /** UI connects pass a shorter handshake budget and zero retries to fail fast. */
  readyTimeout: z.number().int().positive().max(120000).optional(),
  retries: z.number().int().min(0).max(5).optional()
});
export const profileConnectResultSchema = connectResultSchema;

export const cancelProfileConnectRequestSchema = z.object({ profileId: profileIdSchema.optional() });
export const cancelProfileConnectResultSchema = z.object({ cancelled: z.number().int().min(0) });

export const groupInfoSchema = z.object({
  groupId: groupIdSchema,
  name: z.string(),
  profileCount: z.number().int().nonnegative()
});
export const groupListRequestSchema = z.object({});
export const groupListResultSchema = resultSchema(z.object({ groups: z.array(groupInfoSchema) }));
export const groupSaveRequestSchema = z.object({ groupId: groupIdSchema.optional(), name: z.string().min(1).max(80) });
export const groupSaveResultSchema = resultSchema(z.object({ group: groupInfoSchema }));
export const groupDeleteRequestSchema = z.object({ groupId: groupIdSchema });
export const groupDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean(), movedProfiles: z.number().int().nonnegative() }));

// ── open shell session ──────────────────────────────────────────────────────

export const openSessionRequestSchema = z.object({
  connectionId: z.string().min(1),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(200).optional(),
  origin: z.enum(["workbench-ui", "agent", "plugin-ui", "unknown"]).optional()
});

export const sessionInfoSchema = z.object({
  sessionId: z.string(),
  connectionId: z.string(),
  cols: z.number(),
  rows: z.number(),
  alive: z.boolean()
});

export const openSessionResultSchema = resultSchema(sessionInfoSchema);

export const observableSessionSchema = z.object({
  sessionId: z.string(), connectionId: z.string(), name: z.string().optional(), host: z.string(), port: z.number(),
  openedAt: z.string(), origin: z.enum(["workbench-ui", "agent", "plugin-ui", "unknown"]), alive: z.boolean(),
  journalStartOffset: z.number().int().nonnegative(), journalEndOffset: z.number().int().nonnegative()
});
export const listObservableSessionsRequestSchema = z.object({});
export const listObservableSessionsResultSchema = resultSchema(z.object({ sessions: z.array(observableSessionSchema) }));

// ── write ───────────────────────────────────────────────────────────────────

export const writeRequestSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string()
});

export const writeResultSchema = resultSchema(
  z.object({ written: z.number() })
);

// ── agent-originated dangerous command confirmations ──────────────────────

export const pendingConfirmationSchema = z.object({
  confirmationId: z.string().uuid(),
  connectionId: z.string(),
  sessionId: z.string(),
  name: z.string().optional(),
  host: z.string(),
  command: z.string(),
  reason: z.string(),
  createdAt: z.string(),
  prefilled: z.boolean()
});

export const pendingConfirmationListRequestSchema = z.object({});
export const pendingConfirmationListResultSchema = resultSchema(
  z.object({ confirmations: z.array(pendingConfirmationSchema) })
);

export const pendingConfirmationActionRequestSchema = z.object({
  confirmationId: z.string().uuid()
});
export const pendingConfirmationApproveResultSchema = resultSchema(
  z.object({ executed: z.literal(true) })
);
export const pendingConfirmationCancelResultSchema = resultSchema(
  z.object({ cancelled: z.literal(true) })
);

// ── known-hosts management (operator only) ──────────────────────────────────

export const knownHostInfoSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  algorithm: z.string(),
  fingerprint: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string()
});

export const listKnownHostsRequestSchema = z.object({});
export const listKnownHostsResultSchema = resultSchema(
  z.object({ hosts: z.array(knownHostInfoSchema) })
);

export const forgetHostKeyRequestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22)
});
export const forgetHostKeyResultSchema = resultSchema(z.object({ forgotten: z.boolean() }));

// ── read ────────────────────────────────────────────────────────────────────

export const readRequestSchema = z.object({
  sessionId: z.string().min(1),
  timeoutMs: z.number().int().min(0).max(60000).optional(),
  after: z.number().int().nonnegative().safe().optional()
});

// Stream push: one sessionId, endless item stream. Each yielded item reuses
// the read() envelope so the client render path stays identical.
export const terminalStreamRequestSchema = z.object({
  sessionId: z.string().min(1),
  after: z.number().int().nonnegative().safe().optional()
});

export const changeDirectoryRequestSchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1).max(4096).refine((path) => path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(path))
});

export const readResultSchema = resultSchema(
  z.object({
    data: z.string(),
    startOffset: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
    exit: z.union([z.object({ code: z.number(), signal: z.number().optional() }), z.null()])
  })
);

export const readObservableSessionRequestSchema = z.object({
  sessionId: z.string().min(1), after: z.number().int().nonnegative().safe().optional(),
  maxBytes: z.number().int().min(1024).max(131072).optional()
});
export const readObservableSessionResultSchema = resultSchema(z.object({
  sessionId: z.string(), data: z.string(), journalStartOffset: z.number().int().nonnegative(), journalEndOffset: z.number().int().nonnegative(),
  startOffset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative(), cursorClamped: z.boolean(), hasMore: z.boolean(), alive: z.boolean(),
  exit: z.union([z.object({ code: z.number(), signal: z.number().optional() }), z.null()]), redacted: z.boolean()
}));

// ── resize ──────────────────────────────────────────────────────────────────

export const resizeRequestSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200)
});

export const resizeResultSchema = resultSchema(
  z.object({ cols: z.number(), rows: z.number() })
);

// ── close session ───────────────────────────────────────────────────────────

export const closeSessionRequestSchema = z.object({
  sessionId: z.string().min(1)
});

export const closeSessionResultSchema = resultSchema(
  z.object({ closed: z.boolean() })
);

// ── disconnect ──────────────────────────────────────────────────────────────

export const disconnectRequestSchema = z.object({
  connectionId: z.string().min(1)
});

export const disconnectResultSchema = resultSchema(
  z.object({ disconnected: z.boolean() })
);

// ── SFTP ────────────────────────────────────────────────────────────────────

const sftpEntrySchema = z.object({
  name: z.string(),
  isDirectory: z.boolean(),
  size: z.number(),
  mtime: z.number(),
  mode: z.number()
});

export const sftpListRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().optional()
});

export const sftpListResultSchema = resultSchema(
  z.object({ path: z.string(), entries: z.array(sftpEntrySchema) })
);

export const sftpStatRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1)
});

export const sftpStatResultSchema = resultSchema(sftpEntrySchema.and(z.object({ path: z.string() })));

export const sftpReadRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1),
  maxBytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional()
});

export const sftpReadResultSchema = resultSchema(
  z.object({ path: z.string(), data: z.string(), truncated: z.boolean(), bytes: z.number() })
);

export const sftpWriteRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1),
  data: z.string()
});

export const sftpWriteResultSchema = resultSchema(
  z.object({ path: z.string(), bytes: z.number() })
);

// ── SCP fallback (single-file upload/download only) ─────────────────────────

export const scpReadRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1),
  maxBytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional()
});

export const scpReadResultSchema = resultSchema(
  z.object({ path: z.string(), data: z.string(), truncated: z.boolean(), bytes: z.number() })
);

export const scpWriteRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1),
  data: z.string()
});

export const scpWriteResultSchema = resultSchema(
  z.object({ path: z.string(), bytes: z.number() })
);

export const sftpMkdirRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1)
});

export const sftpMkdirResultSchema = resultSchema(
  z.object({ path: z.string() })
);

export const sftpDeleteRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1)
});

export const sftpDeleteResultSchema = resultSchema(
  z.object({ path: z.string(), isDirectory: z.boolean() })
);

export const sftpRenameRequestSchema = z.object({
  connectionId: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1)
});

export const sftpRenameResultSchema = resultSchema(
  z.object({ from: z.string(), to: z.string() })
);

// ── Port forwarding ──────────────────────────────────────────────────────────

export const tunnelStartLocalRequestSchema = z.object({
  connectionId: z.string().optional(),
  bindAddr: z.string().optional(),
  bindPort: z.number().int().min(0).max(65535).optional(),
  remoteHost: z.string().min(1),
  remotePort: z.number().int().min(1).max(65535)
});

export const tunnelStartLocalResultSchema = resultSchema(
  z.object({
    tunnelId: z.string(),
    kind: z.literal("local"),
    bindAddr: z.string(),
    bindPort: z.number(),
    remoteHost: z.string(),
    remotePort: z.number()
  })
);

export const tunnelStartRemoteRequestSchema = z.object({
  connectionId: z.string().optional(),
  bindAddr: z.string().optional(),
  bindPort: z.number().int().min(0).max(65535).optional(),
  remoteHost: z.string().min(1),
  remotePort: z.number().int().min(1).max(65535),
  targetHost: z.string().min(1),
  targetPort: z.number().int().min(1).max(65535)
});

export const tunnelStartRemoteResultSchema = resultSchema(
  z.object({
    tunnelId: z.string(),
    kind: z.literal("remote"),
    bindAddr: z.string(),
    bindPort: z.number(),
    remoteHost: z.string(),
    remotePort: z.number(),
    targetHost: z.string(),
    targetPort: z.number()
  })
);

export const tunnelStopRequestSchema = z.object({
  connectionId: z.string().optional(),
  tunnelId: z.string().min(1)
});

export const tunnelStopResultSchema = resultSchema(
  z.object({ tunnelId: z.string(), stopped: z.boolean() })
);

export const tunnelListRequestSchema = z.object({
  connectionId: z.string().optional()
});

export const tunnelListResultSchema = resultSchema(
  z.object({
    tunnels: z.array(z.object({
      tunnelId: z.string(),
      kind: z.string(),
      bindAddr: z.string(),
      bindPort: z.number(),
      remoteHost: z.string().optional(),
      remotePort: z.number().optional(),
      targetHost: z.string().optional(),
      targetPort: z.number().optional(),
      active: z.boolean()
    }))
  })
);

// ── SSH config import ─────────────────────────────────────────────────────────

export const sshConfigImportRequestSchema = z.object({});

export const sshConfigImportResultSchema = resultSchema(
  z.object({
    hosts: z.array(z.object({
      name: z.string(),
      host: z.string(),
      port: z.number(),
      username: z.string(),
      authKind: z.string(),
      identityFile: z.string(),
      proxyJump: z.string()
    }))
  })
);

// ── Database ops ─────────────────────────────────────────────────────────────

export const dbTypeSchema = z.enum(["mysql", "postgresql", "redis", "mongodb"]);
export const dbSslSchema = z.enum(["disabled", "preferred", "verify"]).default("disabled");

export const dbConnectRequestSchema = z.object({
  type: dbTypeSchema,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  ssl: dbSslSchema,
  sshConnectionId: z.string().optional(),
  name: z.string().optional(),
  signal: z.any().optional()
});

export const dbConnectionInfoSchema = z.object({
  dbConnectionId: z.string(),
  name: z.string(),
  type: dbTypeSchema,
  host: z.string(),
  port: z.number(),
  database: z.string().nullable(),
  username: z.string().nullable(),
  ssl: z.string(),
  sshConnectionId: z.string().nullable(),
  createdAt: z.string()
});

export const dbConnectResultSchema = resultSchema(
  z.object({ dbConnectionId: z.string(), name: z.string(), type: dbTypeSchema })
);

export const dbListConnectionsRequestSchema = z.object({ signal: z.any().optional() });
export const dbListConnectionsResultSchema = resultSchema(
  z.object({ connections: z.array(dbConnectionInfoSchema) })
);

export const dbQueryRequestSchema = z.object({
  dbConnectionId: z.string().min(1),
  sql: z.string().min(1),
  params: z.array(z.any()).optional(),
  signal: z.any().optional()
});
export const dbQueryResultSchema = resultSchema(
  z.object({
    columns: z.array(z.string()),
    rows: z.array(z.any()),
    rowCount: z.number(),
    truncated: z.boolean()
  })
);

export const dbExecuteRequestSchema = z.object({
  dbConnectionId: z.string().min(1),
  sql: z.string().min(1),
  params: z.array(z.any()).optional(),
  signal: z.any().optional()
});
export const dbExecuteResultSchema = resultSchema(
  z.object({
    affectedRows: z.number(),
    insertId: z.any().optional(),
    truncated: z.boolean()
  })
);

export const dbListTablesRequestSchema = z.object({ dbConnectionId: z.string().min(1), signal: z.any().optional() });
export const dbListTablesResultSchema = resultSchema(
  z.object({ tables: z.array(z.string()) })
);

export const dbDescribeTableRequestSchema = z.object({
  dbConnectionId: z.string().min(1),
  table: z.string().min(1),
  signal: z.any().optional()
});
export const dbDescribeTableResultSchema = resultSchema(
  z.object({
    table: z.string(),
    columns: z.array(z.object({
      name: z.string(),
      type: z.string(),
      nullable: z.boolean(),
      key: z.string().optional(),
      default: z.any().optional(),
      extra: z.string().nullable().optional()
    })),
    indexes: z.array(z.object({
      name: z.string(),
      unique: z.boolean(),
      columns: z.array(z.string()),
      definition: z.string().nullable()
    })),
    foreignKeys: z.array(z.object({
      name: z.string(),
      column: z.string(),
      foreignTable: z.string(),
      foreignColumn: z.string()
    })),
    ddl: z.string().nullable(),
    stats: z.object({
      estimatedRows: z.number().nullable(),
      dataBytes: z.number().nullable(),
      indexBytes: z.number().nullable()
    }).nullable()
  })
);

export const dbPreviewRequestSchema = z.object({
  dbConnectionId: z.string().min(1),
  table: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
  signal: z.any().optional()
});
export const dbPreviewResultSchema = resultSchema(
  z.object({
    table: z.string(),
    columns: z.array(z.string()),
    rows: z.array(z.any()),
    rowCount: z.number(),
    truncated: z.boolean(),
    limit: z.number(),
    offset: z.number(),
    estimatedTotal: z.number().nullable()
  })
);

export const dbExplainRequestSchema = z.object({
  dbConnectionId: z.string().min(1),
  sql: z.string().min(1),
  params: z.array(z.any()).optional(),
  signal: z.any().optional()
});
export const dbExplainResultSchema = resultSchema(
  z.object({ plan: z.any() })
);

export const dbTxBeginRequestSchema = z.object({ dbConnectionId: z.string().min(1), signal: z.any().optional() });
export const dbTxBeginResultSchema = resultSchema(
  z.object({ txId: z.string(), dbConnectionId: z.string() })
);

export const dbTxExecuteRequestSchema = z.object({
  txId: z.string().min(1),
  sql: z.string().min(1),
  params: z.array(z.any()).optional(),
  signal: z.any().optional()
});
export const dbTxExecuteResultSchema = resultSchema(
  z.object({
    affectedRows: z.number(),
    rowCount: z.number(),
    truncated: z.boolean(),
    rows: z.array(z.any()),
    insertId: z.any().optional()
  })
);

export const dbTxCommitRequestSchema = z.object({ txId: z.string().min(1), signal: z.any().optional() });
export const dbTxCommitResultSchema = resultSchema(
  z.object({ txId: z.string(), finished: z.boolean(), committed: z.boolean() })
);

export const dbTxRollbackRequestSchema = z.object({ txId: z.string().min(1), signal: z.any().optional() });
export const dbTxRollbackResultSchema = resultSchema(
  z.object({ txId: z.string(), finished: z.boolean(), rolledBack: z.boolean() })
);

export const dbRunRequestSchema = z.object({
  dbConnectionId: z.string().min(1),
  command: z.string().optional(),
  args: z.array(z.any()).optional(),
  collection: z.string().optional(),
  operation: z.string().optional(),
  filter: z.any().optional(),
  document: z.any().optional(),
  update: z.any().optional(),
  options: z.any().optional(),
  signal: z.any().optional()
});
export const dbRunResultSchema = resultSchema(z.object({ result: z.any() }));

export const dbDisconnectRequestSchema = z.object({ dbConnectionId: z.string().min(1), signal: z.any().optional() });
export const dbDisconnectResultSchema = resultSchema(
  z.object({ dbConnectionId: z.string(), disconnected: z.boolean() })
);

// ── Database profiles (durable connections) ──────────────────────────────────

export const dbProfileInfoSchema = z.object({
  dbProfileId: z.string().uuid(),
  name: z.string(),
  type: dbTypeSchema,
  host: z.string(),
  port: z.number().int(),
  database: z.string().nullable(),
  username: z.string().nullable(),
  ssl: z.string(),
  sshProfileId: z.string().uuid().nullable(),
  credentialConfigured: z.boolean(),
  connected: z.boolean()
});

export const dbProfileSaveRequestSchema = z.object({
  dbProfileId: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  type: dbTypeSchema,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  ssl: dbSslSchema,
  sshProfileId: z.string().uuid().nullable().optional()
});

export const dbProfileSaveResultSchema = resultSchema(
  z.object({
    profile: dbProfileInfoSchema,
    credentialRefs: z.object({ password: z.string() })
  })
);

export const dbProfileListRequestSchema = z.object({});
export const dbProfileListResultSchema = resultSchema(
  z.object({ profiles: z.array(dbProfileInfoSchema) })
);

export const dbProfileDeleteRequestSchema = z.object({ dbProfileId: z.string().uuid() });
export const dbProfileDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean() }));

export const dbProfileConnectRequestSchema = z.object({ dbProfileId: z.string().uuid() });
export const dbProfileConnectResultSchema = dbConnectResultSchema;

// ── batch exec (profile-selected, operator-confirmed) ────────────────────────

export const batchPlanRequestSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(120000).optional()
});

export const batchTaskSchema = z.object({
  batchId: z.string(),
  command: z.string(),
  timeoutMs: z.number(),
  dangerous: z.boolean(),
  reason: z.string().nullable(),
  createdAt: z.string()
});

export const batchPlanResultSchema = resultSchema(z.object({ task: batchTaskSchema }));

export const batchTaskListRequestSchema = z.object({});
export const batchTaskListResultSchema = resultSchema(z.object({ tasks: z.array(batchTaskSchema) }));

export const batchRunRequestSchema = z.object({
  batchId: z.string(),
  profileIds: z.array(z.string()).min(1)
});

export const batchRunResultSchema = resultSchema(
  z.object({
    results: z.array(
      z.object({
        profileId: z.string(),
        name: z.string(),
        host: z.string(),
        ok: z.boolean(),
        exitCode: z.union([z.number(), z.null()]),
        stdout: z.string(),
        stderr: z.string(),
        error: z.string().nullable()
      })
    )
  })
);

export const batchCancelRequestSchema = z.object({ batchId: z.string() });
export const batchCancelResultSchema = resultSchema(z.object({ cancelled: z.boolean() }));
