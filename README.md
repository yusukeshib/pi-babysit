# pi-babysit

A [pi](https://github.com/earendil-works/pi) extension that runs **any shell
command** under [babysit](https://github.com/yusukeshib/babysit)-supervised
sessions — one context-safe substrate for quick commands, background processes,
and pi subagents.
It retires both `@mjakl/pi-processes` (the `process` tool) and the old
`pi-subagent` extension.

## Install

```sh
pi install npm:@yusukeshib/pi-babysit
```

Then install [`babysit`](https://github.com/yusukeshib/babysit) **0.13.0 or
newer** (the extension does **not** auto-install it):

```sh
cargo install --git https://github.com/yusukeshib/babysit
```

or grab a prebuilt binary from the
[releases](https://github.com/yusukeshib/babysit/releases) and put it on your
`PATH`. If it is missing or older than 0.13.0, every tool and the `/babysit`
command fail with upgrade instructions.

## The model

Every session is a babysit worker owning a PTY, recording all output to a log,
reachable from anywhere (`~/.pi-babysit/<pi-session-id>/`). Two kinds:

| kind | started by | completion | on completion |
| ---- | ---------- | ---------- | ------------- |
| **process** | `babysit_run { command }` | process **exit** | automatic notification message (`triggerTurn`) — the agent may end its turn after starting and is resumed on exit, same contract as the old `process` tool |
| **subagent** | `babysit_run { profile: "subagent", task }` | `agent_end` in the RPC event stream (process stays alive) | none — the agent polls `babysit_check` or blocks on `babysit_wait`; the idle session accepts follow-up tasks |

The **profile is a tool parameter, not a separate tool set**: domain knowledge
(RPC bookkeeping, per-task byte offsets, parked-turn detection, PTY-safe
message delivery, spawn validation) lives in code, while the LLM sees one small
generic surface.

Because sessions are real PTYs, the agent can also **drive interactive
programs** (installers, wizards, REPLs): type with `babysit_send`
(text or named keys) and read the rendered screen with
`babysit_check { screen: true }` — a capability neither retired extension had.

## Tools (LLM-callable)

| Tool | What it does |
| ---- | ------------ |
| `babysit_run` | Run any command (`command`, optional `name`/`pty`/`timeout`/`idleTimeout`/`retryOnWorkerDeath`) or start a subagent (`profile: "subagent"`, `task`, optional `agent`/`model`/`tools`). Quick commands return inline; longer ones continue in the background |
| `babysit_check` | List all sessions, inspect one, tail its bounded recent output, or search its raw log with `pattern`; `screen: true` captures TUIs and subagents otherwise show structured live progress |
| `babysit_send` | Process: type `text` / press `keys` into the PTY. Subagent: steer mid-run, or send a follow-up task when idle (`mode: auto/steer/task`) |
| `babysit_wait` | Block until done: process exit (or `expect: "regex"` readiness marker), subagent task completion. Multi-wait: `ids` + `mode: "any"\|"all"` |
| `babysit_kill` | Terminate a session, verify terminal state, then suppress the exit notification |

A `tool_call` hook blocks shell backgrounding (`… &`, `nohup`, `setsid`,
`disown`) and redirects all direct `bash` commands to `babysit_run`.

## Commands (human)

| Command | What it does |
| ------- | ------------ |
| `/babysit` | Arrow-key picker over all sessions. Renders an **inline snapshot** (no tmux): running **process** → current rendered screen + recent output + a copy-paste `babysit attach` take-over hint (detach `Ctrl-\ Ctrl-\`); running **subagent** → read-only progress (RPC stdin stays untouchable); finished → summary. Re-run `/babysit` to refresh |

A minimal widget above the editor shows live counts
(`N processes · M subagents working · K idle`).

## Logs without context flooding

`babysit_run`, `babysit_wait`, and automatic completion notifications always
return lifecycle metadata and the absolute path to the complete `output.log`.
Explicit run/wait results inline complete output up to 8 KB; unsolicited
completion notifications use a stricter 2 KB cap. Larger output stays out of
model context. Inspect it through the session id without creating another shell
session:

```text
babysit_check { id: "cargo-test", lines: 50 }
babysit_check { id: "cargo-test", pattern: "FAIL|ERROR", lines: 50 }
```

Tail and search results are capped at 200 lines and clipped to 8 KB. Pattern
search returns the latest matching lines with line numbers. Do not read a
potentially large log file in full.

All shell commands, including `pwd` and Git, are redirected to `babysit_run`.
Set `PI_BABYSIT_ALLOW_BASH=1` only as an explicit emergency escape hatch.

## Unexpected worker loss

If the babysit supervisor disappears without recording an exit, pi-babysit
normalizes the stale `running` state to `worker-dead` and returns immediately
instead of hanging. Possible causes include host process cleanup, endpoint
security, or a supervisor crash. For commands known to be safe and idempotent,
set `retryOnWorkerDeath: true` to retry once with a new session id. It is opt-in
because blindly rerunning an arbitrary command can duplicate side effects.

## How completion detection works

- **Process**: a 2.5s poller watches for running→exited transitions and injects
  one `pi.sendMessage(…, { triggerTurn: true, deliverAs: "steer" })` per ended
  session (deduped via `meta/<id>.json`). `babysit_kill` and an exit already
  reported by `babysit_wait` suppress the notification.
- **Subagent**: `babysit_wait` blocks on `babysit expect '"type":"agent_end"'`.
  An `agent_end` whose last message is a **parked** toolResult — a
  `babysit_run { command }` result carrying the `[notify-on-exit]` marker (or
  the legacy `process` tool) — only means "turn parked awaiting a process-exit
  notification; pi resumes on its own", so the wait continues. Any other
  `agent_end` is real completion. Per-task byte offsets scope check/wait to the
  CURRENT task, which is what makes follow-up tasks work.

Subagents load `self-reap.ts`, which exits an idle finished subagent after a
grace window (`PI_BABYSIT_REAP_AFTER`, default 120s) using the same parked-turn
rule, so a subagent waiting on a long build is never false-killed.

## Environment overrides

| Var | Default | Purpose |
| --- | ------- | ------- |
| `PI_BABYSIT_DIR` | `~/.pi-babysit` | babysit state root (namespaced per pi session) |
| `PI_BABYSIT_BIN` | `pi` | agent binary for subagents |
| `PI_BABYSIT_CLI` | `babysit` | babysit binary |
| `PI_BABYSIT_VIEW_CMD` | bundled `format-stream.mjs` | live-attach pretty printer for subagent JSONL (`""` disables) |
| `PI_BABYSIT_REAP_AFTER` | `120s` | idle grace before a finished subagent self-exits (`off`/`none`/`0` disables) |
| `PI_BABYSIT_TAIL_MAX_BYTES` | `8000` | cap for explicit log tails/screens returned by `babysit_check` |
| `PI_BABYSIT_INLINE_OUTPUT_MAX_BYTES` | `8000` | cap for complete output in explicitly requested run/wait results |
| `PI_BABYSIT_NOTIFY_OUTPUT_MAX_BYTES` | `2000` | smaller cap for unsolicited process-completion notifications (`0` omits all output) |
| `PI_BABYSIT_NOTIFY_COMMAND_MAX_BYTES` | `240` | cap for the command preview in completion notifications |
| `PI_BABYSIT_ALLOW_BASH` | unset | set to `1` to bypass direct-Bash redirection (emergency escape hatch) |

Requires `babysit` 0.13.0 or newer and `pi` on `PATH`. The extension does **not**
auto-install `babysit`: if the binary is missing or too old, every tool and the
`/babysit` command fail with install instructions (`cargo install --git
https://github.com/yusukeshib/babysit` or a prebuilt release), and a warning is
shown at session start. Point `$PI_BABYSIT_CLI` at a custom binary path if
needed.

(No tmux dependency — `/babysit` renders inline; take over a live process
manually with the `babysit attach` command it shows.)
