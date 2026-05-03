#!/usr/bin/env bun

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { clearLine, cursorTo } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
    checkForUpdate,
    formatUpdateNotice,
    markUpdateNotified,
    shouldNotifyUpdate
} from '../src/update/checker.ts';
import {
    discoverCredentialCandidates,
    importCredentialCandidates
} from '../src/accounts/importers.ts';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');
const runtimeEnv = getRuntimeEnv();
const dataDir = runtimeEnv.DISCODE_DATA_DIR || defaultDataDir();
const pidPath = path.join(dataDir, 'discode.pid');
const logPath = path.join(dataDir, 'discode.log');
const accountsPath = runtimeEnv.DISCODE_ACCOUNTS_PATH || path.join(dataDir, 'accounts.json');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

const command = process.argv[2] || 'help';
const args = process.argv.slice(3);
const colorEnabled = process.stdout.isTTY && process.env.NO_COLOR !== '1' && process.env.NO_COLOR !== 'true';
const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    gray: '\x1b[90m'
};

function color(value, code) {
    return colorEnabled ? `${code}${value}${colors.reset}` : value;
}

function stripAnsi(value) {
    return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

function box(titleValue, rows = []) {
    const cleanRows = rows.map(row => String(row));
    const width = Math.max(
        stripAnsi(titleValue).length,
        ...cleanRows.map(row => stripAnsi(row).length),
        28
    );
    const top = `+-- ${titleValue} ${'-'.repeat(Math.max(0, width - stripAnsi(titleValue).length - 1))}+`;
    const body = cleanRows.map(row => {
        const padding = ' '.repeat(Math.max(0, width - stripAnsi(row).length));

        return `| ${row}${padding} |`;
    });
    const bottom = `+${'-'.repeat(width + 2)}+`;

    console.log(color(top, colors.cyan));
    for (const line of body) console.log(line);
    console.log(color(bottom, colors.cyan));
}

function banner(subtitle) {
    box(color(`Discode ${packageJson.version}`, colors.bold), [
        subtitle,
        color(rootDir, colors.gray)
    ]);
}

function row(label, value) {
    return `${color(label.padEnd(18), colors.gray)} ${value}`;
}

function title(value) {
    console.log('');
    console.log(color(`== ${value}`, colors.bold));
}

function note(value) {
    console.log(`${color('info ', colors.cyan)} ${value}`);
}

function success(value) {
    console.log(`${color('ok   ', colors.green)} ${value}`);
}

function warn(value) {
    console.log(`${color('warn ', colors.yellow)} ${value}`);
}

function fail(value) {
    console.error(`${color('error', colors.red)} ${value}`);
}

function promptText(value) {
    return color(`> ${value}`, colors.cyan);
}

function providerLabel(provider) {
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'zai') return 'Z.ai';
    if (provider === 'qwen') return 'Qwen';
    if (provider === 'groq') return 'Groq';
    if (provider === 'opencode') return 'OpenCode';
    if (provider === 'custom') return 'Custom';

    return 'Codex';
}

function defaultProviderEnvKey(provider) {
    if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
    if (provider === 'zai') return 'ZAI_API_KEY';
    if (provider === 'qwen') return 'DASHSCOPE_API_KEY';
    if (provider === 'groq') return 'GROQ_API_KEY';

    return 'OPENAI_API_KEY';
}

function maskSecret(value) {
    const normalized = String(value || '');

    if (normalized.length === 0) return '';
    if (normalized.length <= 6) return '*'.repeat(normalized.length);

    return `${normalized.slice(0, 3)}...${normalized.slice(-3)}`;
}

function rewritePromptLine(label, value) {
    cursorTo(process.stdout, 0);
    process.stdout.write(`${promptText(label)}${maskSecret(value)}`);
    clearLine(process.stdout, 1);
}

function hasFlag(name) {
    return args.includes(`--${name}`);
}

function flagValue(name) {
    const prefix = `--${name}=`;
    const inline = args.find(arg => arg.startsWith(prefix));

    if (inline) return inline.slice(prefix.length);
    const index = args.indexOf(`--${name}`);

    if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) {
        return args[index + 1];
    }

    return '';
}

function ensureDataDir() {
    fs.mkdirSync(dataDir, { recursive: true });
}

function isProcessRunning(pid) {
    if (!pid) return false;

    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function readPid() {
    try {
        return Number(fs.readFileSync(pidPath, 'utf8').trim());
    } catch {
        return null;
    }
}

function loadEnvFile() {
    const envPath = path.join(rootDir, '.env');

    if (!fs.existsSync(envPath)) return {};
    const env = {};

    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('#')) continue;
        const index = trimmed.indexOf('=');

        if (index < 0) continue;
        const key = trimmed.slice(0, index).trim();
        let value = trimmed.slice(index + 1).trim();

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        env[key] = value;
    }

    return env;
}

