import type { AccountRouter } from '../accounts/router.js';
import type { CodexRunOptions } from '../codex/runner.js';
import { HarnessRuntime } from './runtime.js';
import type { NativeHarnessResult } from './types.js';

export async function runNativeHarness(accounts: AccountRouter, options: CodexRunOptions, workspace: string): Promise<NativeHarnessResult> {
    return await new HarnessRuntime(accounts, workspace, options).run(options.prompt || '');
}

export type { NativeHarnessResult } from './types.js';
