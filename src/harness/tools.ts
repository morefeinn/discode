import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
        if (name === 'list_directory') return await this.listDirectory(input, context);
        if (name === 'read_file') return await this.readFileTool(input, context);
        if (name === 'write_file') return await this.writeFileTool(input, context);
        if (name === 'edit_file') return await this.editFile(input, context);
        if (name === 'delete_file') return await this.deleteFile(input, context);
        if (name === 'grep') return await this.grep(input, context);
        if (name === 'apply_patch') return await this.applyPatch(input, context);
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

    private async listDirectory(input: Record<string, unknown>, context: HarnessContext): Promise<string> {
        const target = this.resolveWorkspacePath(input.path, context);

        if (!target) return 'Path is outside the active workspace.';
        await context.onEvent?.({ label: 'Listing files', text: this.relativePath(target, context) });

        try {
            const entries = await readdir(target, { withFileTypes: true });
            const lines = await Promise.all(entries
                .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
                .slice(0, 200)
                .map(async entry => {
                    const fullPath = path.join(target, entry.name);
                    const info = await stat(fullPath).catch(() => null);
                    const suffix = entry.isDirectory() ? '/' : '';

                    return `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}${suffix}${info ? ` ${info.size}b` : ''}`;
                }));

            return lines.join('\n') || 'Directory is empty.';
        } catch (error) {
            return `Could not list directory: ${errorMessage(error)}`;
        }
    }

    private async readFileTool(input: Record<string, unknown>, context: HarnessContext): Promise<string> {
        const target = this.resolveWorkspacePath(input.path, context);
        const startLine = Math.max(1, Number(input.start_line) || 1);
        const maxLines = Math.min(Math.max(1, Number(input.max_lines) || 240), 1000);

        if (!target) return 'Path is outside the active workspace.';
        await context.onEvent?.({ label: 'Reading file', text: this.relativePath(target, context) });

        try {
            const text = await readFile(target, 'utf8');
            const lines = text.split('\n');
            const selected = lines.slice(startLine - 1, startLine - 1 + maxLines)
                .map((line, index) => `${startLine + index}->${line}`);

            return selected.join('\n').slice(0, maxToolOutput) || 'File is empty.';
        } catch (error) {
            return `Could not read file: ${errorMessage(error)}`;
        }
    }

    private async writeFileTool(input: Record<string, unknown>, context: HarnessContext): Promise<string> {
        const target = this.resolveWorkspacePath(input.path, context);
        const content = stringValue(input.content);

        if (!target) return 'Path is outside the active workspace.';
        await context.onEvent?.({ label: 'Writing file', text: this.relativePath(target, context) });

        try {
            if (existsSync(target) && input.overwrite !== true) {
                return 'File already exists. Set overwrite=true to replace it, or use edit_file.';
            }
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, content);

            return `Wrote ${content.length} chars to ${this.relativePath(target, context)}.`;
        } catch (error) {
            return `Could not write file: ${errorMessage(error)}`;
        }
    }

    private async editFile(input: Record<string, unknown>, context: HarnessContext): Promise<string> {
        const target = this.resolveWorkspacePath(input.path, context);
        const oldString = stringValue(input.old_string);
        const newString = stringValue(input.new_string);
        const replaceAll = input.replace_all === true;

        if (!target) return 'Path is outside the active workspace.';
        if (!oldString) return 'edit_file requires old_string.';
        if (oldString === newString) return 'old_string and new_string must differ.';
        await context.onEvent?.({ label: 'Editing file', text: this.relativePath(target, context) });

        try {
            const text = await readFile(target, 'utf8');
            const count = countOccurrences(text, oldString);

            if (count === 0) return 'old_string was not found.';
            if (count > 1 && !replaceAll) return `old_string matched ${count} times. Set replace_all=true or provide more context.`;
            const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);

            await writeFile(target, next);

            return `Edited ${this.relativePath(target, context)} (${replaceAll ? count : 1} replacement${count === 1 ? '' : 's'}).`;
        } catch (error) {
            return `Could not edit file: ${errorMessage(error)}`;
        }
    }

    private async deleteFile(input: Record<string, unknown>, context: HarnessContext): Promise<string> {
        const target = this.resolveWorkspacePath(input.path, context);

        if (!target) return 'Path is outside the active workspace.';
        await context.onEvent?.({ label: 'Deleting file', text: this.relativePath(target, context) });

        try {
            await unlink(target);

            return `Deleted ${this.relativePath(target, context)}.`;
        } catch (error) {
            return `Could not delete file: ${errorMessage(error)}`;
        }
    }

    private async grep(input: Record<string, unknown>, context: HarnessContext): Promise<string> {
        const query = stringValue(input.query);
        const target = this.resolveWorkspacePath(input.path, context);
        const glob = stringValue(input.glob);
        const maxResults = Math.min(Math.max(1, Number(input.max_results) || 50), 200);

        if (!query) return 'grep requires query.';
        if (!target) return 'Path is outside the active workspace.';
        await context.onEvent?.({ label: 'Searching files', text: query.slice(0, 80) });

        try {
            const args = ['--line-number', '--hidden', '--glob', '!node_modules/**', '--glob', '!.git/**'];

            if (glob) args.push('--glob', glob);
            args.push(query, target);
            const result = await execFileAsync('rg', args, {
                cwd: context.workspace,
                timeout: 60 * 1000,
                maxBuffer: maxToolOutput
            }).catch((error: any) => {
                if (error?.code === 1) return { stdout: '', stderr: '' };
                throw error;
            });
            const lines = result.stdout.split('\n').filter(Boolean).slice(0, maxResults);

            return lines.join('\n').slice(0, maxToolOutput) || 'No matches.';
        } catch (error) {
            return `Search failed: ${errorMessage(error)}`;
        }
    }

    private async applyPatch(input: Record<string, unknown>, context: HarnessContext): Promise<string> {
        const patch = stringValue(input.patch);

        if (!patch.trim()) return 'apply_patch requires a unified diff patch.';
        await context.onEvent?.({ label: 'Applying patch' });
        const tempDir = await mkdtemp(path.join(os.tmpdir(), 'discode-patch-'));
        const patchPath = path.join(tempDir, 'changes.patch');

        try {
            await writeFile(patchPath, patch);
            const result = await execFileAsync('git', ['apply', '--whitespace=nowarn', patchPath], {
                cwd: context.workspace,
                timeout: 60 * 1000,
                maxBuffer: maxToolOutput
            });
            const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

            return output || 'Patch applied.';
        } catch (error: any) {
            const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join('\n').trim();

            return `Patch failed.\n${output.slice(-maxToolOutput)}`;
        } finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
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

    private resolveWorkspacePath(value: unknown, context: HarnessContext): string | null {
        const input = stringValue(value).trim() || '.';
        const resolved = path.resolve(context.workspace, input);
        const workspace = path.resolve(context.workspace);

        if (resolved === workspace || resolved.startsWith(`${workspace}${path.sep}`)) return resolved;

        return null;
    }

    private relativePath(value: string, context: HarnessContext): string {
        const relative = path.relative(context.workspace, value);

        return relative || '.';
    }
}

