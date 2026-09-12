# Codex → ZCode worker bridge

This bridge exposes ZCode as a small local MCP worker instead of pretending GLM is a native Codex model.

## Mapping

- `glm53_worker` → `GLM-High` → ZCode `GLM-5.3`
- `glm53_flash_worker` → `GLM-Flash` → ZCode `GLM-5.3-Flash`

Both workers pass the current workspace path to ZCode. ZCode therefore sees the same files, Git state, `AGENTS.md`, `.zcode` project configuration, and project memory.

## How it works

The default transport drives the logged-in ZCode Desktop over a loopback-only Chrome DevTools Protocol endpoint. It opens the requested workspace, selects the mapped model and permission mode, submits the task through ZCode's real composer, and reads completion/output from ZCode's local SQLite session store.

ZCode itself remains responsible for provider authentication and the private `interaction/requestProviderRuntimeHeaders` flow. The bridge never copies captcha headers, cookies, or tokens. If ZCode displays an interactive captcha, the job changes to `needs_user_action` and leaves the visible window open. After the user completes verification, the same job automatically returns to `running`.

Desktop jobs are serialized because they share one visible ZCode window.

## Install

1. Run `scripts\start-zcode-desktop.ps1`. If ZCode is already running without CDP, close it first or use the explicit force-restart script `scripts\restart-zcode-desktop.ps1`.
2. Keep ZCode Desktop logged in.
3. Run `scripts\install-agents.ps1`, restart Codex, and ask the main agent to spawn `glm53_worker` or `glm53_flash_worker`.

The installer resolves Node and the bridge directory, then renders portable agent templates into your Codex home.

The MCP process reads the enabled BigModel Start Plan provider from `%USERPROFILE%\.zcode\v2\config.json` at runtime. It does not copy credentials to this repository.

Environment overrides:

- `ZCODE_NODE_EXE`
- `ZCODE_CLI`
- `ZCODE_CONFIG`
- `ZCODE_PROVIDER_ID`
- `ZCODE_EXE`
- `ZCODE_DB`
- `ZCODE_CDP_HOST` (default `127.0.0.1`)
- `ZCODE_CDP_PORT` (default `19223`)
- `ZCODE_TASK_TIMEOUT_MS`
- `ZCODE_TRANSPORT` (`desktop` by default; `cli` retains the legacy diagnostic route)

## Verification

Run either model through the MCP bridge:

```powershell
E:\Node.js\node.exe scripts\smoke-run.cjs . GLM-High
E:\Node.js\node.exe scripts\smoke-run.cjs . GLM-Flash
```

Both routes have been verified against ZCode Desktop 3.11.2. The resulting parent and ZCode subagent sessions use the selected `GLM-5.3` or `GLM-5.3-Flash` provider model.

## Legacy CLI limitation

BigModel Coding Plan rejects standalone headless requests with provider error `3007: captcha verify failed`. ZCode Desktop supplies the required private runtime headers; the standalone CLI does not. Set `ZCODE_TRANSPORT=cli` only for diagnostics.
