import { readFile } from 'node:fs/promises';
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

  it('keeps Automod maxLines mapped to the migrated PostgreSQL column', async () => {
    const schema = await readFile('prisma/schema.prisma', 'utf8');
    const migration = await readFile(
      'prisma/migrations/20260718000000_reconcile_automod_settings/migration.sql',
      'utf8',
    );

    expect(schema).toMatch(
      /maxLines\s+Int\?\s+@map\("max_lines"\)\s+@db\.SmallInt/u,
    );
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "max_lines" SMALLINT',
    );
  });

  it('indexes guild_member_snapshots by user_id for userUpdate fanout lookup', async () => {
    const schema = await readFile('prisma/schema.prisma', 'utf8');
    const migration = await readFile(
      'prisma/migrations/20260723000000_index_guild_member_snapshots_user_id/migration.sql',
      'utf8',
    );

    expect(schema).toMatch(
      /model GuildMemberSnapshot[\s\S]*?@@index\(\[userId\]\)/u,
    );
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS "guild_member_snapshots_user_id_idx" ON "guild_member_snapshots"("user_id")',
    );
  });
});
