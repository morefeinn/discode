import { afterEach, beforeEach, expect, test } from 'bun:test';
import net from 'node:net';
import { runNativeHarness } from '../src/harness/native.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
    delete process.env.OPENAI_BASE_URL;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

test('native harness returns direct OpenAI-compatible responses', async () => {
    const calls: any[] = [];

    globalThis.fetch = async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));

        return jsonResponse({
            choices: [{ message: { role: 'assistant', content: 'native-ok' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        });
    };

    const result = await runNativeHarness(accounts(), {
        prompt: 'hello',
        model: 'gpt-test',
        permissionMode: 'auto-review'
    }, process.cwd());

    expect(result.ok).toBe(true);
    expect(result.text).toBe('native-ok');
    expect(result.usage?.totalTokens).toBe(5);
    expect(calls[0].tools).toBeUndefined();
});

test('native harness executes shell tool and feeds result back to provider', async () => {
    const calls: any[] = [];

    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);

        if (calls.length === 1) {
            return jsonResponse({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: '',
                        tool_calls: [{
                            id: 'tool-1',
                            type: 'function',
                            function: {
                                name: 'execute_shell',
                                arguments: JSON.stringify({ command: 'printf harness-shell-ok' })
                            }
                        }]
                    }
                }]
            });
        }

        expect(JSON.stringify(body.messages)).toContain('harness-shell-ok');

        return jsonResponse({
            choices: [{ message: { role: 'assistant', content: 'shell-finished' } }]
        });
    };

    const result = await runNativeHarness(accounts(), {
        prompt: 'run a command',
        model: 'gpt-test',
        permissionMode: 'full'
    }, process.cwd());

    expect(result.ok).toBe(true);
    expect(result.text).toBe('shell-finished');
    expect(calls[0].tools.map((tool: any) => tool.function.name)).toContain('execute_shell');
});

test('native harness supports recursive subagents', async () => {
    const responses = [
        toolResponse('tool-parent', 'spawn_subagent', { prompt: 'child task' }),
        finalResponse('child answer'),
        finalResponse('parent saw child')
    ];

    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));

        if (responses.length === 1) {
            expect(JSON.stringify(body.messages)).toContain('child answer');
        }

        return responses.shift() || finalResponse('unexpected');
    };

    const result = await runNativeHarness(accounts(), {
        prompt: 'delegate',
        model: 'gpt-test',
        permissionMode: 'full'
    }, process.cwd());

    expect(result.ok).toBe(true);
    expect(result.text).toBe('parent saw child');
});

test('native harness can open TCP sockets', async () => {
    const server = net.createServer(socket => {
        socket.once('data', data => {
            socket.end(`echo:${data.toString('utf8').trim()}`);
        });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const calls: any[] = [];

    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);

        if (calls.length === 1) {
            return toolResponse('socket-1', 'socket_open', { host: '127.0.0.1', port, data: 'ping\n' });
        }

        expect(JSON.stringify(body.messages)).toContain('echo:ping');

        return finalResponse('socket-finished');
    };

    try {
        const result = await runNativeHarness(accounts(), {
            prompt: 'open socket',
            model: 'gpt-test',
            permissionMode: 'full'
        }, process.cwd());

        expect(result.ok).toBe(true);
        expect(result.text).toBe('socket-finished');
    } finally {
        server.close();
    }
});

test('native harness can manage persistent local processes', async () => {
    const calls: any[] = [];

    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);

        if (calls.length === 1) {
            return toolResponse('process-start', 'process_start', { command: 'node -e "console.log(\\\"ready\\\"); setInterval(() => {}, 1000)"' });
        }
        if (calls.length === 2) {
            expect(JSON.stringify(body.messages)).toContain('Started process-1');

            return toolResponse('process-read', 'process_read', { id: 'process-1' });
        }
        if (calls.length === 3) {
            expect(JSON.stringify(body.messages)).toContain('ready');

            return toolResponse('process-stop', 'process_stop', { id: 'process-1' });
        }

        expect(JSON.stringify(body.messages)).toContain('Stopped process-1');

        return finalResponse('process-finished');
    };

    const result = await runNativeHarness(accounts(), {
        prompt: 'start process',
        model: 'gpt-test',
        permissionMode: 'full'
    }, process.cwd());

    expect(result.ok).toBe(true);
    expect(result.text).toBe('process-finished');
});

function accounts(): any {
    return {
        async getActiveAccount() {
            return { provider: 'codex' };
        },
        async getActiveEnvironment() {
            return { OPENAI_API_KEY: 'test-key' };
        }
    };
}

function finalResponse(content: string): Response {
    return jsonResponse({
        choices: [{ message: { role: 'assistant', content } }]
    });
}

function toolResponse(id: string, name: string, input: Record<string, unknown>): Response {
    return jsonResponse({
        choices: [{
            message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id,
                    type: 'function',
                    function: {
                        name,
                        arguments: JSON.stringify(input)
                    }
                }]
            }
        }]
    });
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}
