/**
 * SSH agent forwarding wiring for dsh-ssh-ops.
 *
 * Opt-in per resource (`agentForward: true`): the connection hands the
 * LOCAL ssh-agent to the remote host, so a terminal opened on it (a jump
 * host, say) can authenticate onward to deeper hosts with the local keys —
 * the ForwardAgent workflow. ssh2 does the channel plumbing itself: with
 * `agentForward: true` and a valid `agent`, every session channel it opens
 * (shell/exec) requests auth-agent forwarding and pipes
 * `auth-agent@openssh.com` channels to the local agent.
 *
 * A side effect worth having: with `agent` set, ssh2 also accepts `"agent"`
 * as an authHandler method, so a resource without a stored private key can
 * authenticate with the keys already loaded in the local agent.
 *
 * Pure and side-effect-free (env is injectable) so the decision matrix is
 * unit-testable without a socket.
 */
import { t } from "./i18n/core.js";

/**
 * Apply the agent-forwarding request to an ssh2 connect config in place.
 * Mutates `connectConfig` only on success; a missing local agent is a hard
 * failure with an actionable message rather than a silent connection without
 * forwarding — the toggle's whole point is the forwarded agent.
 */
export function applyAgentForwarding(connectConfig, enabled, env = process.env) {
  if (enabled !== true) return { ok: true };
  const agentSocket = env.SSH_AUTH_SOCK;
  if (typeof agentSocket !== "string" || agentSocket === "") {
    return {
      ok: false,
      error: {
        code: "agent-unavailable",
        message: t("已开启 SSH Agent 转发，但本机没有运行 ssh-agent（SSH_AUTH_SOCK 未设置）；启动系统的 ssh-agent 并加载密钥后重试")
      }
    };
  }
  connectConfig.agent = agentSocket;
  connectConfig.agentForward = true;
  return { ok: true };
}
