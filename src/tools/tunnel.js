/**
 * Agent tools for SSH port forwarding.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

export function registerTunnelTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "tunnel_start",
    description: "Start a port forward through a connected server. kind='local' (default): the DSH host listens on bind_addr:bind_port and forwards to remote_host:remote_port on the server — use to reach services only the server can see. kind='remote': the server listens on remote_host:remote_port and forwards back to target_host:target_port on this machine. Returns a tunnel_id for tunnel_stop.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      kind: { type: "string", enum: ["local", "remote"], description: "Forward direction: 'local' (default) or 'remote'." },
      bind_addr: { type: "string", description: "Local bind address (local kind), defaults to 127.0.0.1." },
      bind_port: { type: "integer", description: "Local bind port (local kind); 0 picks a free port." },
      remote_host: { type: "string", required: true, description: "The remote host to reach (local kind) or to listen on (remote kind)." },
      remote_port: { type: "integer", required: true, description: "The remote port to reach (local kind) or to listen on (remote kind)." },
      target_host: { type: "string", description: "Local target host for remote kind, defaults to 127.0.0.1." },
      target_port: { type: "integer", description: "Local target port for remote kind (required when kind='remote')." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tunnelId: { type: "string", required: true },
          kind: { type: "string", required: true },
          bindAddr: { type: "string", required: true },
          bindPort: { type: "number", required: true },
          remoteHost: { type: "string", required: true },
          remotePort: { type: "number", required: true },
          targetHost: { type: "string" },
          targetPort: { type: "number" }
        }
      },
      render(args, value) {
        return [{ type: "text", text: value.kind === "local"
          ? `Tunnel started: ${value.bindAddr}:${value.bindPort} -> ${value.remoteHost}:${value.remotePort} (id: ${value.tunnelId})`
          : `Remote forward started: ${value.remoteHost}:${value.remotePort} -> ${value.bindAddr}:${value.bindPort} (id: ${value.tunnelId})` }];
      }
    },
    async execute(args) {
      const result = args.kind === "remote"
        ? await service.tunnelStartRemote({ connectionId: args.connection_id, bindAddr: args.bind_addr, bindPort: args.bind_port, remoteHost: args.remote_host, remotePort: args.remote_port, targetHost: args.target_host ?? "127.0.0.1", targetPort: args.target_port })
        : await service.tunnelStartLocal({ connectionId: args.connection_id, bindAddr: args.bind_addr, bindPort: args.bind_port, remoteHost: args.remote_host, remotePort: args.remote_port });
      if (!result.ok) throw new Error(`tunnel_start failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "tunnel_list",
    description: "List active port forwards on a connected server. Omit connection_id for the current server.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tunnels: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
            tunnelId: { type: "string", required: true },
            kind: { type: "string", required: true },
            bindAddr: { type: "string", required: true },
            bindPort: { type: "number", required: true },
            remoteHost: { type: "string" },
            remotePort: { type: "number" },
            targetHost: { type: "string" },
            targetPort: { type: "number" },
            active: { type: "boolean", required: true }
          } } }
        }
      },
      render(args, value) {
        if (!value.tunnels.length) return [{ type: "text", text: "(no active tunnels)" }];
        return [{ type: "text", text: value.tunnels.map((t) => `${t.kind}: ${t.bindAddr}:${t.bindPort} -> ${t.remoteHost}:${t.remotePort} (${t.tunnelId})`).join("\n") }];
      }
    },
    async execute(args) {
      const result = await service.tunnelList({ connectionId: args.connection_id });
      if (!result.ok) throw new Error(`tunnel_list failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "tunnel_stop",
    description: "Stop an active port forward by tunnel_id (see tunnel_list / tunnel_start).",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      tunnel_id: { type: "string", required: true, description: "The tunnel id returned by tunnel_start." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { tunnelId: { type: "string", required: true }, stopped: { type: "boolean", required: true } } },
      render(args, value) { return [{ type: "text", text: `Stopped tunnel ${value.tunnelId}` }]; }
    },
    async execute(args) {
      const result = await service.tunnelStop({ connectionId: args.connection_id, tunnelId: args.tunnel_id });
      if (!result.ok) throw new Error(`tunnel_stop failed: ${result.error.message}`);
      return result.value;
    }
  }));
}