function getRuntimeEnv() {
    return {
        ...loadEnvFile(),
        ...process.env
    };
}

function defaultDataDir() {
    const xdgDataHome = process.env.XDG_DATA_HOME?.trim();

    return xdgDataHome ? path.join(xdgDataHome, 'discode') : path.join(process.env.HOME || rootDir, '.discode');
}

function setupAccountsPath(values) {
    if (values.DISCODE_ACCOUNTS_PATH?.trim()) return values.DISCODE_ACCOUNTS_PATH.trim();
    if (values.DISCODE_DATA_DIR?.trim()) return path.join(values.DISCODE_DATA_DIR.trim(), 'accounts.json');

    return accountsPath;
}

function commandExists(name) {
    return spawnSync('sh', ['-lc', `command -v ${JSON.stringify(name)}`], { encoding: 'utf8' }).status === 0;
}

function installCommand(name) {
    if (name === 'bun') return 'curl -fsSL https://bun.sh/install | bash';
    if (name === 'git') return 'brew install git';
    if (name === 'codex') return 'bun add -g @openai/codex';
    if (name === 'opencode') return 'bun add -g opencode-ai';
    if (name === 'claude' || name === 'anthropic') return 'bun add -g @anthropic-ai/claude-code';
    if (name === 'zai') return 'bun add -g @guizmo-ai/zai-cli';
    if (name === 'qwen') return 'bun add -g @qwen-code/qwen-code';

    return '';
}

async function checkDependencies(rl, headless) {
    const required = ['bun'];
    const recommended = ['git'];
    const missingRequired = required.filter(name => !commandExists(name));
    const missingRecommended = recommended.filter(name => !commandExists(name));

    if (missingRequired.length === 0 && missingRecommended.length === 0) {
        success('Runtime dependencies are available');
        return;
    }
    title('Dependencies');

    for (const name of missingRequired) {
        warn(`Missing required dependency: ${name}`);
    }

    for (const name of missingRecommended) {
        warn(`Missing optional dependency: ${name}`);
    }

    const shouldInstall = headless
        ? hasFlag('install-deps')
        : ['y', 'yes'].includes((await rl.question(promptText('Install missing dependencies now? [y/N]: '))).trim().toLowerCase());

    if (!shouldInstall) {
        if (missingRequired.length > 0) throw new Error(`Install required dependencies first: ${missingRequired.join(', ')}`);
        return;
    }

    for (const name of [...missingRequired, ...missingRecommended]) {
        const command = installCommand(name);

        if (!command) continue;
        note(`Installing ${name}`);
        const result = spawnSync('sh', ['-lc', command], { stdio: 'inherit' });

        if (result.status !== 0 && missingRequired.includes(name)) {
            throw new Error(`Failed to install ${name}.`);
        }
        if (result.status === 0) success(`Installed ${name}`);
    }
}

function readEnvLines() {
    const envPath = path.join(rootDir, '.env');

    if (!fs.existsSync(envPath)) return [];

    return fs.readFileSync(envPath, 'utf8').split('\n');
}

function writeEnvValues(values) {
    const envPath = path.join(rootDir, '.env');
    const lines = readEnvLines();
    const remaining = new Map(Object.entries(values));
    const next = [];

    for (const line of lines) {
        const trimmed = line.trim();
        const index = trimmed.indexOf('=');

        if (!trimmed || trimmed.startsWith('#') || index < 0) {
            if (trimmed) next.push(line);
            continue;
        }
        const key = trimmed.slice(0, index).trim();

        if (remaining.has(key)) {
            next.push(`${key}=${remaining.get(key)}`);
            remaining.delete(key);
        } else if (key !== 'ALLOWED_USER_ID') {
            next.push(line);
        }
    }

    for (const [key, value] of remaining) {
        next.push(`${key}=${value}`);
    }

    fs.writeFileSync(envPath, `${next.join('\n').replace(/\n+$/g, '')}\n`, { mode: 0o600 });
}

async function promptValue(rl, label, current, fallback, required) {
    const currentLabel = current ? ' [set]' : fallback ? ` [${fallback}]` : '';

    while (true) {
        const answer = (await rl.question(promptText(`${label}${currentLabel}: `))).trim();
        const value = answer || current || fallback || '';

        if (!required || value) return value;
        console.log('Required.');
    }
}

