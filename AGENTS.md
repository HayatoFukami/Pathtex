# Repository Guidance

## Current state

- This repository currently contains specifications only (`docs/`); there is no manifest, source tree, CI, or executable developer command yet. Do not invent `pnpm`, Docker, Prisma, lint, or test commands—add and document them with the implementation.

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
- Manual E2E verification belongs in a dedicated test guild. Run lint, formatting, TypeScript compilation, and tests once their project configuration exists; do not publish a Docker image if tests fail.
