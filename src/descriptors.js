/**
 * Invocation descriptors for the `sshOps` Remote — one source of truth
 * consumed by both the host TYPERT manifest (typert.js) and the client
 * contribution (remote.js), mirroring the shape the repo's typert generator
 * emits.
 */
import * as S from "./schemas.js";

const PACKAGE = "dsh-ssh-ops";
const NS = "sshOps";

function def(method, requestSchema, requestType, resultSchema, resultType, options = {}) {
  return {
    id: `${PACKAGE}#${NS}/${method}`,
    service: NS,
    namespace: NS,
    method,
    // Stream methods ride the Gateway-owned WebSocket mux and deliver every
    // yielded item through the same strict result codec as unary results.
    ...(options.stream ? { mode: "stream", cancellation: { parameter: "signal" } } : {}),
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "request",
        wire: "request",
        source: "json",
        codec: { mode: "strict", typeSymbol: `${PACKAGE}/types#${requestType}`, schema: requestSchema }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: `${PACKAGE}/types#${resultType}`,
      schema: resultSchema
    },
    sourceLocation: { file: "src/index.js", line: 1, column: 1 }
  };
}

export const DESCRIPTORS = [
  def("listObservableSessions", S.listObservableSessionsRequestSchema, "SshListObservableSessionsRequest", S.listObservableSessionsResultSchema, "SshListObservableSessionsResult"),
  def("readObservableSession", S.readObservableSessionRequestSchema, "SshReadObservableSessionRequest", S.readObservableSessionResultSchema, "SshReadObservableSessionResult"),
  def("list", S.listRequestSchema, "SshListRequest", S.listResultSchema, "SshListResult"),
  def("connect", S.connectRequestSchema, "SshConnectRequest", S.connectResultSchema, "SshConnectResult"),
  def("profileList", S.profileListRequestSchema, "SshProfileListRequest", S.profileListResultSchema, "SshProfileListResult"),
  def("profileSave", S.profileSaveRequestSchema, "SshProfileSaveRequest", S.profileSaveResultSchema, "SshProfileSaveResult"),
  def("profileDelete", S.profileDeleteRequestSchema, "SshProfileDeleteRequest", S.profileDeleteResultSchema, "SshProfileDeleteResult"),
  def("profileDisconnect", S.profileDisconnectRequestSchema, "SshProfileDisconnectRequest", S.profileDisconnectResultSchema, "SshProfileDisconnectResult"),
  def("profileConnect", S.profileConnectRequestSchema, "SshProfileConnectRequest", S.profileConnectResultSchema, "SshProfileConnectResult"),
  def("cancelProfileConnect", S.cancelProfileConnectRequestSchema, "SshCancelProfileConnectRequest", S.cancelProfileConnectResultSchema, "SshCancelProfileConnectResult"),
  def("groupList", S.groupListRequestSchema, "SshGroupListRequest", S.groupListResultSchema, "SshGroupListResult"),
  def("groupSave", S.groupSaveRequestSchema, "SshGroupSaveRequest", S.groupSaveResultSchema, "SshGroupSaveResult"),
  def("groupDelete", S.groupDeleteRequestSchema, "SshGroupDeleteRequest", S.groupDeleteResultSchema, "SshGroupDeleteResult"),
  def("openSession", S.openSessionRequestSchema, "SshOpenSessionRequest", S.openSessionResultSchema, "SshOpenSessionResult"),
  def("changeDirectory", S.changeDirectoryRequestSchema, "SshChangeDirectoryRequest", S.writeResultSchema, "SshWriteResult"),
  def("write", S.writeRequestSchema, "SshWriteRequest", S.writeResultSchema, "SshWriteResult"),
  def("pendingConfirmationList", S.pendingConfirmationListRequestSchema, "PendingConfirmationListRequest", S.pendingConfirmationListResultSchema, "PendingConfirmationListResult"),
  def("pendingConfirmationApprove", S.pendingConfirmationActionRequestSchema, "PendingConfirmationActionRequest", S.pendingConfirmationApproveResultSchema, "PendingConfirmationApproveResult"),
  def("pendingConfirmationCancel", S.pendingConfirmationActionRequestSchema, "PendingConfirmationActionRequest", S.pendingConfirmationCancelResultSchema, "PendingConfirmationCancelResult"),
  def("read", S.readRequestSchema, "SshReadRequest", S.readResultSchema, "SshReadResult"),
  def("terminalStream", S.terminalStreamRequestSchema, "SshTerminalStreamRequest", S.readResultSchema, "SshReadResult", { stream: true }),
  def("resize", S.resizeRequestSchema, "SshResizeRequest", S.resizeResultSchema, "SshResizeResult"),
  def("closeSession", S.closeSessionRequestSchema, "SshCloseSessionRequest", S.closeSessionResultSchema, "SshCloseSessionResult"),
  def("disconnect", S.disconnectRequestSchema, "SshDisconnectRequest", S.disconnectResultSchema, "SshDisconnectResult"),
  def("sftpList", S.sftpListRequestSchema, "SftpListRequest", S.sftpListResultSchema, "SftpListResult"),
  def("sftpStat", S.sftpStatRequestSchema, "SftpStatRequest", S.sftpStatResultSchema, "SftpStatResult"),
  def("sftpReadFile", S.sftpReadRequestSchema, "SftpReadRequest", S.sftpReadResultSchema, "SftpReadResult"),
  def("sftpWriteFile", S.sftpWriteRequestSchema, "SftpWriteRequest", S.sftpWriteResultSchema, "SftpWriteResult"),
  def("scpReadFile", S.scpReadRequestSchema, "ScpReadRequest", S.scpReadResultSchema, "ScpReadResult"),
  def("scpWriteFile", S.scpWriteRequestSchema, "ScpWriteRequest", S.scpWriteResultSchema, "ScpWriteResult"),
  def("sftpMkdir", S.sftpMkdirRequestSchema, "SftpMkdirRequest", S.sftpMkdirResultSchema, "SftpMkdirResult"),
  def("sftpDelete", S.sftpDeleteRequestSchema, "SftpDeleteRequest", S.sftpDeleteResultSchema, "SftpDeleteResult"),
  def("sftpRename", S.sftpRenameRequestSchema, "SftpRenameRequest", S.sftpRenameResultSchema, "SftpRenameResult"),
  def("tunnelStartLocal", S.tunnelStartLocalRequestSchema, "TunnelStartLocalRequest", S.tunnelStartLocalResultSchema, "TunnelStartLocalResult"),
  def("tunnelStartRemote", S.tunnelStartRemoteRequestSchema, "TunnelStartRemoteRequest", S.tunnelStartRemoteResultSchema, "TunnelStartRemoteResult"),
  def("tunnelStop", S.tunnelStopRequestSchema, "TunnelStopRequest", S.tunnelStopResultSchema, "TunnelStopResult"),
  def("tunnelList", S.tunnelListRequestSchema, "TunnelListRequest", S.tunnelListResultSchema, "TunnelListResult"),
  def("sshConfigImport", S.sshConfigImportRequestSchema, "SshConfigImportRequest", S.sshConfigImportResultSchema, "SshConfigImportResult"),
  def("dbConnect", S.dbConnectRequestSchema, "DbConnectRequest", S.dbConnectResultSchema, "DbConnectResult"),
  def("dbListConnections", S.dbListConnectionsRequestSchema, "DbListConnectionsRequest", S.dbListConnectionsResultSchema, "DbListConnectionsResult"),
  def("dbQuery", S.dbQueryRequestSchema, "DbQueryRequest", S.dbQueryResultSchema, "DbQueryResult"),
  def("dbExecute", S.dbExecuteRequestSchema, "DbExecuteRequest", S.dbExecuteResultSchema, "DbExecuteResult"),
  def("dbListTables", S.dbListTablesRequestSchema, "DbListTablesRequest", S.dbListTablesResultSchema, "DbListTablesResult"),
  def("dbDescribeTable", S.dbDescribeTableRequestSchema, "DbDescribeTableRequest", S.dbDescribeTableResultSchema, "DbDescribeTableResult"),
  def("dbPreview", S.dbPreviewRequestSchema, "DbPreviewRequest", S.dbPreviewResultSchema, "DbPreviewResult"),
  def("dbExplain", S.dbExplainRequestSchema, "DbExplainRequest", S.dbExplainResultSchema, "DbExplainResult"),
  def("dbTxBegin", S.dbTxBeginRequestSchema, "DbTxBeginRequest", S.dbTxBeginResultSchema, "DbTxBeginResult"),
  def("dbTxExecute", S.dbTxExecuteRequestSchema, "DbTxExecuteRequest", S.dbTxExecuteResultSchema, "DbTxExecuteResult"),
  def("dbTxCommit", S.dbTxCommitRequestSchema, "DbTxCommitRequest", S.dbTxCommitResultSchema, "DbTxCommitResult"),
  def("dbTxRollback", S.dbTxRollbackRequestSchema, "DbTxRollbackRequest", S.dbTxRollbackResultSchema, "DbTxRollbackResult"),
  def("dbRun", S.dbRunRequestSchema, "DbRunRequest", S.dbRunResultSchema, "DbRunResult"),
  def("dbDisconnect", S.dbDisconnectRequestSchema, "DbDisconnectRequest", S.dbDisconnectResultSchema, "DbDisconnectResult"),
  def("dbProfileList", S.dbProfileListRequestSchema, "DbProfileListRequest", S.dbProfileListResultSchema, "DbProfileListResult"),
  def("dbProfileSave", S.dbProfileSaveRequestSchema, "DbProfileSaveRequest", S.dbProfileSaveResultSchema, "DbProfileSaveResult"),
  def("dbProfileDelete", S.dbProfileDeleteRequestSchema, "DbProfileDeleteRequest", S.dbProfileDeleteResultSchema, "DbProfileDeleteResult"),
  def("dbProfileConnect", S.dbProfileConnectRequestSchema, "DbProfileConnectRequest", S.dbProfileConnectResultSchema, "DbProfileConnectResult"),
  def("listKnownHosts", S.listKnownHostsRequestSchema, "ListKnownHostsRequest", S.listKnownHostsResultSchema, "ListKnownHostsResult"),
  def("forgetHostKey", S.forgetHostKeyRequestSchema, "ForgetHostKeyRequest", S.forgetHostKeyResultSchema, "ForgetHostKeyResult"),
  def("batchPlan", S.batchPlanRequestSchema, "BatchPlanRequest", S.batchPlanResultSchema, "BatchPlanResult"),
  def("batchTaskList", S.batchTaskListRequestSchema, "BatchTaskListRequest", S.batchTaskListResultSchema, "BatchTaskListResult"),
  def("batchRun", S.batchRunRequestSchema, "BatchRunRequest", S.batchRunResultSchema, "BatchRunResult"),
  def("batchCancel", S.batchCancelRequestSchema, "BatchCancelRequest", S.batchCancelResultSchema, "BatchCancelResult"),
];
