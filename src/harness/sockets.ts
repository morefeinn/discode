import net from 'node:net';

const maxSocketBytes = 12000;
const defaultTimeoutMs = 5000;

interface SocketEntry {
    id: string;
    socket: net.Socket;
    host: string;
    port: number;
}

export class SocketManager {
    private readonly sockets = new Map<string, SocketEntry>();
    private nextId = 1;

    async open(host: string, port: number, data = '', timeoutMs = defaultTimeoutMs): Promise<string> {
        const id = `socket-${this.nextId++}`;
        const socket = net.createConnection({ host, port });

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                socket.destroy();
                reject(new Error(`Timed out connecting to ${host}:${port}.`));
            }, timeoutMs);

            socket.once('connect', () => {
                clearTimeout(timeout);
                resolve();
            });
            socket.once('error', error => {
                clearTimeout(timeout);
                reject(error);
            });
        });
        this.sockets.set(id, { id, socket, host, port });

        if (!data) return `Opened ${id} to ${host}:${port}.`;

        return `${id}\n${await this.write(id, data, timeoutMs)}`;
    }

    async write(id: string, data: string, timeoutMs = defaultTimeoutMs): Promise<string> {
        const entry = this.sockets.get(id);

        if (!entry) return `Socket not found: ${id}`;
        entry.socket.write(data);

        return await this.readOnce(entry.socket, timeoutMs);
    }

    close(id: string): string {
        const entry = this.sockets.get(id);

        if (!entry) return `Socket not found: ${id}`;
        entry.socket.end();
        entry.socket.destroy();
        this.sockets.delete(id);

        return `Closed ${id}.`;
    }

    closeAll(): void {
        for (const id of [...this.sockets.keys()]) {
            this.close(id);
        }
    }

    private async readOnce(socket: net.Socket, timeoutMs: number): Promise<string> {
        return await new Promise(resolve => {
            let output = '';
            const finish = () => {
                cleanup();
                resolve(output.trim() || 'No data was received before timeout.');
            };
            const onData = (chunk: Buffer) => {
                output += chunk.toString('utf8');
                if (output.length >= maxSocketBytes) finish();
            };
            const onError = (error: Error) => {
                cleanup();
                resolve(`Socket error: ${error.message}`);
            };
            const cleanup = () => {
                clearTimeout(timeout);
                socket.off('data', onData);
                socket.off('error', onError);
                socket.off('end', finish);
            };
            const timeout = setTimeout(finish, timeoutMs);

            socket.on('data', onData);
            socket.once('error', onError);
            socket.once('end', finish);
        }).then(value => String(value).slice(-maxSocketBytes));
    }
}