async function promptSecret(rl, label, current, required) {
    const suffix = current ? ' [set]' : '';

    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
        const answer = (await rl.question(promptText(`${label}${suffix}: `))).trim();
        const value = answer || current || '';

        if (answer) note(`${label}: ${maskSecret(value)}`);
        if (!required || value) return value;
        console.log('Required.');
        return promptSecret(rl, label, current, required);
    }

    const promptLabel = `${label}${suffix}: `;

    while (true) {
        let value = '';

        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        rewritePromptLine(promptLabel, value);

        const answer = await new Promise((resolve, reject) => {
            const onData = chunk => {
                const text = String(chunk);

                if (text === '\u0003') {
                    cleanup();
                    reject(new Error('Setup cancelled.'));
                    return;
                }
                const newlineIndex = text.search(/[\r\n]/);

                if (newlineIndex >= 0) {
                    const beforeNewline = text.slice(0, newlineIndex);
                    const printable = [...beforeNewline].filter(char => {
                        const code = char.charCodeAt(0);

                        return code >= 32 && code !== 127;
                    }).join('');

                    value += printable;
                    cleanup();
                    process.stdout.write('\n');
                    resolve(value);
                    return;
                }
                if (text === '\u007f' || text === '\b') {
                    value = value.slice(0, -1);
                    rewritePromptLine(promptLabel, value);
                    return;
                }
                if (text === '\u001b') return;

                const printable = [...text].filter(char => {
                    const code = char.charCodeAt(0);

                    return code >= 32 && code !== 127;
                }).join('');

                if (!printable) return;
                value += printable;
                rewritePromptLine(promptLabel, value);
            };
            const cleanup = () => {
                process.stdin.off('data', onData);
                process.stdin.setRawMode(false);
            };

            process.stdin.on('data', onData);
        });
        const normalized = String(answer).trim();
        const next = normalized || current || '';

        if (!required || next) return next;
        console.log('Required.');
    }
}

async function promptBoolean(rl, label, current, fallback) {
    const normalized = String(current || fallback || '').toLowerCase();
    const defaultValue = ['1', 'true', 'yes', 'on', 'y'].includes(normalized);
    const answer = (await rl.question(promptText(`${label} [${defaultValue ? 'Y/n' : 'y/N'}]: `))).trim().toLowerCase();

    if (!answer) return defaultValue ? 'true' : 'false';

    return ['1', 'true', 'yes', 'on', 'y'].includes(answer) ? 'true' : 'false';
}

async function setupValue(rl, options) {
    const cliValue = flagValue(options.flag);
    const current = cliValue || options.current || '';
    const fallback = options.fallback || '';

    if (options.headless) {
        const value = current || fallback;

        if (options.required && !value) throw new Error(`${options.label} is required.`);

        return value;
    }

    return promptValue(rl, options.label, current, fallback, options.required);
}

async function setupSecret(rl, options) {
    const cliValue = flagValue(options.flag);
    const current = cliValue || options.current || '';

    if (options.headless) {
        if (options.required && !current) throw new Error(`${options.label} is required.`);

        return current;
    }

    return promptSecret(rl, options.label, current, options.required);
}

async function setupBoolean(rl, options) {
    const cliValue = flagValue(options.flag);

    if (options.headless) {
        return cliValue || options.current || options.fallback || 'false';
    }

    return promptBoolean(rl, options.label, cliValue || options.current, options.fallback);
}

function createPrompter() {
    if (process.stdin.isTTY) {
        return {
            async question(label) {
                process.stdout.write(label);
                process.stdin.setRawMode?.(false);
                process.stdin.resume();
                process.stdin.setEncoding('utf8');

                return await new Promise((resolve, reject) => {
                    let value = '';
                    const onData = chunk => {
                        const text = String(chunk);

                        if (text.includes('\u0003')) {
                            cleanup();
                            reject(new Error('Setup cancelled.'));
                            return;
                        }

                        const newlineIndex = text.search(/[\r\n]/);

                        if (newlineIndex >= 0) {
                            value += text.slice(0, newlineIndex);
                            cleanup();
                            resolve(value);
                            return;
                        }

                        value += text;
                    };
                    const cleanup = () => {
                        process.stdin.off('data', onData);
                    };

                    process.stdin.on('data', onData);
                });
            },
            close() {
                process.stdin.pause();
            }
        };
    }
    const answers = fs.readFileSync(0, 'utf8').split(/\r?\n/);
    let index = 0;

    return {
        async question(label) {
            process.stdout.write(label);
            const answer = answers[index++] || '';
            process.stdout.write('\n');

            return answer;
        },
        close() {}
    };
}

