import { spawn } from 'node:child_process';
import { AttachmentBuilder, ChatInputCommandInteraction, ModalSubmitInteraction } from 'discord.js';
import { renderTerminalOutputCard } from './terminalOutputCard.js';

export async function runTerminalCommand(
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    command: string,
    workspace: string,
    timeoutMs: number,
    ephemeral = true
): Promise<void> {
    await interaction.deferReply(ephemeral ? { flags: 64 as const } : {});

    let output = '';
    let lastUpdate = 0;
    let finished = false;
    let exitStatus = 'Starting';

    const edit = async (force = false) => {
        const now = Date.now();

        if (!force && now - lastUpdate < 900) return;
        lastUpdate = now;
        const image = await renderTerminalOutputCard({
            command,
            workspace,
            output,
            status: exitStatus,
            finished
        });

        await interaction.editReply({
            content: '',
            embeds: [],
            attachments: [],
            files: [new AttachmentBuilder(image, { name: 'terminal-output.png' })]
        }).catch(() => undefined);
    };
    const append = (chunk: unknown) => {
        output += stripUnsafeAnsi(String(chunk));
        void edit();
    };
    const child = spawn(command, {
        cwd: workspace,
        shell: true,
        env: {
            ...process.env,
            FORCE_COLOR: '1',
            TERM: 'xterm-256color'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const timeout = setTimeout(() => {
        if (finished) return;
        exitStatus = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
        output += `\n${exitStatus}\n`;
        child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => {
        exitStatus = 'Failed to start';
        output += `\n${String(error)}\n`;
    });
    child.on('close', code => {
        finished = true;
        clearTimeout(timeout);
        exitStatus = `Exited with status ${code ?? 1}`;
        output += `\n${exitStatus}\n`;
        void edit(true);
    });

    await edit(true);
}

function stripUnsafeAnsi(text: string): string {
    return text
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
        .replace(/[^\S\r\n]+$/gm, '');
}
