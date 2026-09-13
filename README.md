# Codex → ZCode worker bridge

This bridge exposes ZCode as a small local MCP worker instead of pretending GLM is a native Codex model.

## Mapping

- `glm53_worker` → `GLM-High` → ZCode `GLM-5.3`
- `glm53_flash_worker` → `GLM-Flash` → ZCode `GLM-5.3-Flash`

Both workers pass the current workspace path to ZCode. ZCode therefore sees the same files, Git state, `AGENTS.md`, `.zcode` project configuration, and project memory.

## Architecture

```
Codex workers (each subagent may spawn its own MCP wrapper process)
        │ stdio MCP
        ▼
server/zcode-worker.cjs        thin MCP wrapper; relays to the broker
        │ loopback TCP 127.0.0.1:19224 (line-delimited JSON)
        ▼
server/zcode-broker.cjs        singleton daemon owning ALL shared state:
        │  - window mutex   (every UI mutation: submit / cancel)
        │  - semaphore      (ZCODE_MAX_PARALLEL_JOBS concurrent jobs)
        │  - job table      (state machine + results, survives wrappers)
        │  - global captcha monitor
        ▼
desktop/zcode-desktop.cjs      CDP UI driving + read-only SQLite polling
        │
        ▼
ZCode Desktop (logged in; provider auth and captcha headers stay inside ZCode)
```

Codex can start one wrapper process per subagent; all of them funnel into the single broker, so cross-process sharing of one visible ZCode window stays safe. If no broker is running, a wrapper spawns one detached; concurrent spawns converge because the loser exits on `EADDRINUSE`. Finished jobs stay queryable in the broker for one hour and by any wrapper process.

## Parallel execution model

ZCode's engine runs sessions concurrently (it only serializes prompts *within* one session), so the bridge splits every task into two phases:

1. **Submit (window-exclusive, a few seconds).** Under the broker's window mutex: open workspace, new task / resume, pick mode and model, type the prompt, click send, wait for the session id to appear in ZCode's SQLite store. Jobs are staggered through this phase even when submitted simultaneously.
2. **Watch (parallel).** Each job polls only its own session rows read-only until the final assistant message arrives. Any number of these run at the same time; switching the visible tab away does not stop a running task.

Each prompt ends with a `[bridge job <job_id>]` nonce line, so a job always attributes exactly its own session even when identical task texts run in parallel.

Concurrency limit: `ZCODE_MAX_PARALLEL_JOBS` (default **2**). Extra jobs queue as `queued` and start when a slot frees. The default matches the observed BigModel Coding Plan behavior: two concurrent provider turns run fine for minutes, but a third simultaneous turn is rejected at request time with `unknown_error (UNKNOWN_ERROR)` and zero tokens. Raise the value only if your plan allows more concurrent turns.

**Scheduling rule for the main Codex agent:** parallel GLM workers are best for search, analysis, different modules, different files, and independent experiments. Do not let two parallel workers modify the same file — serialize those or isolate them with `git worktree`. If a job fails with `unknown_error (UNKNOWN_ERROR)` and no output, another ZCode turn was likely active at the same moment (plan concurrency cap or manual use of the ZCode app); retry the same task once after another GLM job finishes.

## Session continuity

`continue_task` resumes a ZCode session with conversation-level context intact. The agent instructions pin one long-lived ZCode session per Codex worker conversation: the first task uses `run_task`, and every follow-up in the same conversation uses `continue_task` with the session_id reported by `get_status`.

Two behaviors verified against ZCode Desktop:

- A follow-up either appends to the same session or forks a linked follow-up task; both carry the previous conversation (the fork's first request tokens equal the prior turn's input + output). The bridge returns whichever session actually received the prompt, so further continues chain correctly.
- The turn_usage completion signal must be attributed to the *current* turn: a continued session still has its previous turns' `completed` rows, which would otherwise read as instant completion with empty output. `readSession` only trusts a usage row that started at/just before the last user message.

Note: the delegated subagent inside ZCode always starts fresh by design; the ZCode main agent's summary is what carries across turns.

## Unattended-run handling

Two ZCode UI states would otherwise block forever with nobody at the machine:

