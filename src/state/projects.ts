import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataFile, defaultWorkspacePath, slugName } from './paths.js';

export interface ProjectRecord {
    name: string;
    workspace: string;
    model?: string | null;
    sandbox?: string | null;
    updatedAt: string;
}

interface ProjectFile {
    activeProjectName?: string | null;
    projects: Record<string, ProjectRecord>;
}

const dataPath = dataFile('projects.json');

async function readStore(): Promise<ProjectFile> {
    try {
        return JSON.parse(await readFile(dataPath, 'utf8')) as ProjectFile;
    } catch {
        return { activeProjectName: null, projects: {} };
    }
}

async function writeStore(store: ProjectFile): Promise<void> {
    await mkdir(path.dirname(dataPath), { recursive: true });
    await writeFile(dataPath, JSON.stringify(store, null, 2) + '\n');
}

function normalizeName(name: string): string {
    return name.trim().toLowerCase();
}

export async function saveProject(project: Omit<ProjectRecord, 'updatedAt'>): Promise<ProjectRecord> {
    const store = await readStore();
    const record: ProjectRecord = {
        ...project,
        name: project.name.trim(),
        updatedAt: new Date().toISOString()
    };
    store.projects[normalizeName(record.name)] = record;
    store.activeProjectName = normalizeName(record.name);
    await writeStore(store);

    return record;
}

export async function listProjects(): Promise<{ activeProjectName?: string | null; projects: ProjectRecord[] }> {
    const store = await ensureDefaultProject(await readStore());

    return {
        activeProjectName: store.activeProjectName,
        projects: Object.values(store.projects).sort((a, b) => a.name.localeCompare(b.name))
    };
}

export async function getActiveProject(): Promise<ProjectRecord | null> {
    const store = await ensureDefaultProject(await readStore());

    if (!store.activeProjectName) return null;

    return store.projects[store.activeProjectName] || null;
}

export async function findProject(query: string): Promise<ProjectRecord | null> {
    const normalized = normalizeName(query);
    const store = await ensureDefaultProject(await readStore());
    const projects = Object.values(store.projects);
    const index = Number(normalized);

    if (Number.isInteger(index) && index >= 1 && index <= projects.length) {
        return projects.sort((a, b) => a.name.localeCompare(b.name))[index - 1];
    }

    return store.projects[normalized]
        || projects.find(project => project.name.toLowerCase().includes(normalized))
        || null;
}

export async function setActiveProject(query: string): Promise<ProjectRecord> {
    const store = await ensureDefaultProject(await readStore());
    const project = await findProject(query);

    if (!project) throw new Error(`No project matched "${query}".`);
    store.activeProjectName = normalizeName(project.name);
    await writeStore(store);

    return project;
}

export async function createManagedProject(name: string, model?: string | null): Promise<ProjectRecord> {
    const cleanName = name.trim() || 'Default';
    const workspace = defaultWorkspacePath(slugName(cleanName));

    await mkdir(workspace, { recursive: true });

    return saveProject({
        name: cleanName,
        workspace,
        model
    });
}

async function ensureDefaultProject(store: ProjectFile): Promise<ProjectFile> {
    if (Object.keys(store.projects || {}).length > 0) return store;
    const workspace = defaultWorkspacePath('default');
    const record: ProjectRecord = {
        name: 'Default',
        workspace,
        updatedAt: new Date().toISOString()
    };

    await mkdir(workspace, { recursive: true });
    store.projects[normalizeName(record.name)] = record;
    store.activeProjectName = normalizeName(record.name);
    await writeStore(store);

    return store;
}
