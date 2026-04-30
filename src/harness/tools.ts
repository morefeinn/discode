import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HarnessContext } from './types.js';
import { SocketManager } from './sockets.js';
import { ProcessManager } from './processes.js';

const execFileAsync = promisify(execFile);
const maxToolOutput = 12000;

export class HarnessTools {
    private readonly sockets = new SocketManager();
    private readonly processes = new ProcessManager();

    openAiTools(): any[] {
        return toolDefinitions().map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
            }
        }));
    }

    anthropicTools(): any[] {
        return toolDefinitions().map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters
        }));
    }

    async run(name: string, input: Record<string, unknown>, context: HarnessContext): Promise<string> {
        if (!context.toolsEnabled) return 'Local tools are disabled for this run.';

        if (name === 'execute_shell') return await this.executeShell(input, context);
        if (name === 'spawn_subagent') return await this.spawnSubagent(input, context);
        if (name === 'socket_open') return await this.openSocket(input, context);
        if (name === 'socket_write') return await this.writeSocket(input, context);
        if (name === 'socket_close') return this.closeSocket(input);
        if (name === 'process_start') return this.startProcess(input, context);
        if (name === 'process_write') return this.writeProcess(input, context);
        if (name === 'process_read') return this.readProcess(input);
        if (name === 'process_stop') return this.stopProcess(input);

        return `Unknown tool: ${name}`;
    }

    close(): void {
        this.sockets.closeAll();
        this.processes.stopAll();
    }

    private async executeShell(input: Record<string, unknown>, context: HarnessContext): Promise<string> {
        const command = stringValue(input.command).trim();

        if (!command) return 'No command was provided.';
        await context.onEvent?.({ label: 'Running native shell tool', text: command.slice(0, 110) });

        try {
            const result = await execFileAsync('sh', ['-lc', command], {
                cwd: context.workspace,
                timeout: 2 * 60 * 1000,
                maxBuffer: maxToolOutput
            });
            const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

            return output.slice(-maxToolOutput) || 'Command completed with no output.';
        } catch (error: any) {
            const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join('\n').trim();

            return `Command failed.\n${output.slice(-maxToolOutput)}`;
        }
    }

    private async spawnSubagent(input: Record<string, unknown>, context: HarnessContext): Promise<string> {
        const prompt = stringValue(input.prompt).trim();

        if (!prompt) return 'No subagent prompt was provided.';
        if (context.depth >= context.maxDepth) return 'Subagent recursion limit reached.';
        await context.onEvent?.({ label: 'Spawning native subagent', text: prompt.slice(0, 110) });
        const result = await context.runSubagent(prompt, {
            permissionMode: context.toolsEnabled ? 'full' : 'auto-review'
        });

        return result.ok ? result.text : `Subagent failed: ${result.error || result.text}`;
    }

    private async openSocket(input: Record<string, unknown>, context: HarnessContext): Promise<string> {
        const host = stringValue(input.host).trim();
        const port = Number(input.port);
        const data = stringValue(input.data);

        if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
            return 'Socket open requires host and port.';
        }
        await context.onEvent?.({ label: 'Opening native socket', text: `${host}:${port}` });

        return await this.sockets.open(host, port, data);
    }

    private async writeSocket(input: Record<string, unknown>, context: HarnessContext): Promise<string> {
        const id = stringValue(input.id).trim();
        const data = stringValue(input.data);

        if (!id) return 'Socket write requires an id.';
        await context.onEvent?.({ label: 'Writing native socket', text: id });

        return await this.sockets.write(id, data);
    }

    private closeSocket(input: Record<string, unknown>): string {
        const id = stringValue(input.id).trim();

        if (!id) return 'Socket close requires an id.';

        return this.sockets.close(id);
    }

    private startProcess(input: Record<string, unknown>, context: HarnessContext): string {
        const command = stringValue(input.command).trim();

        if (!command) return 'Process start requires a command.';
        void context.onEvent?.({ label: 'Starting native process', text: command.slice(0, 110) });

        return this.processes.start(command, context.workspace, context.env);
    }

    private writeProcess(input: Record<string, unknown>, context: HarnessContext): string {
        const id = stringValue(input.id).trim();
        const data = stringValue(input.data);

        if (!id) return 'Process write requires an id.';
        void context.onEvent?.({ label: 'Writing native process', text: id });

        return this.processes.write(id, data);
    }

    private readProcess(input: Record<string, unknown>): string {
        const id = stringValue(input.id).trim();

        if (!id) return 'Process read requires an id.';

        return this.processes.read(id);
    }

    private stopProcess(input: Record<string, unknown>): string {
        const id = stringValue(input.id).trim();

        if (!id) return 'Process stop requires an id.';

        return this.processes.stop(id);
    }
}

function toolDefinitions(): { name: string; description: string; parameters: any }[] {
    return [
        {
            name: 'execute_shell',
            description: 'Run a shell command on the machine hosting Discode, in the active workspace.',
            parameters: objectSchema({
                command: { type: 'string', description: 'The shell command to run.' }
            }, ['command'])
        },
        {
            name: 'spawn_subagent',
            description: 'Run a bounded recursive Discode native subagent for a focused subtask.',
            parameters: objectSchema({
                prompt: { type: 'string', description: 'The focused task for the subagent.' }
            }, ['prompt'])
        },
        {
            name: 'socket_open',
            description: 'Open a TCP socket from the host machine and optionally send initial data.',
            parameters: objectSchema({
                host: { type: 'string' },
                port: { type: 'integer' },
                data: { type: 'string' }
            }, ['host', 'port'])
        },
        {
            name: 'socket_write',
            description: 'Write data to an open native harness socket and read a response.',
            parameters: objectSchema({
                id: { type: 'string' },
                data: { type: 'string' }
            }, ['id', 'data'])
        },
        {
            name: 'socket_close',
            description: 'Close an open native harness socket.',
            parameters: objectSchema({
                id: { type: 'string' }
            }, ['id'])
        },
        {
            name: 'process_start',
            description: 'Start a persistent local process for dev servers, REPLs, or long-running commands.',
            parameters: objectSchema({
                command: { type: 'string' }
            }, ['command'])
        },
        {
            name: 'process_write',
            description: 'Write stdin data to a persistent native process.',
            parameters: objectSchema({
                id: { type: 'string' },
                data: { type: 'string' }
            }, ['id', 'data'])
        },
        {
            name: 'process_read',
            description: 'Read buffered stdout and stderr from a persistent native process.',
            parameters: objectSchema({
                id: { type: 'string' }
            }, ['id'])
        },
        {
            name: 'process_stop',
            description: 'Stop a persistent native process.',
            parameters: objectSchema({
                id: { type: 'string' }
            }, ['id'])
        }
    ];
}

function objectSchema(properties: Record<string, unknown>, required: string[]): any {
    return {
        type: 'object',
        properties,
        required,
        additionalProperties: false
    };
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}
