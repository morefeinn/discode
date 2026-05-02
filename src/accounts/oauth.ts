import { createHash, randomBytes } from 'node:crypto';
import { createServer, Server } from 'node:http';

export interface OAuthTokenSet {
    id_token?: string;
    access_token: string;
    refresh_token: string;
    expires_at?: string;
    account_id?: string;
    email?: string;
}

export interface AnthropicOAuthStart {
    url: string;
    verifier: string;
}

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_ISSUER = 'https://auth.openai.com';
const CODEX_PORTS = [1455, 1457];
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

type PendingCodexLogin = {
    pkce: PkceCodes;
    state: string;
    redirectUri: string;
    resolve: (tokens: OAuthTokenSet) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
};

type PkceCodes = {
    verifier: string;
    challenge: string;
};

let codexServer: Server | null = null;
let pendingCodexLogin: PendingCodexLogin | null = null;

export async function startCodexBrowserLogin(): Promise<{ url: string; callback: Promise<OAuthTokenSet> }> {
    const pkce = createPkce();
    const state = randomBase64Url(32);
    const { server, port } = await ensureCodexServer();
    codexServer = server;
    const redirectUri = `http://localhost:${port}/auth/callback`;
    const callback = new Promise<OAuthTokenSet>((resolve, reject) => {
        if (pendingCodexLogin) {
            clearTimeout(pendingCodexLogin.timeout);
            pendingCodexLogin.reject(new Error('A newer Codex login was started.'));
        }
        const timeout = setTimeout(() => {
            pendingCodexLogin = null;
            reject(new Error('Login timed out.'));
        }, 5 * 60 * 1000);

        pendingCodexLogin = { pkce, state, redirectUri, resolve, reject, timeout };
    });

    return {
        url: buildCodexAuthorizeUrl(redirectUri, pkce, state),
        callback
    };
}

export async function startCodexDeviceLogin(): Promise<{ url: string; code: string; callback: Promise<OAuthTokenSet> }> {
    const response = await fetch(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'user-agent': 'discode'
        },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID })
    });

    if (!response.ok) {
        throw new Error(`Codex device login failed with HTTP ${response.status}.`);
    }
    const data = await response.json() as { device_auth_id: string; user_code: string; interval?: string };
    const intervalMs = Math.max(Number(data.interval) || 5, 1) * 1000 + 3000;

    return {
        url: `${CODEX_ISSUER}/codex/device`,
        code: data.user_code,
        callback: pollCodexDeviceLogin(data.device_auth_id, data.user_code, intervalMs)
    };
}

export async function refreshCodexTokens(refreshToken: string): Promise<OAuthTokenSet> {
    const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CODEX_CLIENT_ID
        }).toString()
    });

    if (!response.ok) throw new Error(`Codex token refresh failed with HTTP ${response.status}.`);

    return normalizeCodexTokens(await response.json() as Record<string, unknown>);
}

export async function startAnthropicLogin(mode: 'max' | 'console'): Promise<AnthropicOAuthStart> {
    const pkce = createPkce();
    const host = mode === 'console' ? 'console.anthropic.com' : 'claude.ai';
    const url = new URL(`https://${host}/oauth/authorize`);

    url.searchParams.set('code', 'true');
    url.searchParams.set('client_id', ANTHROPIC_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', 'https://console.anthropic.com/oauth/code/callback');
    url.searchParams.set('scope', 'org:create_api_key user:profile user:inference');
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', pkce.verifier);

    return { url: url.toString(), verifier: pkce.verifier };
}

export async function exchangeAnthropicCode(code: string, verifier: string): Promise<OAuthTokenSet> {
    const { authorizationCode, state } = parseAnthropicCode(code);
    const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            code: authorizationCode,
            state,
            grant_type: 'authorization_code',
            client_id: ANTHROPIC_CLIENT_ID,
            redirect_uri: 'https://console.anthropic.com/oauth/code/callback',
            code_verifier: verifier
        })
    });

    if (!response.ok) throw new Error(`Anthropic token exchange failed with HTTP ${response.status}.`);

    return normalizeAnthropicTokens(await response.json() as Record<string, unknown>);
}

export async function refreshAnthropicTokens(refreshToken: string): Promise<OAuthTokenSet> {
    const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: ANTHROPIC_CLIENT_ID
        })
    });

    if (!response.ok) throw new Error(`Anthropic token refresh failed with HTTP ${response.status}.`);

    return normalizeAnthropicTokens(await response.json() as Record<string, unknown>);
}

