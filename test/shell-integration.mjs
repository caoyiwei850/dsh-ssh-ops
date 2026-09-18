// OSC 133 shell integration: marker tracking across chunk boundaries, both
// terminators, the cwd report, exit codes, and the hostile-input cases that
// must not hang or corrupt the tracker.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SHELL_FAMILY_PROBE, SHELL_INTEGRATION_BASH_COMMAND, SHELL_INTEGRATION_ZSH_COMMAND, ShellIntegrationTracker, parseShellFamilyProbe, shellIntegrationCommand } from "../src/shell-integration.js";
import { terminalContextReadResultSchema } from "../src/schemas.js";

const OSC = (payload) => `\x1b]${payload}\x07`;
const OSC_ST = (payload) => `\x1b]${payload}\x1b\\`;

// ── a full command cycle ────────────────────────────────────────────────────
{
  const tracker = new ShellIntegrationTracker();
  assert.deepEqual(tracker.snapshot(), { atPrompt: false, lastExitCode: null, cwd: null, lastCommandAt: null, commands: 0 });

  tracker.feed(OSC("133;A"));
  assert.equal(tracker.snapshot().atPrompt, true, "A opens the prompt");
  tracker.feed("root@srv:~# ");
  tracker.feed(OSC("133;B"));
  assert.equal(tracker.snapshot().atPrompt, false, "B closes the prompt / opens the command");
  tracker.feed("ls /nonexistent\n");
  tracker.feed(OSC("133;C"));
  tracker.feed("ls: cannot access '/nonexistent'\n");
  tracker.feed(OSC("133;D;2"));
  const done = tracker.snapshot();
  assert.equal(done.lastExitCode, 2, "D carries the exit status");
  assert.equal(done.commands, 1);
  assert.ok(typeof done.lastCommandAt === "string" && done.lastCommandAt.includes("T"));

  tracker.feed(OSC("633;P;Cwd=/srv/apps"));
  assert.equal(tracker.snapshot().cwd, "/srv/apps", "633 reports the working directory");
}

// ── sequences split across chunks, and the ST terminator ────────────────────
{
  const tracker = new ShellIntegrationTracker();
  tracker.feed("\x1b");
  tracker.feed("]133;");
  tracker.feed("D;0\x07");
  tracker.feed(OSC("633;P;Cwd=/var/log"));
  const state = tracker.snapshot();
  assert.equal(state.commands, 1, "a sequence split across four chunks still lands");
  assert.equal(state.lastExitCode, 0);
  assert.equal(state.cwd, "/var/log");

  const st = new ShellIntegrationTracker();
  st.feed(OSC_ST("133;D;130"));
  assert.equal(st.snapshot().lastExitCode, 130, "the ST terminator is accepted too");
}

// ── unrelated OSC payloads and plain text are ignored ──────────────────────
{
  const tracker = new ShellIntegrationTracker();
  tracker.feed(OSC("0;window title"));
  tracker.feed(OSC("633;Q;abc"));
  tracker.feed("plain output with ESC \x1b[31mcolors\x1b[0m and text");
  tracker.feed(OSC("133;D;7"));
  const state = tracker.snapshot();
  assert.equal(state.commands, 1);
  assert.equal(state.lastExitCode, 7);
  assert.equal(state.cwd, null, "an unrelated 633 payload does not set a cwd");
}

// ── hostile input: an unterminated OSC must not hang or swallow later data ─
{
  const tracker = new ShellIntegrationTracker();
  const started = Date.now();
  tracker.feed(`\x1b]${"x".repeat(600)}`);
  tracker.feed("after the junk");
  tracker.feed(OSC("133;D;1"));
  assert.ok(Date.now() - started < 1000, "a long unterminated sequence is dropped, not buffered forever");
  assert.equal(tracker.snapshot().lastExitCode, 1, "later markers still track after junk");
}

