import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface MigrationCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/** Invoke pnpm through Corepack; Corepack resolves the packageManager version. */
export function createMigrationCommand(): MigrationCommand {
  return {
    executable: process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
    args: ['pnpm', 'prisma', 'migrate', 'deploy'],
  };
}

type ExecFile = (
  file: string,
  args: readonly string[],
  options: { cwd: string },
) => Promise<unknown>;

const execFileAsync = promisify(execFile) as unknown as ExecFile;

export async function runMigrations(
  cwd: string,
  execute: ExecFile = execFileAsync,
): Promise<void> {
  const command = createMigrationCommand();
  await execute(command.executable, command.args, { cwd });
}

export type { ExecFile as MigrationExecutor };
