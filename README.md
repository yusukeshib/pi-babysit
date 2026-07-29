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
| **process** | `babysit_run { command }` | process **exit** | automatic notification message (`triggerTurn`), batched for all exits observed in the same poll — the agent may end its turn after starting and is resumed on exit, same contract as the old `process` tool |
| **subagent** | `babysit_run { profile: "subagent", task }` | `agent_settled` in the RPC event stream (worker remains reusable during its idle grace) | none — the agent polls `babysit_check` or blocks on `babysit_wait`; the idle session accepts follow-up tasks until self-reap |

The **profile is a tool parameter, not a separate tool set**: domain knowledge
(RPC bookkeeping, per-task byte offsets, parked-turn detection, PTY-safe
message delivery, spawn validation) lives in code, while the LLM sees one small
generic surface.

Subagent recursion is **disabled by default**: a top-level pi may create workers
(depth 1), but those workers cannot create more workers. A top-level caller can
explicitly opt in for a specific tree with `maxDepth: 2` (or higher) when it
creates the first worker. Descendants inherit that ceiling and cannot raise it.
Normal `babysit_run { command }` process execution remains available at every
depth.

Because sessions are real PTYs, the agent can also **drive interactive
programs** (installers, wizards, REPLs): type with `babysit_send`
(text or named keys) and read the rendered screen with
`babysit_check { screen: true }` — a capability neither retired extension had.

## Tools (LLM-callable)

| Tool | What it does |
| ---- | ------------ |
| `babysit_run` | Run any command (`command`, optional `name`/`pty`/`timeout`/`idleTimeout`/`retryOnWorkerDeath`/`notificationGroup`). Set `foreground: true` when the next step needs the result in the same tool call; use `returnPattern`/`returnLines`/`maxBytes` to keep noisy output bounded without a second check turn. Or start a named subagent (`profile: "subagent"`, `task`, optional `name`/`agent`/`model`/`tools`/`maxDepth` and budget fields). `maxDepth` defaults to 1. Quick commands return inline; longer ones notify in the background |
| `babysit_check` | Without an id, list sessions with state/kind filters. With an id, inspect bounded output, search with `pattern`, or capture a TUI with `screen: true`; `maxBytes` overrides the 4 KB default up to 24 KB |
| `babysit_send` | Process: type `text` / press `keys` into the PTY. Subagent: steer mid-run, or send a follow-up task when confirmed settled (`mode: auto/steer/task`); explicit task mode rejects busy, parked, or unknown state |
| `babysit_wait` | Block until done: process exit (or `expect: "regex"` readiness marker), subagent task completion. Multi-wait: up to 32 unique `ids` + `mode: "any"\|"all"` |
| `babysit_kill` | Terminate a session, verify terminal state, then suppress the exit notification |

The built-in `bash` tool is removed from the active tool set so the model does
not waste a failed tool turn before choosing `babysit_run`. A fallback
`tool_call` hook still blocks direct shell calls if another extension or preset
re-enables `bash`, including shell backgrounding (`… &`, `nohup`, `setsid`,
`disown`). Set `PI_BABYSIT_ALLOW_BASH=1` to retain direct `bash` explicitly.

## Commands (human)

