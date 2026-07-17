# Pathtex

Pathtexは、Discord向けの日本語モデレーションBotです。スラッシュコマンドで、モデレーション、AutoMod、ログ、ストライク、Raid Mode、ボイス操作などを提供します。

## 技術要件

- Node.js 22.12.0以上（24 LTS推奨）
- pnpm（リポジトリ指定: 9.15.9）
- PostgreSQL 16以上
- Discord Bot Tokenと、必要なPrivileged Gateway Intents

## 設定

`.env`等で、少なくとも次を設定します。

```text
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DATABASE_URL=postgresql://...
COMMAND_SCOPE=global
BOT_VERSION=0.1.0
```

`COMMAND_SCOPE=guild`の場合は`DEV_GUILD_ID`も必要です。全環境値は起動前に検証され、不正な値ではDiscordへ接続せず終了します。Tokenや`.env`は共有・コミットしないでください。

## 開発コマンド

```sh
corepack pnpm format
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

補助コマンドは`corepack pnpm dev`（開発起動）、`corepack pnpm start`（ビルド済み起動）、`corepack pnpm deploy:commands`（コマンド登録）です。通常の`test`は統合テストを除外します。PostgreSQL Testcontainerを使う統合テストは`corepack pnpm test:integration`で実行します。

## 設計方針

DiscordのI/OはCommand/Event Handler、業務ルールはService、Prismaによる永続化はRepositoryに分離しています。コマンドはギルド専用で、ユーザー向け応答とログは日本語を基本とします。

仕様の正本は[`docs/README.md`](docs/README.md)、共通制約は[`docs/00-common.md`](docs/00-common.md)です。