// ── the injection commands are single safe lines, one per shell family ──────
{
  for (const [name, snippet] of [["bash", SHELL_INTEGRATION_BASH_COMMAND], ["zsh", SHELL_INTEGRATION_ZSH_COMMAND]]) {
    assert.equal(snippet.includes("\n"), false, `${name}: the snippet must submit with one Enter`);
    assert.match(snippet, /133;D;%s/, `${name}: reports the exit code`);
    assert.match(snippet, /633;P;Cwd=%s/, `${name}: reports the cwd`);
    assert.match(snippet, /133;A/, `${name}: marks the prompt`);
  }
  assert.match(SHELL_INTEGRATION_BASH_COMMAND, /PROMPT_COMMAND/, "bash installs via PROMPT_COMMAND");
  assert.match(SHELL_INTEGRATION_ZSH_COMMAND, /precmd_functions/, "zsh installs via precmd_functions");
  // A single line is parsed whole, so bash/sh must never see zsh-only syntax.
  assert.doesNotMatch(SHELL_INTEGRATION_BASH_COMMAND, /precmd_functions|\+\(/, "the POSIX variant carries no array assignment");
  assert.equal(shellIntegrationCommand("").includes("PROMPT_COMMAND"), true, "an empty zsh probe means bash/sh");
  assert.equal(shellIntegrationCommand("   ").includes("PROMPT_COMMAND"), true, "whitespace is still not zsh");
  assert.equal(shellIntegrationCommand("5.9").includes("precmd_functions"), true, "a version string means zsh");
  assert.equal(shellIntegrationCommand(undefined).includes("PROMPT_COMMAND"), true);
}

// ── the family probe answers through a delimiter, nothing else ──────────────
{
  assert.match(SHELL_FAMILY_PROBE, /DSHSHELL:%s:END/, "the probe delimits its answer");
  assert.equal(parseShellFamilyProbe("DSHSHELL::END"), "", "bash answers empty");
  assert.equal(parseShellFamilyProbe("DSHSHELL:5.9:END"), "5.9", "zsh answers its version");
  assert.equal(parseShellFamilyProbe("DSHSHELL:5.9:END\n"), "5.9", "trailing newline is ignored");
  assert.equal(parseShellFamilyProbe("DSHSHELL:  5.9  :END"), "5.9");

  // The live failure this guards: every exec is wrapped with a cwd marker, and
  // an already-integrated shell emits markers of its own — the answer must be
  // read out of the delimiter, not "is stdout non-empty".
  const polluted = "\u001b]633;P;Cwd=/root\u0007Q0FST0FDSVQK\n\u001b]133;D;0\u0007\u001b]133;A\u0007DSHSHELL::END\n";
  assert.equal(parseShellFamilyProbe(polluted), "", "marker-laden stdout still reports bash");
  const zshPolluted = "${DSHSHELL:not-a-version}DSHSHELL:5.9:END";
  assert.equal(parseShellFamilyProbe(zshPolluted), "5.9", "only the delimited answer counts");
  assert.equal(parseShellFamilyProbe("no delimiter at all"), "", "a missing answer reads as bash (the safe default)");
  assert.equal(shellIntegrationCommand(parseShellFamilyProbe(polluted)).includes("PROMPT_COMMAND"), true);
  assert.equal(shellIntegrationCommand(parseShellFamilyProbe("DSHSHELL:5.9:END")).includes("precmd_functions"), true);
}

// ── the wire schema must carry the shell state (a field the schema drops never
//    reaches the client, however correct the host method is) ─────────────────
{
  const state = { atPrompt: true, lastExitCode: 0, cwd: "/root", lastCommandAt: "2026-09-19T00:00:00.000Z", commands: 3 };
  const parsed = terminalContextReadResultSchema.parse({
    ok: true,
    value: {
      sessionId: "s", data: "", historyStart: 0, historyEnd: 0, offset: 0, nextOffset: 0,
      wasClamped: false, hasMore: false, alive: true, exit: null, redacted: false, shell: state
    }
  });
  assert.deepEqual(parsed.value.shell, state, "the schema keeps the OSC 133 state");
  const legacy = terminalContextReadResultSchema.parse({
    ok: true,
    value: {
      sessionId: "s", data: "", historyStart: 0, historyEnd: 0, offset: 0, nextOffset: 0,
      wasClamped: false, hasMore: false, alive: true, exit: null, redacted: false, shell: null
    }
  });
  assert.equal(legacy.value.shell, null, "and accepts null before integration is enabled");
}

// ── wiring contract ─────────────────────────────────────────────────────────
{
  const index = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const tools = await readFile(new URL("../src/tools/ssh-session.js", import.meta.url), "utf8");
  const checks = [
    [index, /shellIntegration: new ShellIntegrationTracker\(\)/, "each session owns a tracker"],
    [index, /session\.shellIntegration\?\.feed\(text\)/, "every output chunk feeds the tracker"],
    [index, /shell: session\.shellIntegration\?\.snapshot\(\) \?\? null/, "terminal context reports the shell state"],
    [index, /async enableShellIntegration\(request\)/, "the enabling RPC exists"],
    [index, /encodeData\(`\$\{shellIntegrationCommand\(family\)\}/, "enabling writes the family-appropriate one-liner"],
    [index, /buildCwdAwareCommand\(SHELL_FAMILY_PROBE\)/, "the family probe is the delimited one"],
    [index, /parseShellFamilyProbe\(result\.stdout\)/, "the answer is parsed out of the delimiter"],
    [index, /terminal-not-ready[\s\S]{0,120}enableShellIntegration|enableShellIntegration[\s\S]{0,900}terminal-not-ready/, "enabling refuses a busy terminal"],
    [tools, /name: "ssh_shell_integration"/, "the agent can enable it per session"]
  ];
  for (const [source, pattern, label] of checks) {
    assert.match(source, pattern, `wiring contract: ${label}`);
  }
}

console.log("shell integration: marker tracking, split chunks, junk input and the injection snippet all passed");
