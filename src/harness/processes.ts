import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';

const maxProcessBytes = 12000;

interface ProcessEntry {
    id: string;
    child: ChildProcessWithoutNullStreams;
    output: string;
    closed: boolean;
}

export class ProcessManager {
    private readonly processes = new Map<string, ProcessEntry>();
    private nextId = 1;

    start(command: string, cwd: string, env: Record<string, string>): string {
        const id = `process-${this.nextId++}`;
        const child = spawn('sh', ['-lc', command], {
            cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const entry: ProcessEntry = { id, child, output: '', closed: false };
        const append = (chunk: Buffer): void => {
            entry.output = `${entry.output}${chunk.toString('utf8')}`.slice(-maxProcessBytes);
        };

        child.stdout.on('data', append);
        child.stderr.on('data', append);
        child.on('close', code => {
            entry.closed = true;
            entry.output = `${entry.output}\n[process exited ${code ?? 1}]`.slice(-maxProcessBytes);
        });
        child.on('error', error => {
            entry.closed = true;
            entry.output = `${entry.output}\n[process error: ${error.message}]`.slice(-maxProcessBytes);
        });
        this.processes.set(id, entry);

        return `Started ${id}.`;
    }

    write(id: string, data: string): string {
        const entry = this.processes.get(id);

        if (!entry) return `Process not found: ${id}`;
        if (entry.closed) return `${id} is already closed.`;
        entry.child.stdin.write(data);

        return `Wrote to ${id}.`;
    }

    read(id: string): string {
        const entry = this.processes.get(id);

        if (!entry) return `Process not found: ${id}`;

        return entry.output.trim() || `${id} has no output yet.`;
    }

    stop(id: string): string {
        const entry = this.processes.get(id);

        if (!entry) return `Process not found: ${id}`;
        entry.child.kill('SIGTERM');
        this.processes.delete(id);

        return `Stopped ${id}.`;
    }

    stopAll(): void {
        for (const id of [...this.processes.keys()]) {
            this.stop(id);
        }
    }
}
