import readline from 'node:readline';

function promptList(question, options) {
    return new Promise((resolve) => {
        if (!process.stdin.isTTY) {
            resolve(options[0].value);
            return;
        }

        let selected = 0;
        
        process.stdout.write(`\x1b[36m? \x1b[1m${question}\x1b[0m\n`);
        
        const render = () => {
            for (let i = 0; i < options.length; i++) {
                const prefix = i === selected ? '\x1b[36m❯\x1b[0m' : ' ';
                const color = i === selected ? '\x1b[36m' : '';
                process.stdout.write(`${prefix} ${color}${options[i].label}\x1b[0m\n`);
            }
        };
        
        const cleanup = () => {
            process.stdout.write(`\x1b[${options.length}A`);
            for (let i = 0; i < options.length; i++) {
                process.stdout.write('\x1b[2K\n');
            }
            process.stdout.write(`\x1b[${options.length}A`);
        };
        
        render();
        
        const onKeypress = (str, key) => {
            if (key.name === 'up') {
                selected = Math.max(0, selected - 1);
                cleanup();
                render();
            } else if (key.name === 'down') {
                selected = Math.min(options.length - 1, selected + 1);
                cleanup();
                render();
            } else if (key.name === 'return' || key.name === 'enter') {
                process.stdin.removeListener('keypress', onKeypress);
                if (process.stdin.isTTY) process.stdin.setRawMode(false);
                process.stdin.pause();
                cleanup();
                process.stdout.write(`\x1b[1A\x1b[2K\x1b[36m✔ \x1b[1m${question}\x1b[0m \x1b[2m›\x1b[0m ${options[selected].label}\n`);
                resolve(options[selected].value);
            } else if (key.ctrl && key.name === 'c') {
                process.exit(1);
            }
        };
        
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('keypress', onKeypress);
    });
}

async function main() {
    const res = await promptList("Which provider?", [
        { label: "Codex", value: "codex" },
        { label: "Anthropic", value: "anthropic" },
        { label: "Z.ai", value: "zai" }
    ]);
    console.log("Selected:", res);
}

main();
