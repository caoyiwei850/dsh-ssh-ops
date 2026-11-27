/**
 * Agent tools for SSH port forwarding.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

export function registerTunnelTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "tunnel_start",
    description: "Start SSH forwarding and return a tunnel_id. Local (default): bind_addr:bind_port on DSH to remote_host:remote_port from the server. Remote: server listens on remote_host:remote_port and forwards to target_host:target_port on DSH. Dynamic: local SOCKS5 on bind_addr:bind_port, with destinations reached from the server.",
    parameters: {
      connection_id: { type: "string", description: "SSH ID from ssh_connect. Default: active connection." },
      kind: { type: "string", enum: ["local", "remote", "dynamic"], description: "Forward direction: 'local' (default), 'remote', or 'dynamic' (SOCKS5 proxy)." },
      bind_addr: { type: "string", description: "Local bind address (local kind), defaults to 127.0.0.1." },
      bind_port: { type: "integer", description: "Local bind port (local kind); 0 picks a free port." },
      remote_host: { type: "string", description: "The remote host to reach (local kind) or to listen on (remote kind); not used by dynamic." },
      remote_port: { type: "integer", description: "The remote port to reach (local kind) or to listen on (remote kind); not used by dynamic." },
      target_host: { type: "string", description: "Local target host for remote kind, defaults to 127.0.0.1." },
      target_port: { type: "integer", description: "Local target port for remote kind (required when kind='remote')." }
    },
    output: {
      // The three kinds return different shapes: local/remote always carry the
      // remote endpoint they forward to, while dynamic carries none — a SOCKS5
      // proxy has no fixed destination, the client picks one per CONNECT.
      schema: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              tunnelId: { type: "string", required: true },
              kind: { type: "string", const: "dynamic", required: true },
              bindAddr: { type: "string", required: true },
              bindPort: { type: "number", required: true }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              tunnelId: { type: "string", required: true },
              kind: { type: "string", const: "local", required: true },
              bindAddr: { type: "string", required: true },
              bindPort: { type: "number", required: true },
              remoteHost: { type: "string", required: true },
              remotePort: { type: "number", required: true }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              tunnelId: { type: "string", required: true },
              kind: { type: "string", const: "remote", required: true },
              bindAddr: { type: "string", required: true },
              bindPort: { type: "number", required: true },
              remoteHost: { type: "string", required: true },
              remotePort: { type: "number", required: true },
              targetHost: { type: "string", required: true },
              targetPort: { type: "number", required: true }
            }
          }
        ]
      },
      render(args, value) {
        const text = value.kind === "dynamic"
          ? `SOCKS5 proxy started on ${value.bindAddr}:${value.bindPort} (id: ${value.tunnelId})`
          : value.kind === "local"
            ? `Tunnel started: ${value.bindAddr}:${value.bindPort} -> ${value.remoteHost}:${value.remotePort} (id: ${value.tunnelId})`
            : `Remote forward started: ${value.remoteHost}:${value.remotePort} -> ${value.bindAddr}:${value.bindPort} (id: ${value.tunnelId})`;
        return [{ type: "text", text }];
      }
    },
    async execute(args) {
      let result;
      if (args.kind === "dynamic") {
        result = await service.tunnelStartDynamic({ connectionId: args.connection_id, bindAddr: args.bind_addr, bindPort: args.bind_port });
      } else if (args.kind === "remote") {
        result = await service.tunnelStartRemote({ connectionId: args.connection_id, bindAddr: args.bind_addr, bindPort: args.bind_port, remoteHost: args.remote_host, remotePort: args.remote_port, targetHost: args.target_host ?? "127.0.0.1", targetPort: args.target_port });
      } else {
        if (args.remote_host === undefined || args.remote_port === undefined) {
          throw new Error("tunnel_start failed: remote_host and remote_port are required for the local kind");
        }
        result = await service.tunnelStartLocal({ connectionId: args.connection_id, bindAddr: args.bind_addr, bindPort: args.bind_port, remoteHost: args.remote_host, remotePort: args.remote_port });
      }
      if (!result.ok) throw new Error(`tunnel_start failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "tunnel_list",
    description: "List active forwards on the active or specified SSH connection.",
    parameters: {
      connection_id: { type: "string", description: "SSH ID from ssh_connect. Default: active connection." }
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
            // Dynamic records report their live client count.
            connections: { type: "number" },
            active: { type: "boolean", required: true }
          } } }
        }
      },
      render(args, value) {
        if (!value.tunnels.length) return [{ type: "text", text: "(no active tunnels)" }];
        return [{ type: "text", text: value.tunnels.map((t) => {
          // A dynamic tunnel has no remote endpoint to point at, so print the
          // listener and its live connection count.
          if (t.kind === "dynamic") {
            const active = typeof t.connections === "number" && t.connections > 0
              ? `, ${t.connections} active connection${t.connections === 1 ? "" : "s"}`
              : "";
            return `dynamic(SOCKS5): ${t.bindAddr}:${t.bindPort}${active} (${t.tunnelId})`;
          }
          return `${t.kind}: ${t.bindAddr}:${t.bindPort} -> ${t.remoteHost}:${t.remotePort} (${t.tunnelId})`;
        }).join("\n") }];
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
    description: "Stop a forward by tunnel_id from tunnel_list or tunnel_start.",
    parameters: {
      connection_id: { type: "string", description: "SSH ID from ssh_connect. Default: active connection." },
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
