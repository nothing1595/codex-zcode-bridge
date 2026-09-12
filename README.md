# Codex → ZCode worker bridge

This bridge exposes ZCode as a small local MCP worker instead of pretending GLM is a native Codex model.

## Mapping

- `glm53_worker` → `GLM-High` → ZCode `GLM-5.3`
- `glm53_flash_worker` → `GLM-Flash` → ZCode `GLM-5.3-Flash`

Both workers pass the current workspace path to ZCode. ZCode therefore sees the same files, Git state, `AGENTS.md`, `.zcode` project configuration, and project memory.

## Install

Run `scripts\install-agents.ps1`, restart Codex, and ask the main agent to spawn `glm53_worker` or `glm53_flash_worker`. The installer resolves Node and the bridge directory, then renders portable agent templates into your Codex home.

The MCP process reads the enabled BigModel Start Plan provider from `%USERPROFILE%\.zcode\v2\config.json` at runtime. It does not copy credentials to this repository.

Environment overrides:

- `ZCODE_NODE_EXE`
- `ZCODE_CLI`
- `ZCODE_CONFIG`
- `ZCODE_PROVIDER_ID`

## Current ZCode 3.11.2 limitation

The bundled CLI advertises `--settings` and `--max-turns`, but its active argument parser rejects them. The bridge therefore selects the model through the supported `ZCODE_MODEL`, `ZCODE_BASE_URL`, and `ZCODE_API_KEY` child-process environment variables.

BigModel Coding Plan currently rejects standalone headless requests with provider error `3007: captcha verify failed`. ZCode Desktop supplies private runtime captcha headers through `interaction/requestProviderRuntimeHeaders`; the standalone CLI does not. The MCP server detects and reports this blocker explicitly instead of reporting false success.
