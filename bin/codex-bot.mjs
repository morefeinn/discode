#!/usr/bin/env bun

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');
const dataDir = path.join(rootDir, 'data');
const pidPath = path.join(dataDir, 'codex-bot.pid');
const logPath = path.join(dataDir, 'codex-bot.log');
const runtimeEnv = getRuntimeEnv();
const accountsPath = runtimeEnv.DISCODE_ACCOUNTS_PATH || path.join(dataDir, 'accounts.json');
const legacySwitcherPath = runtimeEnv.CODEX_SWITCHER_IMPORT_PATH || runtimeEnv.CODEX_SWITCHER_PATH || path.join(os.homedir(), '.codex-switcher', 'accounts.json');
const codexAuthPath = runtimeEnv.CODEX_AUTH_PATH || path.join(os.homedir(), '.codex', 'auth.json');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

const command = process.argv[2] || 'help';
const args = process.argv.slice(3);

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
        ...process.env,
        ...loadEnvFile()
    };
}

function commandExists(name) {
    return spawnSync('sh', ['-lc', `command -v ${JSON.stringify(name)}`], { encoding: 'utf8' }).status === 0;
}

function installCommand(name) {
    if (name === 'bun') return 'curl -fsSL https://bun.sh/install | bash';
    if (name === 'git') return 'brew install git';
    if (name === 'codex') return 'bun add -g @openai/codex';
    if (name === 'opencode') return 'bun add -g opencode-ai';

    return '';
}

async function checkDependencies(rl, headless) {
    const required = ['bun'];
    const recommended = ['git', 'codex'];
    const missingRequired = required.filter(name => !commandExists(name));
    const missingRecommended = recommended.filter(name => !commandExists(name));

    if (missingRequired.length === 0 && missingRecommended.length === 0) return;
    console.log('Dependency check');

    for (const name of missingRequired) {
        console.log(`Missing required dependency: ${name}`);
    }

    for (const name of missingRecommended) {
        console.log(`Missing optional dependency: ${name}`);
    }

    const shouldInstall = headless
        ? hasFlag('install-deps')
        : ['y', 'yes'].includes((await rl.question('Install missing dependencies now? [y/N]: ')).trim().toLowerCase());

    if (!shouldInstall) {
        if (missingRequired.length > 0) throw new Error(`Install required dependencies first: ${missingRequired.join(', ')}`);
        return;
    }

    for (const name of [...missingRequired, ...missingRecommended]) {
        const command = installCommand(name);

        if (!command) continue;
        console.log(`Installing ${name}`);
        const result = spawnSync('sh', ['-lc', command], { stdio: 'inherit' });

        if (result.status !== 0 && missingRequired.includes(name)) {
            throw new Error(`Failed to install ${name}.`);
        }
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
        const answer = (await rl.question(`${label}${currentLabel}: `)).trim();
        const value = answer || current || fallback || '';

        if (!required || value) return value;
        console.log('Required.');
    }
}

