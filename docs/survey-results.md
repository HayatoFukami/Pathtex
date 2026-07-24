# コードベース監査結果

## 1. エグゼクティブサマリー

- **全体リスク:** High
- **最重要課題:** 保持期限削除が本番経路から未呼び出し、RaidMode の Verification Level 復旧不能窓、Gateway イベントの無制限非同期実行。
- **調査範囲:** `src/`、Prisma schema/migrations、テスト、CI、設定、依存関係、仕様書。
- **変更:** なし。最終 `git status --short` と `git diff --check` はともに出力なし。
- **制約:** 実 Discord／本番 DB／E2E は実施していない。build は生成物を作るため未実施。

## 2. リポジトリ概要

- **技術:** Node.js ESM / TypeScript、discord.js v14、Prisma/PostgreSQL、Zod、Luxon、Pino、Vitest。
- **構造:** Discord runtime → services/features → Prisma repositories。`src/index.ts` が DI と Gateway 配線を担う。
- **外部依存:** Discord API、PostgreSQL、Docker/Testcontainers。
- **UI:** Web UI はなく Discord Interaction のみ。

## 3. 問題一覧

| ID | 重大度 | 確信度 | 分類 | 問題 | 主な場所 | 影響 |
| -- | --- | --- | -- | -- | ---- | -- |
| H-01 | High | High | 永続化/運用 | 保持期限処理が未接続 | `prisma-repositories.ts:795` | DB肥大・容量枯渇 |
| H-02 | High | High | 正しさ | Raid Verification の復旧不能窓 | `raid/service.ts:122`, `:352` | Guild が HIGH のまま残留 |
| H-03 | High | High | 負荷/可用性 | Gateway 処理が無制限・drainなし | `index.ts:1533` | DB枯渇・停止時の処理喪失 |
| M-01 | Medium | High | 性能 | Interaction dedupe が O(n)・無上限 | `runtime/dedupe.ts:8` | 高負荷時の遅延 |
| M-02 | Medium | High | 性能 | Bulk delete の N+1 DB 操作 | `logging/pipeline.ts:177` | DB接続・レイテンシ悪化 |
| M-03 | Medium | High | 設定契約 | `MAX_BULK_TARGETS` が未使用 | `config/env.ts:76` | 想定より多い一括制裁 |
| M-04 | Medium | High | データ正確性 | 編集で snapshot `created_at` を上書き | `prisma-repositories.ts:1027` | 保存メタデータの不正確化 |
| L-01 | Low | High | 依存関係 | `undici@6.24.1` の既知アドバイザリ | `pnpm-lock.yaml` | 現行用途での悪用可能性は低いが更新要 |

## 4. 詳細

### H-01 保持期限処理が本番経路へ未接続

- **該当箇所:** `src/repositories/prisma-repositories.ts:795-827`, `:1831-1841`
- **説明:** snapshot、Raid join event、終端 scheduled action、退出済み guild の削除実装はあるが、`src/` 内に呼び出し元がない。
- **発生条件:** 通常運用の継続。
- **影響:** データとインデックスが継続的に増加し、長期的に DB 容量・性能へ影響。
- **根拠:** `deleteExpiredSnapshots`、`deleteOldRaidEvents`、`deleteOldScheduledActions`、`cleanupEligible` は repository contract/実装のみ。`MESSAGE_RETENTION_DAYS` も設定定義のみで未使用。
- **推奨:** 定期保守ジョブを lifecycle/scheduler へ接続し、上限付きバッチ削除と監視を追加。
- **検証:** 保持期限を超えた fixture が定期実行後に削除される統合テスト。

### H-02 Raid Verification Level の復旧不能窓

- **該当箇所:** `src/features/raid/service.ts:122-136`, `:347-362`; `src/repositories/prisma-repositories.ts:1603-1607`
- **説明:** Discord 側を HIGH に更新した後で DB の `raidVerificationChanged` を記録する。
- **発生条件:** Discord API 成功後、DB 更新前にプロセス停止・クラッシュ。
- **影響:** RaidMode を OFF にしても元の Verification Level へ戻らず、Guild が HIGH のまま残る。
- **既存緩和策:** Guild lock は ON/OFF 競合を抑えるが、プロセス障害は救えない。
- **推奨:** 永続 intent と状態遷移を先に記録し、起動時 reconciliation を実装する。
- **検証:** API 成功直後のクラッシュ状態を再現し、再起動または OFF で元レベルへ復旧すること。

### H-03 Gateway の無制限非同期処理

- **該当箇所:** `src/index.ts:1533-1544`, `:1711-1722`; `src/features/logging/message-queue.ts:22-33`
- **説明:** Gateway operation は fire-and-forget で、全体の in-flight 上限・停止時 drain がない。
- **発生条件:** Raid、bulk delete、メンバーイベントなどが高頻度に到達。
- **影響:** Promise・DB待機が蓄積し、メモリ、DB pool、イベントループを圧迫。終了時に処理が途中で失われる。
- **推奨:** イベント種別ごとの bounded queue / semaphore、shutdown 時の受付停止・drain・timeout を導入。
- **検証:** 多数イベントを同時投入し、同時実行数・メモリ・shutdown 完了性を測定。