async function setup() {
    const existing = loadEnvFile();
    const headless = hasFlag('headless') || hasFlag('yes') || hasFlag('ci');
    const rl = createPrompter();

    try {
        banner('Installer');
        note('Configure Discord access, provider routing, and local credentials');
        await checkDependencies(rl, headless);
        title('Discord');
        const values = {
            DISCORD_TOKEN: await setupSecret(rl, { label: 'Discord bot token', flag: 'token', current: existing.DISCORD_TOKEN, required: true, headless }),
            DISCORD_CLIENT_ID: await setupValue(rl, { label: 'Discord client id', flag: 'client-id', current: existing.DISCORD_CLIENT_ID, required: true, headless }),
            ALLOWED_USER_IDS: await setupValue(rl, { label: 'Allowed Discord user ids, comma separated', flag: 'allowed-users', current: existing.ALLOWED_USER_IDS || existing.ALLOWED_USER_ID, required: true, headless })
        };
        values.PRIMARY_ALLOWED_USER_ID = await setupValue(rl, {
            label: 'Primary ping user id',
            flag: 'primary-user',
            current: existing.PRIMARY_ALLOWED_USER_ID,
            fallback: values.ALLOWED_USER_IDS.split(',')[0]?.trim() || '',
            headless
        });
        const mode = headless
            ? (hasFlag('technical') || hasFlag('runtime') ? 'technical' : 'simple')
            : ((await rl.question(promptText('Setup mode simple/technical [simple]: '))).trim().toLowerCase() || 'simple');
        const technical = mode === 'technical';
        const configureRuntime = headless
            ? hasFlag('runtime')
            : technical || ['y', 'yes'].includes((await rl.question(promptText('Configure runtime options now? [y/N]: '))).trim().toLowerCase());

        values.DISCODE_COMMAND_NAME = flagValue('command-name') || existing.DISCODE_COMMAND_NAME || '';
        values.DISCODE_DATA_DIR = flagValue('data-dir') || existing.DISCODE_DATA_DIR || '';
        values.DISCODE_WORKSPACES_DIR = flagValue('workspaces-dir') || existing.DISCODE_WORKSPACES_DIR || '';
        values.DEFAULT_WORKSPACE = flagValue('workspace') || existing.DEFAULT_WORKSPACE || '';
        values.DEFAULT_SANDBOX = flagValue('sandbox') || existing.DEFAULT_SANDBOX || 'workspace-write';
        values.DEFAULT_MODEL = flagValue('model') || existing.DEFAULT_MODEL || '';
        values.DISCODE_MODEL_CHOICES = flagValue('models') || existing.DISCODE_MODEL_CHOICES || '';
        values.DISCODE_PROVIDER = flagValue('provider') || existing.DISCODE_PROVIDER || 'discode';
        values.DISCODE_PROVIDER_PRIORITY = flagValue('provider-priority') || existing.DISCODE_PROVIDER_PRIORITY || 'discode,codex,anthropic,zai,qwen,groq,opencode,custom';
        values.DISCODE_PROVIDER_COMMAND = flagValue('provider-command') || existing.DISCODE_PROVIDER_COMMAND || '';
        values.DISCODE_PERMISSION_MODE = flagValue('permission') || existing.DISCODE_PERMISSION_MODE || 'full';
        values.DISCODE_REMINDER_PINGS = flagValue('reminder-pings') || existing.DISCODE_REMINDER_PINGS || 'true';
        values.OPENCODE_BIN = flagValue('opencode-bin') || existing.OPENCODE_BIN || 'opencode';
        values.ANTHROPIC_BIN = flagValue('anthropic-bin') || existing.ANTHROPIC_BIN || existing.CLAUDE_BIN || 'claude';
        values.ZAI_BIN = flagValue('zai-bin') || existing.ZAI_BIN || 'zai';
        values.QWEN_BIN = flagValue('qwen-bin') || existing.QWEN_BIN || 'qwen';
        values.CODEX_BIN = flagValue('codex-bin') || existing.CODEX_BIN || 'codex';
        values.AUTO_SWITCH_ON_LIMIT = flagValue('auto-switch') || existing.AUTO_SWITCH_ON_LIMIT || 'true';
        values.DISCODE_ACCOUNTS_PATH = flagValue('accounts-path') || existing.DISCODE_ACCOUNTS_PATH || '';
        values.CODEX_AUTH_PATH = flagValue('codex-auth-path') || existing.CODEX_AUTH_PATH || '';
        values.DISCODE_EXTENSION_ROBLOX_API_KEY = flagValue('roblox-api-key') || existing.DISCODE_EXTENSION_ROBLOX_API_KEY || '';
        values.DISCODE_EXTENSION_ROBLOX_UNIVERSE_ID = flagValue('roblox-universe-id') || existing.DISCODE_EXTENSION_ROBLOX_UNIVERSE_ID || '';
        values.DISCODE_EXTENSION_ROBLOX_PLACE_ID = flagValue('roblox-place-id') || existing.DISCODE_EXTENSION_ROBLOX_PLACE_ID || '';

        if (configureRuntime) {
            title('Harness runtime');
            values.DISCODE_COMMAND_NAME = await setupValue(rl, { label: 'Slash command name override', flag: 'command-name', current: existing.DISCODE_COMMAND_NAME, headless });
            values.DISCODE_DATA_DIR = await setupValue(rl, { label: 'Discode app data folder, blank uses ~/.discode', flag: 'data-dir', current: existing.DISCODE_DATA_DIR, headless });
            values.DISCODE_WORKSPACES_DIR = await setupValue(rl, { label: 'Managed workspaces folder, blank uses app data', flag: 'workspaces-dir', current: existing.DISCODE_WORKSPACES_DIR, headless });
            values.DEFAULT_WORKSPACE = await setupValue(rl, { label: 'Default workspace path, optional', flag: 'workspace', current: existing.DEFAULT_WORKSPACE, headless });
            values.DEFAULT_MODEL = await setupValue(rl, { label: 'Model override, blank uses provider default', flag: 'model', current: existing.DEFAULT_MODEL, headless });
            values.DISCODE_MODEL_CHOICES = await setupValue(rl, { label: 'Extra model ids, comma separated', flag: 'models', current: existing.DISCODE_MODEL_CHOICES, headless });
            values.DISCODE_PROVIDER = await setupValue(rl, { label: 'Active provider discode/codex/anthropic/zai/qwen/groq/opencode/custom', flag: 'provider', current: existing.DISCODE_PROVIDER, fallback: 'discode', headless });
            values.DISCODE_PROVIDER_PRIORITY = await setupValue(rl, { label: 'Load balancer provider order', flag: 'provider-priority', current: existing.DISCODE_PROVIDER_PRIORITY, fallback: 'discode,codex,anthropic,zai,qwen,groq,opencode,custom', headless });
            values.DISCODE_PROVIDER_COMMAND = await setupValue(rl, { label: 'Custom provider command', flag: 'provider-command', current: existing.DISCODE_PROVIDER_COMMAND, headless });
            values.DISCODE_PERMISSION_MODE = await setupValue(rl, { label: 'Permission mode full/directory/auto-review', flag: 'permission', current: existing.DISCODE_PERMISSION_MODE, fallback: 'full', headless });
            values.DISCODE_REMINDER_PINGS = await setupBoolean(rl, { label: 'Completion pings', flag: 'reminder-pings', current: existing.DISCODE_REMINDER_PINGS, fallback: 'true', headless });
            values.AUTO_SWITCH_ON_LIMIT = await setupBoolean(rl, { label: 'Auto-switch on usage limits', flag: 'auto-switch', current: existing.AUTO_SWITCH_ON_LIMIT, fallback: 'true', headless });
            values.CODEX_BIN = await setupValue(rl, { label: 'Codex binary', flag: 'codex-bin', current: existing.CODEX_BIN, fallback: 'codex', headless });
            values.OPENCODE_BIN = await setupValue(rl, { label: 'OpenCode binary', flag: 'opencode-bin', current: existing.OPENCODE_BIN, fallback: 'opencode', headless });
            values.ANTHROPIC_BIN = await setupValue(rl, { label: 'Anthropic CLI binary', flag: 'anthropic-bin', current: existing.ANTHROPIC_BIN || existing.CLAUDE_BIN, fallback: 'claude', headless });
            values.ZAI_BIN = await setupValue(rl, { label: 'Z.ai CLI binary', flag: 'zai-bin', current: existing.ZAI_BIN, fallback: 'zai', headless });
            values.QWEN_BIN = await setupValue(rl, { label: 'Qwen CLI binary', flag: 'qwen-bin', current: existing.QWEN_BIN, fallback: 'qwen', headless });
            values.DISCODE_ACCOUNTS_PATH = await setupValue(rl, { label: 'Accounts file path', flag: 'accounts-path', current: existing.DISCODE_ACCOUNTS_PATH, headless });
            values.CODEX_AUTH_PATH = await setupValue(rl, { label: 'Codex auth output path', flag: 'codex-auth-path', current: existing.CODEX_AUTH_PATH, headless });
        }
        const configureRoblox = headless
            ? hasFlag('roblox')
            : technical
                ? (await rl.question(promptText('Configure optional Roblox extension? [y/N]: '))).trim().toLowerCase()
                : 'n';

        if (['y', 'yes'].includes(configureRoblox)) {
            values.DISCODE_EXTENSION_ROBLOX_API_KEY = await promptValue(rl, 'Roblox Open Cloud API key', existing.DISCODE_EXTENSION_ROBLOX_API_KEY, '', false);
            values.DISCODE_EXTENSION_ROBLOX_UNIVERSE_ID = await promptValue(rl, 'Roblox universe id', existing.DISCODE_EXTENSION_ROBLOX_UNIVERSE_ID, '', false);
            values.DISCODE_EXTENSION_ROBLOX_PLACE_ID = await promptValue(rl, 'Roblox place id', existing.DISCODE_EXTENSION_ROBLOX_PLACE_ID, '', false);
        }

        writeEnvValues(values);
        ensureDataDir();
        const targetAccountsPath = setupAccountsPath(values);

        await maybeImportCredentials(rl, headless, targetAccountsPath);
        await setupProviderAccounts(rl, headless, targetAccountsPath, values);
        console.log('');
        box(color('Ready', colors.green), [
            row('env', '.env written with mode 0600'),
            row('accounts', targetAccountsPath),
            row('harness', values.DISCODE_PROVIDER || 'discode'),
            row('workspace', values.DEFAULT_WORKSPACE || 'set later in Discord'),
            row('next', 'discode start')
        ]);
    } finally {
        rl.close();
    }
}

