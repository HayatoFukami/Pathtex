# Repository Guidance

## Current state

- This repository contains an ESM TypeScript implementation under `src/` (Discord handlers in `src/runtime/`, the command contract and manifest in `src/commands/`, feature slices in `src/features/`, Prisma-backed repositories in `src/repositories/`), a Prisma schema and migrations under `prisma/`, Vitest unit tests under `tests/`, PostgreSQL Testcontainers integration tests under `tests/integration/`, and CI in `.github/workflows/ci.yml`.
- Use the developer commands already defined in `package.json` rather than inventing them: `corepack pnpm install`, `pnpm prisma:generate`, `pnpm build`, `pnpm dev`, `pnpm start`, `pnpm deploy:commands`, `pnpm test`, `pnpm test:integration`, `pnpm lint`, `pnpm format` / `pnpm format:check`, and `pnpm typecheck` (plus `pnpm typecheck:src` / `pnpm typecheck:test`). CI runs lint, format check, both typechecks, unit tests, integration tests, and build in that order.

## Specification source of truth

- Read `docs/README.md` first, then `docs/00-common.md`, `docs/01-platform-and-data.md`, and only the feature specification being changed. The split `docs/` files are canonical; the legacy files referenced from `docs/README.md` are not present and must not be treated as the implementation starting point.
- Keep cross-cutting changes synchronized: update the common or platform specification before the affected feature specifications.

## Intended implementation constraints

- Use strict ESM TypeScript (Node 22.12+; Node 24 LTS preferred), pnpm, discord.js v14, Prisma/PostgreSQL, Vitest, Zod, Luxon, and Pino as specified in `docs/00-common.md`.
- Preserve the boundary: Discord command/event handlers handle Discord I/O only; services own business rules; repositories alone use Prisma. Do not bypass another feature's public service contract or call Prisma from a handler.
- Validate all environment values before connecting to Discord; invalid configuration exits with code 1. Never log or commit `.env` values or tokens.
- Keep Snowflakes as strings and validate untrusted Discord/database boundary data with Zod.
- Commands are guild-only. Define their registration data, execution, required bot permissions, authorization policy, and defer mode; defer work that may exceed Discord's three-second response window.

## Verification expectations

- Unit-test parsers and domain/policy logic; use PostgreSQL Testcontainers for persistence/concurrency integration tests and adapter-based mocks for discord.js behavior.
- Manual E2E verification belongs in a dedicated test guild (see `docs/manual-e2e-checklist.md`). Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm test` (plus `pnpm test:integration` for persistence) before merging; do not publish a Docker image if tests fail.