export async function createAnthropicApiKey(tokens: OAuthTokenSet): Promise<string> {
    const response = await fetch('https://api.anthropic.com/api/oauth/claude_cli/create_api_key', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tokens.access_token}`
        }
    });

    if (!response.ok) throw new Error(`Anthropic API key creation failed with HTTP ${response.status}.`);
    const payload = await response.json() as { raw_key?: string };

    if (!payload.raw_key) throw new Error('Anthropic did not return an API key.');

    return payload.raw_key;
}

export function tokenClaims(token: string | undefined): Record<string, unknown> {
    if (!token) return {};
    const parts = token.split('.');

    if (parts.length !== 3) return {};
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>;
    } catch {
        return {};
    }
}

function ensureCodexServer(): Promise<{ server: Server; port: number }> {
    if (codexServer?.listening) {
        const address = codexServer.address();
        const port = typeof address === 'object' && address ? address.port : CODEX_PORTS[0];

        return Promise.resolve({ server: codexServer, port });
    }

    return bindCodexServer([...CODEX_PORTS]);
}

function bindCodexServer(ports: number[]): Promise<{ server: Server; port: number }> {
    const [port, ...rest] = ports;
    const server = createServer((request, response) => {
        void handleCodexCallback(request.url || '/', response);
    });

    return new Promise((resolve, reject) => {
        server.once('error', error => {
            if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && rest.length > 0) {
                resolve(bindCodexServer(rest));
                return;
            }
            reject(error);
        });
        server.listen(port, '127.0.0.1', () => resolve({ server, port }));
    });
}

async function handleCodexCallback(rawUrl: string, response: import('node:http').ServerResponse): Promise<void> {
    const pending = pendingCodexLogin;
    const url = new URL(rawUrl, 'http://localhost');

    if (url.pathname === '/cancel') {
        pendingCodexLogin = null;
        pending?.reject(new Error('Login cancelled.'));
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('Login cancelled.');
        return;
    }

    if (url.pathname !== '/auth/callback') {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('Not found.');
        return;
    }

    if (!pending) {
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('No pending Discode login.');
        return;
    }

    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const error = url.searchParams.get('error_description') || url.searchParams.get('error') || '';

    if (error || !code || state !== pending.state) {
        pendingCodexLogin = null;
        clearTimeout(pending.timeout);
        pending.reject(new Error(error || 'Invalid OAuth callback.'));
        response.writeHead(400, { 'content-type': 'text/html' });
        response.end('<h1>Discode Codex login failed</h1><p>You can close this window.</p>');
        return;
    }

    try {
        const tokens = await exchangeCodexCode(code, pending.redirectUri, pending.pkce);

        pendingCodexLogin = null;
        clearTimeout(pending.timeout);
        pending.resolve(tokens);
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<h1>Discode Codex login complete</h1><p>You can close this window and return to Discord.</p>');
    } catch (exchangeError) {
        pendingCodexLogin = null;
        clearTimeout(pending.timeout);
        pending.reject(exchangeError instanceof Error ? exchangeError : new Error(String(exchangeError)));
        response.writeHead(500, { 'content-type': 'text/html' });
        response.end('<h1>Discode Codex login failed</h1><p>You can close this window.</p>');
    }
}

async function exchangeCodexCode(code: string, redirectUri: string, pkce: PkceCodes): Promise<OAuthTokenSet> {
    const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: CODEX_CLIENT_ID,
            code_verifier: pkce.verifier
        }).toString()
    });

    if (!response.ok) throw new Error(`Codex token exchange failed with HTTP ${response.status}.`);

    return normalizeCodexTokens(await response.json() as Record<string, unknown>);
}

async function pollCodexDeviceLogin(deviceAuthId: string, userCode: string, intervalMs: number): Promise<OAuthTokenSet> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 10 * 60 * 1000) {
        const response = await fetch(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'user-agent': 'discode'
            },
            body: JSON.stringify({
                device_auth_id: deviceAuthId,
                user_code: userCode
            })
        });

        if (response.ok) {
            const data = await response.json() as { authorization_code: string; code_verifier: string };
            return exchangeCodexCode(data.authorization_code, `${CODEX_ISSUER}/deviceauth/callback`, {
                verifier: data.code_verifier,
                challenge: ''
            });
        }
        if (response.status !== 403 && response.status !== 404) {
            throw new Error(`Codex device login failed with HTTP ${response.status}.`);
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error('Codex device login timed out.');
}

function normalizeCodexTokens(payload: Record<string, unknown>): OAuthTokenSet {
    const idToken = stringValue(payload.id_token);
    const accessToken = stringValue(payload.access_token);
    const refreshToken = stringValue(payload.refresh_token);
    const claims = tokenClaims(idToken || accessToken);
    const authClaims = objectValue(claims['https://api.openai.com/auth']);
    const accountId = stringValue(authClaims.chatgpt_account_id)
        || stringValue(claims.chatgpt_account_id)
        || stringValue(payload.account_id)
        || stringValue(payload.accountId);

    if (!accessToken || !refreshToken) throw new Error('Codex login did not return usable tokens.');

    return {
        id_token: idToken || undefined,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: new Date(Date.now() + (numberValue(payload.expires_in) || 3600) * 1000).toISOString(),
        account_id: accountId || undefined,
        email: stringValue(claims.email) || undefined
    };
}

function parseAnthropicCode(input: string): { authorizationCode: string; state: string } {
    const value = input.trim();

    try {
        const url = new URL(value);
        const code = url.searchParams.get('code') || '';
        const state = url.hash.replace(/^#/, '') || url.searchParams.get('state') || '';

        if (code) return { authorizationCode: code, state };
    } catch {}

    const [authorizationCode, state = ''] = value.split('#');

    return { authorizationCode, state };
}

function normalizeAnthropicTokens(payload: Record<string, unknown>): OAuthTokenSet {
    const accessToken = stringValue(payload.access_token);
    const refreshToken = stringValue(payload.refresh_token);

    if (!accessToken || !refreshToken) throw new Error('Anthropic login did not return usable tokens.');

    return {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: new Date(Date.now() + (numberValue(payload.expires_in) || 3600) * 1000).toISOString()
    };
}

function buildCodexAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: CODEX_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        state,
        originator: 'codex_cli_rs'
    });

    return `${CODEX_ISSUER}/oauth/authorize?${params.toString()}`;
}

function createPkce(): PkceCodes {
    const verifier = randomBase64Url(32);
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    return { verifier, challenge };
}

function randomBase64Url(byteLength: number): string {
    return randomBytes(byteLength).toString('base64url');
}

function objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | null {
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;

    return Number.isFinite(number) ? number : null;
}