async function maybeImportCredentials(rl, headless, targetAccountsPath = accountsPath) {
    const candidates = await discoverCredentialCandidates(rootDir, getRuntimeEnv());

    if (candidates.length === 0) {
        note('No existing provider credentials found to import.');
        return;
    }
    title('Credentials');
    note(`Found ${candidates.length} local credential source${candidates.length === 1 ? '' : 's'}.`);
    for (const candidate of candidates.slice(0, 8)) {
        note(`${candidate.provider} from ${candidate.source}`);
    }
    const shouldImport = headless
        ? hasFlag('import-credentials')
        : !['n', 'no'].includes((await rl.question(promptText('Copy these into Discode accounts now? [Y/n]: '))).trim().toLowerCase());

    if (!shouldImport) return;
    await importCredentials(candidates, targetAccountsPath);
}

async function importCredentials(candidates = null, targetAccountsPath = accountsPath) {
    const discovered = candidates || await discoverCredentialCandidates(rootDir, getRuntimeEnv());
    if (discovered.length === 0) {
        warn('No existing provider credentials were found.');
        return;
    }
    const result = await importCredentialCandidates(targetAccountsPath, discovered);

    if (result.imported.length === 0) {
        warn(`No new credentials imported. ${result.skipped.length} already configured.`);
        return;
    }
    success(`Imported ${result.imported.length} credential${result.imported.length === 1 ? '' : 's'}`);
    for (const account of result.imported.slice(0, 8)) {
        note(`${account.provider} ${account.name}`);
    }
}