- **Plan approval** (`ExitPlanMode` card "请审阅此实施计划"). ZCode latches the interactive task's permission mode at task creation (default `plan`), so the main agent eventually presents an implementation plan and waits for a human. The bridge detects the pending approval in the session store and clicks `批准` automatically - the yolo semantic the bridge promises.
- **Agent questions** (`AskUserQuestion`). These cannot be auto-answered. The job reports `needs_user_action` with a blocker telling the operator to answer in the ZCode window; it resumes automatically once answered.

To keep Codex-side quota burn low while jobs run for many minutes, `get_status` supports a server-side long poll: pass `wait_ms` (capped at 45000; the agent instructions use 40000). The call returns as soon as the job's observable state changes instead of immediately, so a polling wrapper costs one tool round-trip per status change rather than one per second.

## Cancellation and captcha

- `cancel_task` is safe at any phase. Before send, the job aborts immediately. After send, the broker first hunts down the session id and stops the ZCode session through the UI (so no orphan session keeps burning tokens), then finalizes the job as `cancelled`.
- The captcha check reads the whole ZCode window, so a captcha pauses the entire desktop: every active bridge job reports `needs_user_action` and all of them resume automatically once the visible window is verified.

## Install

1. Run `scripts\start-zcode-desktop.ps1`. If ZCode is already running without CDP, close it first or use the explicit force-restart script `scripts\restart-zcode-desktop.ps1`.
2. Keep ZCode Desktop logged in.
3. Run `scripts\install-agents.ps1`, restart Codex, and ask the main agent to spawn `glm53_worker` or `glm53_flash_worker`.

The installer resolves Node and the bridge directory, renders portable agent templates into your Codex home, and registers `zcode_worker` globally so spawned custom agents inherit the MCP tools. Restart Codex after installation or configuration changes.

The MCP process reads the enabled BigModel Start Plan provider from `%USERPROFILE%\.zcode\v2\config.json` at runtime. It does not copy credentials to this repository.

Environment overrides:

- `ZCODE_NODE_EXE`
- `ZCODE_CLI`
- `ZCODE_CONFIG`
- `ZCODE_PROVIDER_ID`
- `ZCODE_EXE`
- `ZCODE_DB`
- `ZCODE_CDP_HOST` (default `127.0.0.1`)
- `ZCODE_CDP_PORT` (default `19223`, ZCode Desktop's CDP endpoint)
- `ZCODE_BROKER_PORT` (default `19224`, bridge-internal loopback port)
- `ZCODE_MAX_PARALLEL_JOBS` (default `2`, semaphore for concurrently watching sessions; the Coding Plan rejects a 3rd concurrent turn)
- `ZCODE_BROKER_IDLE_MS` (default `600000`, broker exits after this much idle time)
- `ZCODE_TASK_TIMEOUT_MS`
- `ZCODE_CANCEL_HUNT_TIMEOUT_MS` (default `60000`, bound for finding a session while cancelling after send)
- `ZCODE_TRANSPORT` (`desktop` by default; `cli` retains the legacy diagnostic route)

## Verification

Run either model through the MCP bridge:

```powershell
E:\Node.js\node.exe scripts\smoke-run.cjs . GLM-High
E:\Node.js\node.exe scripts\smoke-run.cjs . GLM-Flash
```

Verify parallel execution (3 concurrent jobs through one wrapper process, then through 3 independent wrapper processes, then a mid-run cancel):

```powershell
E:\Node.js\node.exe scripts\smoke-parallel.cjs . GLM-Flash 2
E:\Node.js\node.exe scripts\smoke-parallel.cjs . GLM-Flash --multi 2
E:\Node.js\node.exe scripts\smoke-parallel.cjs . GLM-Flash --cancel
E:\Node.js\node.exe scripts\smoke-parallel.cjs . GLM-Flash --cancel-early
```

The parallel script prints each ZCode session's `turn_usage` time range and asserts that the ranges overlap. While it runs, the ZCode task list should show several tasks `正在运行` at once.

Both routes have been verified against ZCode Desktop 3.11.2. The resulting parent and ZCode subagent sessions use the selected `GLM-5.3` or `GLM-5.3-Flash` provider model.

## Legacy CLI limitation

BigModel Coding Plan rejects standalone headless requests with provider error `3007: captcha verify failed`. ZCode Desktop supplies the required private runtime headers; the standalone CLI does not. Set `ZCODE_TRANSPORT=cli` only for diagnostics.
