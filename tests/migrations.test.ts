import { describe, expect, it, vi } from 'vitest';
import {
  createMigrationCommand,
  runMigrations,
  type MigrationExecutor,
} from '../src/migrations.js';

describe('database migrations', () => {
  it('builds a Corepack pnpm command', () => {
    expect(createMigrationCommand()).toEqual({
      executable: process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
      args: ['pnpm', 'prisma', 'migrate', 'deploy'],
    });
  });

  it('propagates migration failures unchanged', async () => {
    const failure = new Error('migration failed: DATABASE_URL=redacted');
    const execute = vi.fn<MigrationExecutor>().mockRejectedValue(failure);

    await expect(runMigrations('/project', execute)).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
      ['pnpm', 'prisma', 'migrate', 'deploy'],
      { cwd: '/project' },
    );
  });
});