async function setupProviderAccounts(rl, headless, targetAccountsPath, values) {
    if (headless) return;

    title('Provider accounts');
    note('Add API keys now, or skip and use the Discord usage dashboard later.');
    const shouldAdd = !['n', 'no'].includes((await rl.question(promptText('Add provider accounts now? [Y/n]: '))).trim().toLowerCase());

    if (!shouldAdd) return;

    while (true) {
        const provider = (await rl.question(promptText('Provider codex/anthropic/groq/zai/qwen/custom/opencode/done [done]: '))).trim().toLowerCase() || 'done';

        if (provider === 'done' || provider === 'skip' || provider === 'no') return;
        if (!['codex', 'anthropic', 'groq', 'zai', 'qwen', 'custom', 'opencode'].includes(provider)) {
            warn('Choose codex, anthropic, groq, zai, qwen, custom, opencode, or done.');
            continue;
        }

        if (provider === 'opencode') {
            await addOpenCodeAccount(rl, targetAccountsPath);
            continue;
        }

        if (provider === 'codex') {
            await addCodexAccount(rl, targetAccountsPath, values);
            continue;
        }

        await addApiKeyAccount(rl, targetAccountsPath, provider);
    }
}

async function addCodexAccount(rl, targetAccountsPath, values) {
    const mode = (await rl.question(promptText('Codex setup api-key/import/login/skip [api-key]: '))).trim().toLowerCase() || 'api-key';

    if (mode === 'skip') return;
    if (mode === 'import') {
        await importCredentials(await discoverCredentialCandidates(rootDir, getRuntimeEnv()), targetAccountsPath);
        return;
    }
    if (mode === 'login') {
        const bin = values.CODEX_BIN || 'codex';

        if (!commandExists(bin)) {
            warn(`${bin} was not found on PATH. Paste an OpenAI API key instead, or install Codex first.`);
            return;
        }
        note(`Starting ${bin} login`);
        const result = spawnSync(bin, ['login'], { stdio: 'inherit' });

        if (result.status !== 0) {
            warn(`${bin} login did not finish successfully.`);
            return;
        }
        await importCredentials(await discoverCredentialCandidates(rootDir, getRuntimeEnv()), targetAccountsPath);
        return;
    }

    await addApiKeyAccount(rl, targetAccountsPath, 'codex');
}

