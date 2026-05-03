# Discode

Discode lets one or more approved Discord users drive local coding agents from Discord threads, DMs, group chats, and servers.

## Install

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/morefeinn/discode/main/install.sh | sh
discode start --background
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/morefeinn/discode/main/install.ps1 | iex
discode start --background
```

The installer checks for Git and Bun, asks before installing missing dependencies, installs production dependencies, and links the `discode` CLI. The first `discode start` runs setup automatically when `.env` is missing.
Existing installs are updated from the latest `main` before dependencies are installed.

Manual install:

```bash
git clone https://github.com/morefeinn/discode.git
cd discode
bun install
bun link
discode setup
```

The Discode installer writes a local `.env`. Required values are:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `ALLOWED_USER_IDS`

`ALLOWED_USER_IDS` is comma-separated. `PRIMARY_ALLOWED_USER_ID` defaults to the first allowed user. You can later adjust allowed users and notification behavior from the bot's settings command.

During setup, pasted secrets stay visible only as a short mask such as `abc...xyz`. The setup flow can import existing Codex/OpenCode credentials and can add multiple Codex/OpenAI, Anthropic, Groq, Z.ai, Qwen, OpenCode, or custom accounts immediately.

Setup clears the terminal between major screens so Discord, runtime, credential, and provider prompts stay focused. Set `NO_CLEAR=1` if you need scrollback while debugging.

## Commands

```bash
discode setup
discode update --check
discode update
discode start
discode start --background
discode credentials import
discode restart
discode stop
discode status
discode logs
```

## Development

```bash
bun install
bun run setup
bun run dev
bun run check
bun run build
```

The app runs TypeScript directly with Bun. `bun run build` writes a bundled `dist/index.js` for packaging checks.

## Discord

The slash command name is derived from the bot username unless `DISCODE_COMMAND_NAME` is set. For example, a bot named `Discode` registers `/discode`; a bot named `Builder` registers `/builder`.

Core commands:

- `/init`
- `/<bot-name> prompt`
- `/<bot-name> new`
- `/<bot-name> init`
- `/<bot-name> review`
- `/<bot-name> triage`
- `/<bot-name> image`
- `/<bot-name> files`
- `/<bot-name> usage`
- `/<bot-name> settings`
- `/<bot-name> terminal`
- `/<bot-name> project`
- `/<bot-name> chats`
- `/<bot-name> load`
- `/<bot-name> archive`

Mentions and normal messages in Discode-created threads continue the current conversation. Message replies, channel mentions, files, and screenshots are included as context when the bot can read them.

`/init` and `/<bot-name> init` initialize the active workspace by asking the agent to inspect the project and create or update `AGENTS.md`.

Prompts, reviews, triage, and init support optional tool tags through the `tools` option or plain chat text when a configured provider supports them.

When a conversation is already running, Discode offers `Steer now` to interrupt the active run or `Queue prompt` to run the new request next.

## Accounts

Discode stores accounts, settings, model cache, usage, projects, and conversation history in its app data folder. By default that is `~/.discode`; set `DISCODE_DATA_DIR` to move it. Managed workspaces live under `~/.discode/workspaces` unless `DISCODE_WORKSPACES_DIR` is set. Existing repo-local `data/*.json` files are copied into the app data folder on first use so older installs keep their state.

During setup, or later with `discode credentials import`, Discode can copy usable credentials from the local `.env`, `~/.codex/auth.json`, and OpenCode auth files such as `~/.local/share/opencode/auth.json`. After import, Discode uses its own account store and load balancer; it does not depend on codex-switcher.

```json
{
  "version": 1,
  "active_account_id": "main",
  "accounts": [
    {
      "id": "main",
      "name": "Main",
      "provider": "codex",
      "auth_mode": "session",
      "auth_data": {
        "access_token": "account-access-token",
        "account_id": "account-id"
      }
    },
    {
      "id": "custom-backend",
      "name": "Custom backend",
      "provider": "custom",
      "auth_mode": "api_key",
      "command": "my-agent --model {model}",
      "auth_data": {
        "api_key": "provider-api-key",
        "env_key": "OPENAI_API_KEY"
      }
    }
  ]
}
```

Supported harnesses are `discode`, `codex`, `anthropic`, `zai`, `qwen`, `groq`, `opencode`, and `custom`. `discode` is the native harness: it talks to provider APIs directly and can use local computer tools when permissions allow. `DISCODE_PROVIDER` is always the active harness unless a user explicitly switches in settings. Account `priority` controls account ordering inside a provider, and `DISCODE_PROVIDER_PRIORITY` controls fallback order when usage limits are hit. Account `env` values and API keys are passed only to the native harness or child agent processes.

Use the usage dashboard's `Add account` button to add Codex/OpenAI, Anthropic, Groq, OpenCode, Z.ai, Qwen, or custom accounts. The native Discode harness can use imported API credentials directly. OpenCode remains optional as an import source or fallback wrapper, not the default harness. For providers that expose an OpenAI-compatible API, add a `custom` account with the API key and base URL. API keys are stored in the app data account file with mode `0600` and injected only into Discode's native harness or child agent processes.

If a configured provider CLI is missing from `PATH`, Discode shows an install-and-retry button when it knows the provider package.

Model pickers query the active provider API when credentials are available, then fall back to the live models.dev catalog/cache. `DISCODE_MODEL_CHOICES` is only for extra manual IDs; Discode no longer ships a fixed model list.

Usage checks support Codex session usage automatically. Other providers can expose credits or limits by adding `credits_balance`, `remaining_percent`, or a `usage_command` to the account. `usage_command` should print JSON with fields such as `primaryWindow`, `secondaryWindow`, or `creditsBalance`.

Rust backends are supported as custom provider binaries through `DISCODE_PROVIDER=custom` and `DISCODE_PROVIDER_COMMAND`.

## Native Harness

`DISCODE_PROVIDER=discode` runs Discode's own harness instead of a CLI wrapper. The native harness has dedicated modules for:

- provider routing and live model resolution (`src/harness/providers.ts`)
- tool execution (`src/harness/tools.ts`)
- workspace file tools (`list_directory`, `read_file`, `write_file`, `edit_file`, `delete_file`, `grep`, `apply_patch`)
- terminal execution (`execute_shell`)
- recursive subagents (`spawn_subagent`)
- TCP socket sessions (`socket_open`, `socket_write`, `socket_close`)
- persistent local processes (`process_start`, `process_write`, `process_read`, `process_stop`)
- harness runtime orchestration (`src/harness/runtime.ts`)

Native local tools are only exposed when the run permission mode allows full automation. Directory or review-oriented modes answer without host tools.

## Permissions

- `full`: run with full local automation
- `directory`: ask for approval before elevated access
- `auto-review`: default to read-only review behavior

Set the default with `DISCODE_PERMISSION_MODE`; change it later from the bot's settings command.

## Extensions

Project-specific integrations should stay optional. Put credentials in `.env`, expose tools through an MCP server or wrapper, and document the workflow next to your project.

The built-in Roblox extension variables are:

- `DISCODE_EXTENSION_ROBLOX_API_KEY`
- `DISCODE_EXTENSION_ROBLOX_UNIVERSE_ID`
- `DISCODE_EXTENSION_ROBLOX_PLACE_ID`