function toolDefinitions(): { name: string; description: string; parameters: any }[] {
    return [
        {
            name: 'execute_shell',
            description: 'Run a shell command on the machine hosting Discode, in the active workspace. Use this for verification and commands that are easier than dedicated tools.',
            parameters: objectSchema({
                command: { type: 'string', description: 'The shell command to run.' }
            }, ['command'])
        },
        {
            name: 'list_directory',
            description: 'List files and directories inside the active workspace.',
            parameters: objectSchema({
                path: { type: 'string', description: 'Workspace-relative path. Defaults to the workspace root.' }
            }, [])
        },
        {
            name: 'read_file',
            description: 'Read a UTF-8 text file from the active workspace with line numbers.',
            parameters: objectSchema({
                path: { type: 'string' },
                start_line: { type: 'integer' },
                max_lines: { type: 'integer' }
            }, ['path'])
        },
        {
            name: 'write_file',
            description: 'Create or overwrite a UTF-8 text file inside the active workspace.',
            parameters: objectSchema({
                path: { type: 'string' },
                content: { type: 'string' },
                overwrite: { type: 'boolean', description: 'Must be true to replace an existing file.' }
            }, ['path', 'content'])
        },
        {
            name: 'edit_file',
            description: 'Replace exact text in a UTF-8 file. Prefer this for small edits.',
            parameters: objectSchema({
                path: { type: 'string' },
                old_string: { type: 'string' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean' }
            }, ['path', 'old_string', 'new_string'])
        },
        {
            name: 'delete_file',
            description: 'Delete a file inside the active workspace.',
            parameters: objectSchema({
                path: { type: 'string' }
            }, ['path'])
        },
        {
            name: 'grep',
            description: 'Search workspace files with ripgrep and return matching file lines.',
            parameters: objectSchema({
                query: { type: 'string' },
                path: { type: 'string', description: 'Workspace-relative path. Defaults to root.' },
                glob: { type: 'string', description: 'Optional ripgrep glob, such as *.ts.' },
                max_results: { type: 'integer' }
            }, ['query'])
        },
        {
            name: 'apply_patch',
            description: 'Apply a unified diff patch to files in the active workspace using git apply.',
            parameters: objectSchema({
                patch: { type: 'string', description: 'Unified diff patch text.' }
            }, ['patch'])
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

function countOccurrences(value: string, search: string): number {
    return value.split(search).length - 1;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
