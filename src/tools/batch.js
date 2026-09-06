/**
 * Agent tool for operator-confirmed multi-server execution. The tool only
 * creates the batch task; the operator picks targets and executes in the
 * panel. ssh_cluster (run on every open connection) was removed on purpose:
 * it executed with no operator confirmation, so a casually phrased request
 * could hit every connected server at once (observed: one named server
 * requested, every open connection upgraded).
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

export function registerBatchTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "ssh_batch",
    description: "Run one command on MULTIPLE servers chosen from the SAVED server resources (not the currently connected one). The operator picks the target servers in the right-side SSH panel and confirms — this tool only creates the batch task and returns immediately; it does NOT execute. Dangerous commands are blocked from agent execution and shown for operator confirmation. Use when the user asks to run the same command on several/multiple servers.",
    parameters: {
      command: { type: "string", required: true, description: "The shell command to run on each selected server." },
      timeout_ms: { type: "integer", description: "Per-server timeout in milliseconds, defaults to 30000." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: {
        batchId: { type: "string", required: true },
        command: { type: "string", required: true },
        dangerous: { type: "boolean", required: true },
        reason: { oneOf: [{ type: "string" }, { type: "null" }], required: true }
      } },
      render(_args, value) {
        return [{ type: "text", text: value.dangerous
          ? `已创建批量任务（危险命令，等待操作者在面板确认）：${value.command}`
          : `已创建批量任务，请在右侧 SSH 面板勾选服务器后执行：${value.command}（任务 ${value.batchId}）` }];
      }
    },
    async execute(args) {
      const result = await service.batchPlan({ command: args.command, timeoutMs: args.timeout_ms });
      if (!result.ok) throw new Error(`ssh_batch failed: ${result.error.message}`);
      return { batchId: result.value.task.batchId, command: result.value.task.command, dangerous: result.value.task.dangerous, reason: result.value.task.reason };
    }
  }));
}
