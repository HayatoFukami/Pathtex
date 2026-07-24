# 調査・修正タスク 完了報告

`docs/survey-results.md`(コードベース監査結果)を起点に、Git 差分から前セッションまでの修正進捗を調査し、未完了だった項目を修正・検証しました。

## 1. 調査方法

- `git status` / `git diff` で `main` ブランチ上の未コミット差分(47 ファイル変更・8 ファイル新規)を確認。
- `docs/survey-results.md` の 8 項目(H-01〜H-03, M-01〜M-04, L-01)それぞれについて、対応するソース差分の有無と内容を個別に確認。
- 新規テストファイル(`tests/phase1-followup.test.ts` など)で各修正がテストされているかを確認。

## 2. 各指摘事項の状態

| ID | 重大度 | 内容 | 状態(調査時点) | 実装箇所 |
|---|---|---|---|---|
| H-01 | High | 保持期限削除が本番経路から未呼び出し | 対応済み(前セッション) | [src/runtime/retention.ts](src/runtime/retention.ts), [src/services/retention-service.ts](src/services/retention-service.ts), [src/index.ts:684](src/index.ts#L684), [src/lifecycle.ts](src/lifecycle.ts) |
| H-02 | High | RaidMode Verification Level の復旧不能窓 | 対応済み(前セッション) | [src/repositories/prisma-repositories.ts](src/repositories/prisma-repositories.ts)(`revokeVerificationRaised` 追加、intent の事前永続化), [src/features/raid/service.ts](src/features/raid/service.ts) |
| H-03 | High | Gateway イベントの無制限非同期実行 | 対応済み(前セッション) | [src/runtime/gateway-work.ts](src/runtime/gateway-work.ts)(`GatewayWorkTracker`: bounded queue + drain)、`src/index.ts` へ配線 |
| M-01 | Medium | Interaction dedupe が O(n)・無上限 | 対応済み(前セッション) | [src/runtime/dedupe.ts](src/runtime/dedupe.ts)(容量上限付き amortized O(1)) |
| M-02 | Medium | Bulk delete の N+1 DB 操作 | 対応済み(前セッション) | [src/features/logging/pipeline.ts](src/features/logging/pipeline.ts)(`getMessages`/`deleteMessages` バッチ化) |
| M-03 | Medium | `MAX_BULK_TARGETS` が未使用 | 対応済み(前セッション) | [src/domain/parsers.ts](src/domain/parsers.ts), [src/commands/moderation/index.ts](src/commands/moderation/index.ts)(config からの配線確認済み) |
| M-04 | Medium | 編集で snapshot `created_at` を上書き | 対応済み(前セッション) | [src/repositories/prisma-repositories.ts](src/repositories/prisma-repositories.ts), [src/features/logging/pipeline.ts](src/features/logging/pipeline.ts) |
| **L-01** | Low | `undici@6.24.1` の既知アドバイザリ | **未対応 → 今回対応** | [package.json](package.json)(`pnpm.overrides` で `undici` を `>=6.27.0` へ強制) |

前セッションまでに High/Medium 全項目(H-01〜H-03, M-01〜M-04)は実装・テスト共に完了していました。今回のセッションでは唯一残っていた **L-01(依存関係の既知アドバイザリ)** を修正しました。

### L-01 の修正内容

`package.json` に以下を追加し、discord.js 経由で入る `undici@6.24.1`(推移的依存)を強制的に更新:

```json
"pnpm": {
  "overrides": {
    "undici@<6.27.0": ">=6.27.0"
  }
}
```

`pnpm install` 実行後、ロックファイル上の全 `undici` 依存が `8.7.0` に統一されたことを確認。

## 3. 検証結果(今回実行)

| コマンド | 結果 |
|---|---|
| `corepack pnpm lint` | 成功(warning 0) |
| `corepack pnpm format:check` | 成功 |
| `corepack pnpm typecheck` | 成功(src / test 共に) |
| `corepack pnpm test` | **752 tests 全成功**(30 ファイル。survey で言及されていたフレーキーな `tests/shared-services.test.ts` も安定して成功) |
| `corepack pnpm test:integration` | **35 tests 全成功**(PostgreSQL Testcontainers) |
| `corepack pnpm audit --prod` | **No known vulnerabilities found**(修正前は High 1 / Moderate 1 / Low 2 の 4 advisory) |

未実施(survey 時点から変更なし、意図的に対象外):

- `pnpm build` / `pnpm prisma:generate` — 生成物を作成するため未実施。
- 実 Discord / 本番 DB での手動 E2E — `docs/manual-e2e-checklist.md` に基づき別途手動実施が必要。

## 4. 現在の差分状況

`git status` で以下がステージされていない状態(コミット未実施):

- 変更: `docs/*.md`(6 ファイル、仕様書の同期更新)、`src/`・`tests/` 配下 41 ファイル、`package.json`、`pnpm-lock.yaml`
- 新規: `src/runtime/gateway-work.ts`, `src/runtime/retention.ts`, `src/services/retention-service.ts`, `tests/lifecycle-generation-race.test.ts`, `tests/logging-pipeline.test.ts`, `tests/phase1-followup.test.ts`, `docs/survey-results.md`

コミットは明示的な指示がない限り実施していません。

## 5. 結論

`docs/survey-results.md` に記載された全 8 項目(High 3件・Medium 4件・Low 1件)の修正が完了し、lint / format / typecheck / unit test / integration test / audit のすべてが成功しています。残るのは人手による Discord 実機 E2E 検証のみです。
