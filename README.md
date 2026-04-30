# Discode

Discode lets one or more approved Discord users drive local coding agents from Discord threads, DMs, group chats, and servers.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/morefeinn/discode/main/install.sh | sh
discode start --background
```

The installer checks for Git and Bun, asks before installing missing dependencies, links the `discode` CLI, then runs Discode setup.

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

## Headless Install

```bash
curl -fsSL https://raw.githubusercontent.com/morefeinn/discode/main/install.sh \
  | DISCODE_YES=1 DISCODE_SETUP_ARGS="--headless --token $DISCORD_TOKEN --client-id $DISCORD_CLIENT_ID --allowed-users $ALLOWED_USER_IDS" sh
```

Useful optional flags:

- `--runtime`: enable runtime setup fields in headless mode
- `--technical`: use the technical setup path
- `--install-deps`: install missing checked dependencies in headless mode
- `--workspace <path>`
- `--provider codex|opencode|anthropic|zai|qwen|custom`
- `--provider-command <command>`
- `--permission full|directory|auto-review`
- `--models <comma-separated-models>`
- `--accounts-path <path>`
- `--roblox`: enable Roblox extension fields

## Commands

```bash
discode setup
discode update --check
discode update
discode start
discode start --background
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

Discode stores accounts in `data/accounts.json` unless `DISCODE_ACCOUNTS_PATH` is set. The file is local state and is ignored by git.

On first run, Discode can import existing Codex sessions from `~/.codex-switcher/accounts.json`. Set `CODEX_SWITCHER_IMPORT_PATH` to import from a different file. After import, Discode uses its own account store.

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
      "id": "wrapper",
      "name": "Wrapper",
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

Supported providers are `codex`, `opencode`, `anthropic`, `zai`, `qwen`, and `custom`. Account `priority` controls account ordering, and `DISCODE_PROVIDER_PRIORITY` controls fallback provider order. Account `env` values and API keys are passed only to child agent processes.

Use the usage dashboard's `Add account` button to add Codex/OpenAI, Anthropic, OpenCode, Z.ai, Qwen, or custom accounts. The flow mirrors OpenCode's provider setup style: use an existing logged-in provider CLI when available, or enter the provider API key locally. API keys are stored in `data/accounts.json` with mode `0600` and injected only into child agent processes.

If a configured provider CLI is missing from `PATH`, Discode shows an install-and-retry button when it knows the provider package.

Model pickers use the configured model list plus the public models.dev catalog when available, so provider models show whether they support thinking/reasoning and tool calls.

Usage checks support Codex session usage automatically. Other providers can expose credits or limits by adding `credits_balance`, `remaining_percent`, or a `usage_command` to the account. `usage_command` should print JSON with fields such as `primaryWindow`, `secondaryWindow`, or `creditsBalance`.

Rust backends are supported as custom provider binaries through `DISCODE_PROVIDER=custom` and `DISCODE_PROVIDER_COMMAND`.

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