| Command | What it does |
| ------- | ------------ |
| `/babysit` | Arrow-key picker over all sessions. Renders an **inline snapshot** (no tmux): running **process** → current rendered screen + recent output + a copy-paste `babysit attach` take-over hint (detach `Ctrl-\ Ctrl-\`); running **subagent** → read-only progress (RPC stdin stays untouchable); finished → summary. Re-run `/babysit` to refresh |
| `/babysit gc [days]` | Preview and confirm deletion of old Pi-session roots (default 14 days). Active leases, live supervisor/child PIDs, unknown states, the current root, and recent roots are retained; deletion uses a GC lock and atomic rename |

A minimal widget above the editor shows live counts
(`N processes · M subagents working · K idle`).

## Logs without context flooding

`babysit_run`, `babysit_wait`, and automatic completion notifications always
return lifecycle metadata and the absolute path to the complete `output.log`.
Explicit run/wait results inline complete output up to 8 KB; unsolicited
completion notifications use a stricter 2 KB per-process output cap and an 8 KB
aggregate message cap. Process exits observed in one poll share one message and
trigger one agent turn. If even the compact summaries and log paths exceed the
aggregate cap, the largest fitting prefix is delivered and the remainder stays
pending for the next poll. Larger output stays out of model context. Inspect it
through the session id without creating another shell session:

```text
babysit_check { id: "cargo-test", lines: 50 }
babysit_check { id: "cargo-test", pattern: "FAIL|ERROR", lines: 50 }
```

Tail and search results are capped at 200 lines and default to a 4 KB total
result cap; `babysit_check.maxBytes` can raise or lower that per call (up to
24 KB). A single explicitly waited-for subagent answer may use up to 24 KB;
multi-session wait results default to the 8 KB inline-output limit and can opt
into a larger cap with `maxBytes`. Foreground runs can apply `returnPattern` or
`returnLines` before output enters context, avoiding a follow-up check turn.
Pattern search returns the latest matching lines with line numbers. Prefer a
targeted pattern over a broad tail, and do not read a potentially large log file
in full. Subagent crashes return structured errors plus the full log path, never
a raw RPC JSON tail.

Subagent logs compact Pi's streaming `message_update` events before they are
recorded. Pi repeats the complete growing assistant message and partial snapshot
on every token; pi-babysit retains only the incremental delta. Compact RPC
logging is the default and also removes duplicate payloads from `message_start`,
`turn_end`, successful `tool_execution_end`, and `agent_end`, while preserving
authoritative `message_end`, failures, responses, and errors. Parked-process
state is materialized as a small boolean so completion detection is unchanged.
Set `PI_BABYSIT_RPC_LOG_MODE=standard` only when legacy lifecycle payloads are
needed for debugging. Live `/babysit` and attach views render either format.

All shell commands, including `pwd` and Git, go through `babysit_run`. Bundle
closely related tiny observations when doing so safely reduces tool turns.
Set `PI_BABYSIT_ALLOW_BASH=1` only as an explicit emergency escape hatch.

## Unexpected worker loss

If the babysit supervisor disappears without recording an exit, pi-babysit
normalizes the stale `running` state to `worker-dead` and returns immediately
instead of hanging. Possible causes include host process cleanup, endpoint
security, or a supervisor crash. For commands known to be safe and idempotent,
set `retryOnWorkerDeath: true` to retry once with a new session id. It is opt-in
because blindly rerunning an arbitrary command can duplicate side effects.

## How completion detection works

- **Process**: a 2.5s poller watches for running→exited transitions and, once the
  parent agent is idle, injects one
  `pi.sendMessage(…, { triggerTurn: true, deliverAs: "steer" })` containing every
  deliverable exit observed in that poll (deduped via `meta/<id>.json`). Waiting
  for idleness prevents an immediately-following `babysit_wait` from racing the
  poller and receiving a duplicate completion. Background process calls emitted
  together in one assistant message automatically share a notification group;
  an explicit `notificationGroup` overrides this. Group members wait for every
  currently running member to stop and then share one notification even when
  their exits span multiple polls.
  `babysit_kill` and an exit already reported by `babysit_wait` suppress the
  notification.
- **Subagent**: `babysit_wait` blocks on `babysit expect '"type":"agent_settled"'`.
  Unlike `agent_end`, `agent_settled` cannot precede an automatic retry,
  compaction retry, or queued continuation. A settled run containing a
  **parked** toolResult — a `babysit_run { command }` result carrying the
  `[notify-on-exit]` marker (or the legacy `process` tool) — only means "turn
  parked awaiting a process-exit notification; pi resumes on its own", so the
  wait continues. The marker-bearing result may be followed by a short
  assistant note without defeating parked detection. Per-task byte offsets
  scope check/wait to the CURRENT task, and appended log bytes are parsed
  incrementally, which keeps follow-up tasks efficient.

Subagents load `self-reap.ts`, which exits an idle finished subagent after a
grace window (`PI_BABYSIT_REAP_AFTER`, default 120s) using the same parked-turn
rule, so a subagent waiting on a long build is never false-killed. Give bounded
recon/review tasks at least one cost, turn, tool-call, or token budget; omit
budgets only for intentionally open-ended work. Optional task budgets are
observed by the parent poller. At 80% of a limit the worker is steered to wrap
up; reaching the configured limit starts the hard grace immediately, even if a
wedged worker cannot accept steering. An in-flight model call or parallel tool
batch can still overshoot before the next poll. If the worker remains active
after `PI_BABYSIT_BUDGET_GRACE`, termination is verified before it is marked
budget-killed. Usage shown by check/wait is cumulative, and the first terminal
wait for each task charges that nested usage exactly once to the parent Pi
session totals.

## Environment overrides

| Var | Default | Purpose |
| --- | ------- | ------- |
| `PI_BABYSIT_DIR` | `~/.pi-babysit` | babysit state root (namespaced per pi session) |
| `PI_BABYSIT_BIN` | `pi` | agent binary for subagents |
| `PI_BABYSIT_CLI` | `babysit` | babysit binary |
| `PI_BABYSIT_VIEW_CMD` | bundled `format-stream.mjs` | live-attach pretty printer for subagent JSONL (`""` disables) |
| `PI_BABYSIT_QUICK_GRACE` | `2s` | interactive process grace before a still-running command is returned as background work; use `foreground: true` to wait explicitly |
| `PI_BABYSIT_REAP_AFTER` | `120s` | idle grace before a finished subagent self-exits (`off`/`none`/`0` disables) |
| `PI_BABYSIT_BUDGET_GRACE` | `90s` | grace after a subagent budget is exceeded before verified termination |
| `PI_BABYSIT_RPC_LOG_MODE` | `compact` | `compact` removes duplicate RPC lifecycle payloads; `standard` opts into legacy payloads |
| `PI_BABYSIT_RETENTION_DAYS` | `3` | at most once per day, remove safe terminal roots older than this; set `0` to disable automatic retention |
| `PI_BABYSIT_TAIL_MAX_BYTES` | `4000` | default cap for explicit log tails/screens returned by `babysit_check`; override per call with `maxBytes` |
| `PI_BABYSIT_INLINE_OUTPUT_MAX_BYTES` | `8000` | cap for complete process output and aggregate multi-wait results |
| `PI_BABYSIT_NOTIFY_OUTPUT_MAX_BYTES` | `2000` | per-process output cap for unsolicited completion notifications (`0` omits all output) |
| `PI_BABYSIT_NOTIFY_COMMAND_MAX_BYTES` | `240` | cap for each command preview in completion notifications |
| `PI_BABYSIT_NOTIFY_BATCH_MAX_BYTES` | `8000` | hard cap for one aggregated completion notification |
| `PI_BABYSIT_ALLOW_BASH` | unset | set to `1` to bypass direct-Bash redirection (emergency escape hatch) |

Requires `babysit` 0.13.0 or newer and `pi` on `PATH`. The extension does **not**
auto-install `babysit`: if the binary is missing or too old, every tool and the
`/babysit` command fail with install instructions (`cargo install --git
https://github.com/yusukeshib/babysit` or a prebuilt release), and a warning is
shown at session start. Point `$PI_BABYSIT_CLI` at a custom binary path if
needed.

(No tmux dependency — `/babysit` renders inline; take over a live process
manually with the `babysit attach` command it shows.)
