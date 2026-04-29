export function createInitPrompt(workspace: string): string {
    return [
        'Initialize this workspace for agent-driven development.',
        '',
        `Workspace: ${workspace}`,
        '',
        'Inspect the repository structure, package metadata, existing docs, and any local agent instruction files.',
        'Create or update AGENTS.md with concise, accurate instructions for future coding agents.',
        'Include project overview, key commands, code style, test/build workflow, important directories, and operational cautions.',
        'Preserve useful existing guidance if AGENTS.md already exists, and keep the final file practical instead of verbose.',
        'Run the relevant lightweight validation command after editing when the project provides one.'
    ].join('\n');
}