async function addOpenCodeAccount(rl, targetAccountsPath) {
    const candidates = (await discoverCredentialCandidates(rootDir, getRuntimeEnv()))
        .filter(candidate => candidate.source.toLowerCase().includes('opencode'));

    if (candidates.length > 0) {
        await importCredentials(candidates, targetAccountsPath);
        return;
    }

    const shouldAddWrapper = !['n', 'no'].includes((await rl.question(promptText('No OpenCode auth file found. Add wrapper account anyway? [Y/n]: '))).trim().toLowerCase());

    if (!shouldAddWrapper) return;
    const name = await promptValue(rl, 'Account name', '', 'OpenCode local auth', false);

    await saveManualAccount(targetAccountsPath, {
        provider: 'opencode',
        name,
        auth_mode: 'wrapper',
        auth_data: { source: 'setup' },
        source: 'setup'
    });
}

async function addApiKeyAccount(rl, targetAccountsPath, provider) {
    const label = providerLabel(provider);
    const defaultName = `${label} API key`;
    const name = await promptValue(rl, 'Account name', '', defaultName, false);
    const envKey = await promptValue(rl, 'Environment variable name', '', defaultProviderEnvKey(provider), false);
    const apiKey = await promptSecret(rl, `${label} API key`, '', true);
    const baseUrl = provider === 'custom'
        ? await promptValue(rl, 'API base URL', '', '', true)
        : '';
    const model = await promptValue(rl, 'Default model, optional', '', '', false);

    await saveManualAccount(targetAccountsPath, {
        provider,
        name,
        auth_mode: 'api_key',
        auth_data: {
            api_key: apiKey,
            env_key: envKey,
            ...(baseUrl ? { base_url: baseUrl } : {})
        },
        model: model || undefined,
        source: 'setup'
    });
}

async function saveManualAccount(targetAccountsPath, account) {
    const result = await importCredentialCandidates(targetAccountsPath, [account], true);

    if (result.imported.length > 0) {
        const saved = result.imported[0];
        success(`Added ${providerLabel(saved.provider)} account ${saved.name}`);
        return;
    }

    warn('That account is already configured.');
}

function startForeground() {
    stopExistingInstances();
    banner('Starting foreground runner');
    console.log(row('mode', 'foreground'));
    console.log(row('harness', getRuntimeEnv().DISCODE_PROVIDER || 'discode'));
    console.log(row('logs', 'stdout'));
    const child = spawn(resolveRuntime(), [path.join(rootDir, 'src/index.ts')], {
        cwd: rootDir,
        env: getRuntimeEnv(),
        stdio: 'inherit'
    });

    child.on('exit', code => {
        process.exit(code ?? 1);
    });
}

function startBackground() {
    ensureDataDir();
    stopExistingInstances();
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(resolveRuntime(), [path.join(rootDir, 'src/index.ts')], {
        cwd: rootDir,
        env: getRuntimeEnv(),
        detached: true,
        stdio: ['ignore', logFd, logFd]
    });

    child.unref();
    fs.writeFileSync(pidPath, `${child.pid}\n`);
    banner('Started background runner');
    console.log(row('pid', child.pid));
    console.log(row('harness', getRuntimeEnv().DISCODE_PROVIDER || 'discode'));
    console.log(row('logs', logPath));
}

function stop() {
    stopExistingInstances();
}

function stopExistingInstances() {
    const pid = readPid();

    const stopped = new Set();

    if (isProcessRunning(pid)) {
        process.kill(pid, 'SIGTERM');
        stopped.add(pid);
        success(`Stopped existing Discode pid ${pid}`);
    }
    fs.rmSync(pidPath, { force: true });
    const pattern = `${rootDir}/src/index.ts`;
    const pgrep = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });

    if (pgrep.status !== 0 || !pgrep.stdout.trim()) return;

    for (const value of pgrep.stdout.trim().split('\n')) {
        const foundPid = Number(value.trim());

        if (!foundPid || foundPid === process.pid || stopped.has(foundPid)) continue;

        try {
            process.kill(foundPid, 'SIGTERM');
            success(`Stopped existing Discode pid ${foundPid}`);
        } catch {
        }
    }
}

function status() {
    const pid = readPid();

    if (isProcessRunning(pid)) {
        banner('Status');
        console.log(row('state', color('running', colors.green)));
        console.log(row('pid', pid));
        console.log(row('logs', logPath));
        return;
    }
    banner('Status');
    console.log(row('state', color('stopped', colors.yellow)));
}