async function promptBoolean(rl, label, current, fallback) {
    const normalized = String(current || fallback || '').toLowerCase();
    const defaultValue = ['1', 'true', 'yes', 'on', 'y'].includes(normalized);
    const answer = (await rl.question(`${label} [${defaultValue ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();

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

async function setupBoolean(rl, options) {
    const cliValue = flagValue(options.flag);

    if (options.headless) {
        return cliValue || options.current || options.fallback || 'false';
    }

    return promptBoolean(rl, options.label, cliValue || options.current, options.fallback);
}

function createPrompter() {
    if (process.stdin.isTTY) {
        return readline.createInterface({ input: process.stdin, output: process.stdout });
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
        console.log('Discode installer');
        await checkDependencies(rl, headless);
        console.log('Required');
        const values = {
            DISCORD_TOKEN: await setupValue(rl, { label: 'Discord bot token', flag: 'token', current: existing.DISCORD_TOKEN, required: true, headless }),
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
            : ((await rl.question('Setup mode simple/technical [simple]: ')).trim().toLowerCase() || 'simple');
        const technical = mode === 'technical';
        const configureRuntime = headless
            ? hasFlag('runtime')
            : technical || ['y', 'yes'].includes((await rl.question('Configure runtime options now? [y/N]: ')).trim().toLowerCase());

        values.DISCODE_COMMAND_NAME = flagValue('command-name') || existing.DISCODE_COMMAND_NAME || '';
        values.DEFAULT_WORKSPACE = flagValue('workspace') || existing.DEFAULT_WORKSPACE || '';
        values.DEFAULT_SANDBOX = flagValue('sandbox') || existing.DEFAULT_SANDBOX || 'workspace-write';
        values.DEFAULT_MODEL = flagValue('model') || existing.DEFAULT_MODEL || '';
        values.DISCODE_MODEL_CHOICES = flagValue('models') || existing.DISCODE_MODEL_CHOICES || '';
        values.DISCODE_PROVIDER = flagValue('provider') || existing.DISCODE_PROVIDER || 'codex';
        values.DISCODE_PROVIDER_PRIORITY = flagValue('provider-priority') || existing.DISCODE_PROVIDER_PRIORITY || 'codex,opencode,anthropic,zai,qwen,custom';
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
        values.CODEX_SWITCHER_IMPORT_PATH = flagValue('switcher-import-path') || existing.CODEX_SWITCHER_IMPORT_PATH || '';
        values.CODEX_AUTH_PATH = flagValue('codex-auth-path') || existing.CODEX_AUTH_PATH || '';
        values.DISCODE_EXTENSION_ROBLOX_API_KEY = flagValue('roblox-api-key') || existing.DISCODE_EXTENSION_ROBLOX_API_KEY || '';
        values.DISCODE_EXTENSION_ROBLOX_UNIVERSE_ID = flagValue('roblox-universe-id') || existing.DISCODE_EXTENSION_ROBLOX_UNIVERSE_ID || '';
        values.DISCODE_EXTENSION_ROBLOX_PLACE_ID = flagValue('roblox-place-id') || existing.DISCODE_EXTENSION_ROBLOX_PLACE_ID || '';

        if (configureRuntime) {
            console.log('Optional runtime');
            values.DISCODE_COMMAND_NAME = await setupValue(rl, { label: 'Slash command name override', flag: 'command-name', current: existing.DISCODE_COMMAND_NAME, headless });
            values.DEFAULT_WORKSPACE = await setupValue(rl, { label: 'Default workspace', flag: 'workspace', current: existing.DEFAULT_WORKSPACE, fallback: process.cwd(), headless });
            values.DEFAULT_MODEL = await setupValue(rl, { label: 'Default model', flag: 'model', current: existing.DEFAULT_MODEL, headless });
            values.DISCODE_MODEL_CHOICES = await setupValue(rl, { label: 'Model choices, comma separated', flag: 'models', current: existing.DISCODE_MODEL_CHOICES, headless });
            values.DISCODE_PROVIDER = await setupValue(rl, { label: 'Provider codex/opencode/anthropic/zai/qwen/custom', flag: 'provider', current: existing.DISCODE_PROVIDER, fallback: 'codex', headless });
            values.DISCODE_PROVIDER_PRIORITY = await setupValue(rl, { label: 'Fallback provider priority', flag: 'provider-priority', current: existing.DISCODE_PROVIDER_PRIORITY, fallback: 'codex,opencode,anthropic,zai,qwen,custom', headless });
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
            values.CODEX_SWITCHER_IMPORT_PATH = await setupValue(rl, { label: 'Codex switcher import path', flag: 'switcher-import-path', current: existing.CODEX_SWITCHER_IMPORT_PATH, headless });
            values.CODEX_AUTH_PATH = await setupValue(rl, { label: 'Codex auth output path', flag: 'codex-auth-path', current: existing.CODEX_AUTH_PATH, headless });
        }
        const configureRoblox = headless
            ? hasFlag('roblox')
            : technical
                ? (await rl.question('Configure optional Roblox extension? [y/N]: ')).trim().toLowerCase()
                : 'n';

        if (['y', 'yes'].includes(configureRoblox)) {
            values.DISCODE_EXTENSION_ROBLOX_API_KEY = await promptValue(rl, 'Roblox Open Cloud API key', existing.DISCODE_EXTENSION_ROBLOX_API_KEY, '', false);
            values.DISCODE_EXTENSION_ROBLOX_UNIVERSE_ID = await promptValue(rl, 'Roblox universe id', existing.DISCODE_EXTENSION_ROBLOX_UNIVERSE_ID, '', false);
            values.DISCODE_EXTENSION_ROBLOX_PLACE_ID = await promptValue(rl, 'Roblox place id', existing.DISCODE_EXTENSION_ROBLOX_PLACE_ID, '', false);
        }

        writeEnvValues(values);
        ensureDataDir();
        console.log('Wrote .env');
        console.log('Run codex-bot start to launch Discode.');
    } finally {
        rl.close();
    }
}

function startForeground() {
    stopExistingInstances();
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
    console.log(`codex-bot started in the background (pid ${child.pid}).`);
    console.log(`logs: ${logPath}`);
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
        console.log(`stopped existing codex-bot pid ${pid}.`);
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
            console.log(`stopped existing codex-bot pid ${foundPid}.`);
        } catch {
        }
    }
}

function status() {
    const pid = readPid();

    if (isProcessRunning(pid)) {
        console.log(`codex-bot is running (pid ${pid}).`);
        console.log(`logs: ${logPath}`);
        return;
    }
    console.log('codex-bot is stopped.');
}

function logs() {
    if (!fs.existsSync(logPath)) {
        console.log('No log file exists yet.');
        return;
    }
    const text = fs.readFileSync(logPath, 'utf8');
    const lines = text.split('\n').slice(-80).join('\n');
    console.log(lines);
}

function resolveRuntime() {
    const bun = spawnSync('sh', ['-lc', 'command -v bun'], { encoding: 'utf8' }).stdout.trim();

    if (bun) return bun;

    console.error('bun is required to run codex-bot.');
    process.exit(1);
}

function readAccountState() {
    if (fs.existsSync(accountsPath)) {
        return normalizeAccountState(JSON.parse(fs.readFileSync(accountsPath, 'utf8')));
    }

    if (fs.existsSync(legacySwitcherPath)) {
        const imported = importLegacySwitcher(JSON.parse(fs.readFileSync(legacySwitcherPath, 'utf8')));
        writeAccountState(imported);
        return imported;
    }

    return { version: 1, accounts: [] };
}

function writeAccountState(state) {
    fs.mkdirSync(path.dirname(accountsPath), { recursive: true });
    fs.writeFileSync(accountsPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function importLegacySwitcher(state) {
    return normalizeAccountState({
        version: 1,
        active_account_id: state.active_account_id,
        accounts: (state.accounts || []).map((account, index) => ({
            id: account.id || `codex-${index + 1}`,
            name: accountName(account, index),
            provider: 'codex',
            email: account.email,
            plan_type: account.plan_type,
            subscription_expires_at: account.subscription_expires_at,
            auth_mode: account.auth_mode || String(account.auth_data?.type || 'session'),
            auth_data: account.auth_data,
            last_used_at: account.last_used_at
        }))
    });
}

function normalizeAccountState(state) {
    return {
        version: state.version || 1,
        active_account_id: state.active_account_id,
        accounts: (state.accounts || []).map((account, index) => ({
            ...account,
            id: account.id || `account-${index + 1}`,
            name: accountName(account, index),
            provider: normalizeProvider(account.provider)
        }))
    };
}

function normalizeProvider(provider) {
    return provider === 'opencode' || provider === 'custom' ? provider : 'codex';
}

function accountName(account, index) {
    if (!account.name || account.name.includes('@')) return `Account ${index + 1}`;

    return account.name;
}

function accounts() {
    const state = readAccountState();

    if (state.accounts.length === 0) {
        console.log('No Discode accounts found.');
        console.log(`Create ${accountsPath} or set DISCODE_ACCOUNTS_PATH.`);
        return;
    }

    for (const [index, account] of state.accounts.entries()) {
        const marker = account.id === state.active_account_id ? '*' : '-';
        console.log(`${marker} ${index + 1}. ${accountName(account, index)} ${normalizeProvider(account.provider)} ${account.plan_type || account.auth_mode || 'unknown'}`);
    }
}

function findAccount(state, query) {
    const normalized = query.trim().toLowerCase();
    const index = Number(normalized);

    if (Number.isInteger(index) && index >= 1 && index <= state.accounts.length) {
        return state.accounts[index - 1];
    }

    if (normalized === 'next') {
        const activeIndex = state.accounts.findIndex(account => account.id === state.active_account_id);
        return state.accounts[activeIndex < 0 ? 0 : (activeIndex + 1) % state.accounts.length];
    }

    return state.accounts.find(account =>
        account.id.toLowerCase().startsWith(normalized)
        || account.name.toLowerCase() === normalized
        || account.name.toLowerCase().includes(normalized)
        || account.email?.toLowerCase() === normalized
    );
}

function switchAccount(query) {
    if (!query) {
        console.error('Usage: codex-bot switch <index|name|id|next>');
        process.exit(1);
    }
    const state = readAccountState();
    const account = findAccount(state, query);

    if (!account) {
        console.error(`No account matched "${query}".`);
        process.exit(1);
    }

    account.last_used_at = new Date().toISOString();
    state.active_account_id = account.id;
    writeAccountState(state);

    if (normalizeProvider(account.provider) === 'codex' && account.auth_data?.access_token && account.auth_data?.account_id) {
        const tokens = { ...account.auth_data };
        delete tokens.type;
        fs.mkdirSync(path.dirname(codexAuthPath), { recursive: true });
        fs.writeFileSync(codexAuthPath, `${JSON.stringify({
            tokens,
            last_refresh: new Date().toISOString()
        }, null, 2)}\n`, { mode: 0o600 });
    }
    console.log(`Switched Discode to ${accountName(account, 0)}.`);
}

function help() {
    console.log(`codex-bot ${packageJson.version}
  codex-bot setup              Run the Discode installer
  codex-bot setup --headless   Write .env from flags or environment
  codex-bot version            Show version
  codex-bot start              Start in the foreground
  codex-bot start --background Start in the background
  codex-bot stop               Stop background bot
  codex-bot restart            Restart in the background
  codex-bot status             Show background status
  codex-bot logs               Show recent background logs
  codex-bot accounts           List Discode accounts
  codex-bot switch <account>   Switch account by index, id, name, or next`);
}

try {
    if (command === 'setup') {
        await setup();
    } else if (command === 'start') {
        if (args.includes('--background') || args.includes('-d')) {
            startBackground();
        } else {
            startForeground();
        }
    } else if (command === 'stop') {
        stop();
    } else if (command === 'restart') {
        stop();
        startBackground();
    } else if (command === 'status') {
        status();
    } else if (command === 'logs') {
        logs();
    } else if (command === 'version') {
        console.log(packageJson.version);
    } else if (command === 'accounts') {
        accounts();
    } else if (command === 'switch') {
        switchAccount(args.join(' '));
    } else {
        help();
    }
} catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
}