### M-01 Interaction dedupe の線形掃除

- **該当箇所:** `src/runtime/dedupe.ts:8-14`
- **説明:** 受信ごとに全 Map を走査して期限切れを削除し、サイズ上限がない。
- **影響:** 高頻度 Interaction で CPU 使用量が二次的に悪化する。
- **推奨:** 容量制限と償却 O(1) の expiry 管理を導入し、component/modal も重複防止対象として検討。

### M-02 Bulk delete の N+1

- **該当箇所:** `src/features/logging/pipeline.ts:177-215`
- **説明:** 未キャッシュ ID ごとに `getMessage()`、全 ID ごとに `deleteMessage()` を並列実行する。
- **影響:** 1 bulk event で多数の個別 SQL が発行される。
- **推奨:** 既存の複数取得 API を使い、取得・削除をバッチ化する。

### M-03 `MAX_BULK_TARGETS` が未使用

- **該当箇所:** `src/config/env.ts:76`, `src/features/moderation/validation.ts:15`
- **説明:** 環境変数は検証されるが、機能へ注入されず target parser は 20 固定。
- **影響:** 運用者が下げた制限が効かず、想定外の一括操作を許す。
- **推奨:** composition root から parser/service へ渡すか、設定項目を削除する。

### M-04 編集時の snapshot 作成時刻上書き

- **該当箇所:** `src/features/logging/pipeline.ts:115-130`, `src/repositories/prisma-repositories.ts:1019-1029`
- **説明:** upsert の update 側でも `createdAt: input.createdAt ?? new Date()` を実行する。
- **影響:** メッセージ編集で本来の作成時刻が編集時刻へ変わる。
- **推奨:** update 側で `createdAt` を変更しない。
- **検証:** 編集前後で snapshot の `created_at` が不変である統合テスト。

### L-01 `undici` 既知アドバイザリ

- **該当箇所:** `pnpm-lock.yaml`。`discord.js@14.26.5` 経由で `undici@6.24.1`。
- **根拠:** `pnpm audit --prod` は High 1、Moderate 1、Low 2 を報告。
- **既存緩和策:** Bot の Gateway は当該 WebSocket 経路を通常利用せず、Cookie API も未使用。
- **推奨:** `discord.js` の更新または検証済みの `pnpm.overrides` により `undici >= 6.27.0` へ更新。

## 5. 根本原因と横断的リスク

- 永続データの**実装はあるが lifecycle へ接続されていない**。
- Discord 側状態と DB 状態の**複数システム整合性**に crash reconciliation が不足。
- 高頻度 Gateway 入力に対する**全体的な並行数・バックプレッシャー制御**が不足。
- 設定値を定義しても feature へ注入する契約が不足。

## 6. 優先対応計画

### 直ちに対応

- **H-01** 保持期限ジョブの接続・バッチ化 — **Medium**
- **H-02** Raid Verification の永続 intent / 起動時復旧 — **Large**
- **H-03** Gateway の bounded queue と graceful drain — **Large**

### 次回リリースまでに対応

- **M-02** Bulk delete のバッチ DB 操作 — **Medium**
- **M-03** `MAX_BULK_TARGETS` の配線または削除 — **Small**
- **M-04** snapshot `createdAt` の更新停止 — **Small**
- **L-01** 依存関係更新 — **Small**

### 中期的に改善

- **M-01** dedupe の容量・expiry 設計改善 — **Medium**
- CI に負荷・shutdown・保持期限の統合テストを追加 — **Medium**

### 経過観察

- 設定 component/modal の二重実行は現状ほぼ冪等で、`setup` はロック済み。
- Settings cache の期限切れエントリ保持は、仕様上の最大 Guild 数から現時点では Low。

## 7. 検証結果

- 成功:
    - `corepack pnpm lint`
    - `corepack pnpm format:check`
    - `corepack pnpm typecheck`
    - `corepack pnpm test:integration` — 33 tests
    - `corepack pnpm exec vitest run tests/shared-services.test.ts` — 13 tests
- 失敗:
    - `corepack pnpm test` — 652 tests 中 1 件失敗  
      `tests/shared-services.test.ts:315`。直後の対象ファイル単独再実行では成功しており、再現性は未確定。
- セキュリティ検査:
    - `corepack pnpm audit --prod` — 4 advisory。
- 未実施:
    - `pnpm build`、`pnpm prisma:generate` — 生成物を作成するため。
    - 本番 Discord / 本番 DB E2E — 安全上実施しない。

## 8. 調査カバレッジ

- **十分:** runtime、features、services、repositories、Prisma、設定、CI、テスト、依存関係。
- **部分的:** 実負荷での Discord API レート制限・Gateway throughput。
- **未調査:** 本番インフラ、実 Guild の権限設定、バックアップ実運用。

## 9. 除外した候補

- `CaseSource.SCHEDULED` enum 欠落: additive migration と統合テストにより反証。
- Docker Compose に Bot がない: development-only DB compose として意図的。
- Scheduler 二重タイマー: production caller では発生しない。
- logger redaction、owner ID 漏洩、audit customId、401 fatal 二重実行: 到達性・既存防御により Critical/High は反証。