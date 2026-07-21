# pi-babysit

A [pi](https://github.com/earendil-works/pi) extension that runs **anything
long-lived** under [babysit](https://github.com/yusukeshib/babysit)-supervised
PTY sessions — one substrate for background processes **and** pi subagents.
It retires both `@mjakl/pi-processes` (the `process` tool) and the old
`pi-subagent` extension.

## Install

```sh
pi install npm:@yusukeshib/pi-babysit
```

Then install the [`babysit`](https://github.com/yusukeshib/babysit) binary
(the extension does **not** auto-install it):

```sh
cargo install --git https://github.com/yusukeshib/babysit
```

or grab a prebuilt binary from the
[releases](https://github.com/yusukeshib/babysit/releases) and put it on your
`PATH`. If it's missing, every tool and the `/babysit` command fail with these
instructions.

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
| `babysit_run` | Start a process (`command`, optional `name`/`pty`/`timeout`/`idleTimeout`) or a subagent (`profile: "subagent"`, `task`, optional `agent`/`model`/`tools`). Non-blocking; returns a session id |
| `babysit_check` | List all sessions, or inspect one: process → state + log tail (or `screen: true` for TUIs); subagent → live progress (turns, recent tool calls, partial answer) |
| `babysit_analyze` | Run a local JavaScript, Python, or shell analyzer over a process's complete captured log; only its bounded report returns to the model |
| `babysit_send` | Process: type `text` / press `keys` into the PTY. Subagent: steer mid-run, or send a follow-up task when idle (`mode: auto/steer/task`) |
| `babysit_wait` | Block until done: process exit (or `expect: "regex"` readiness marker), subagent task completion. Multi-wait: `ids` + `mode: "any"\|"all"` |
| `babysit_kill` | Terminate a session (suppresses the exit notification) |

A `tool_call` hook also blocks bash commands that background themselves
(`… &`, `nohup`, `setsid`, `disown`) and points the agent at `babysit_run`
(carried over from pi-processes' `blockBackgroundCommands`).

## Commands (human)

| Command | What it does |
| ------- | ------------ |
| `/babysit` | Arrow-key picker over all sessions. Renders an **inline snapshot** (no tmux): running **process** → current rendered screen + recent output + a copy-paste `babysit attach` take-over hint (detach `Ctrl-\ Ctrl-\`); running **subagent** → read-only progress (RPC stdin stays untouchable); finished → summary. Re-run `/babysit` to refresh |

A minimal widget above the editor shows live counts
(`N processes · M subagents working · K idle`).

## Log reports without context flooding

A process run can include a `report` program. On completion, babysit writes the
complete recorded log to a temporary file, runs the program in a separate local
child process, and sends **only the program's bounded stdout** in the automatic
completion notification. This avoids putting a full test/build log in the model
context while preserving the original log for `babysit_check`, `/babysit`, or
`babysit attach`.

```ts
babysit_run({
  name: "test",
  command: "npm test",
  report: {
    language: "javascript",
    code: `
      const failures = FILE_CONTENT.split("\\n")
        .filter(line => /FAIL|Error:|✗/.test(line));
      console.log(`failures: ${failures.length}`);
      console.log(failures.slice(-20).join("\\n"));
    `,
  },
});
```

JavaScript and Python reports receive `FILE_CONTENT` and `INPUT`; shell reports
read the log path from `$BABYSIT_REPORT_INPUT`. `report.timeout` defaults to
30 seconds. Input is capped at 64 MiB and returned report output at 12 KB.
Use `babysit_analyze` with the same `language`, `code`, and optional `timeout`
fields to analyze a running process's output so far or re-analyze a completed
process. Report code executes with your local user permissions, just like any
other extension tool command; it is isolated from the pi extension host but is
not an OS security sandbox.

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

Requires `babysit` and `pi` on `PATH`. The extension does **not** auto-install
`babysit`: if the binary is missing, every tool and the `/babysit` command fail
with install instructions (`cargo install --git https://github.com/yusukeshib/babysit`
or a prebuilt release), and a warning is shown at session start. Point
`$PI_BABYSIT_CLI` at a custom binary path if needed.

(No tmux dependency — `/babysit` renders inline; take over a live process
manually with the `babysit attach` command it shows.)