function logs() {
    if (!fs.existsSync(logPath)) {
        warn('No log file exists yet.');
        return;
    }
    const text = fs.readFileSync(logPath, 'utf8');
    const lines = text.split('\n').slice(-80).join('\n');
    banner('Recent logs');
    console.log(lines);
}

function resolveRuntime() {
    const bun = spawnSync('sh', ['-lc', 'command -v bun'], { encoding: 'utf8' }).stdout.trim();

    if (bun) return bun;

    console.error('bun is required to run Discode.');
    process.exit(1);
}

async function printUpdateNoticeIfNeeded() {
    if (['setup', 'update', 'version', 'help'].includes(command)) return;
    const status = await checkForUpdate(rootDir);

    if (!status.updateAvailable) return;
    if (!(await shouldNotifyUpdate(rootDir, 'cliLatest', status.latest))) return;

    console.log(formatUpdateNotice(status));
    await markUpdateNotified(rootDir, 'cliLatest', status.latest);
}

async function checkUpdates() {
    banner('Update check');
    const status = await checkForUpdate(rootDir, true);

    if (!status.ok) {
        warn(`Could not check for updates: ${status.error || 'unknown error'}`);
        return;
    }

    if (!status.updateAvailable) {
        console.log(row('state', color('up to date', colors.green)));
        console.log(row('version', status.current));
        return;
    }

    console.log(formatUpdateNotice(status));
}

async function updateDiscode() {
    banner('Updater');
    const status = await checkForUpdate(rootDir, true);

    if (!status.ok) {
        throw new Error(`Could not check for updates: ${status.error || 'unknown error'}`);
    }

    if (!status.updateAvailable) {
        console.log(row('state', color('up to date', colors.green)));
        console.log(row('version', status.current));
        return;
    }

    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: rootDir, encoding: 'utf8' }).stdout.trim();

    if (dirty) {
        throw new Error('Discode has local changes. Commit or stash them before running discode update.');
    }

    console.log(row('current', status.current));
    console.log(row('latest', status.latest));
    note('Pulling latest source');
    runChecked('git', ['pull', '--ff-only', 'origin', 'main']);
    note('Installing dependencies');
    runChecked(resolveRuntime(), ['install']);
    await markUpdateNotified(rootDir, 'cliLatest', status.latest);
    await markUpdateNotified(rootDir, 'discordLatest', status.latest);
    box(color('Updated', colors.green), [
        row('version', status.latest),
        row('next', 'discode restart')
    ]);
}

function runChecked(bin, args) {
    const result = spawnSync(bin, args, {
        cwd: rootDir,
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        throw new Error(`${bin} ${args.join(' ')} failed.`);
    }
}

function help() {
    banner('Command line');
    console.log('');
    console.log(color('Usage', colors.bold));
    console.log('  discode <command>');
    console.log('');
    console.log(color('Commands', colors.bold));
    const commands = [
        ['setup', 'Run the installer'],
        ['credentials import', 'Import local provider credentials'],
        ['update --check', 'Check for Discode updates'],
        ['update', 'Update from GitHub'],
        ['start', 'Start in the foreground'],
        ['start --background', 'Start in the background'],
        ['restart', 'Restart in the background'],
        ['status', 'Show runner status'],
        ['logs', 'Show recent logs'],
        ['version', 'Show version']
    ];

    for (const [name, description] of commands) {
        console.log(`  ${color(name.padEnd(22), colors.cyan)} ${description}`);
    }
}

try {
    await printUpdateNoticeIfNeeded();

    if (command === 'setup') {
        await setup();
    } else if (command === 'credentials' && args[0] === 'import') {
        await importCredentials();
    } else if (command === 'accounts' && args[0] === 'import') {
        await importCredentials();
    } else if (command === 'update') {
        if (args.includes('--check') || args.includes('-c')) {
            await checkUpdates();
        } else {
            await updateDiscode();
        }
    } else if (command === 'start') {
        if (args.includes('--background') || args.includes('-d')) {
            startBackground();
        } else {
            startForeground();
        }
    } else if (command === 'stop') {
        stop();
    } else if (command === 'restart') {
        banner('Restarting runner');
        stop();
        startBackground();
    } else if (command === 'status') {
        status();
    } else if (command === 'logs') {
        logs();
    } else if (command === 'version') {
        console.log(packageJson.version);
    } else if (command === 'help' || command === '--help' || command === '-h') {
        help();
    } else {
        throw new Error(`Unknown command: ${command}`);
    }
} catch (error) {
    fail(error?.message || String(error));
    process.exit(1);
}
