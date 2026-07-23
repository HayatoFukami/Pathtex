# プラットフォーム・データ基盤仕様

この文書は、全機能が共有する実行基盤、Gatewayイベント、予約ジョブ、キャッシュ、永続データモデルの仕様である。Repositoryはここに定めるデータモデルを唯一の正とし、機能側はService経由で利用する。

## 依存関係

- 先に`00-common.md`を読む。
- 個別機能のデータ利用規則は、各機能仕様書の要求と本書を組み合わせて実装する。

---

# 3. アーキテクチャ設計

## 3.1 ディレクトリ

```text
src/
  index.ts
  client.ts
  config/
  commands/
    general/
    moderation/
    settings/
    automod/
    tools/
  interactions/
    command-router.ts
    autocomplete-router.ts
    component-router.ts
  events/
    interaction-create.ts
    message-create.ts
    message-update.ts
    message-delete.ts
    message-delete-bulk.ts
    guild-member-add.ts
    guild-member-remove.ts
    guild-member-update.ts
    user-update.ts
    voice-state-update.ts
    guild-ban-add.ts
    guild-ban-remove.ts
    channel-create.ts
    channel-delete.ts
    channel-update.ts
  services/
    moderation-service.ts
    strike-service.ts
    punishment-service.ts
    automod-service.ts
    raid-service.ts
    scheduler-service.ts
    message-cache-service.ts
    modlog-service.ts
    message-log-service.ts
    server-log-service.ts
    voice-log-service.ts
    permission-service.ts
    target-resolver.ts
    duration-parser.ts
    audit-service.ts
    lookup-service.ts
    guild-lifecycle-service.ts
  repositories/
  domain/
  jobs/
  resources/
    copypastas.txt
    referral_domains.txt
  utils/
prisma/
  schema.prisma
  migrations/
tests/
```

---

## 3.4 イベント処理

| イベント | 処理順 |
|---|---|
| `interactionCreate` | 種別判定→ギルド確認→認可→Bot権限→defer→実行 |
| `messageCreate` | スナップショット保存→AutoMod |
| `messageUpdate` | 旧スナップショット取得→編集後メッセージ確定→AutoMod→編集ログ→保存更新 |
| `messageDelete` | スナップショット取得→削除ログ→スナップショット削除 |
| `messageDeleteBulk` | 対象取得→一括削除ログ→スナップショット削除 |
| `guildMemberAdd` | スナップショット保存→参加ログ→Raid判定→Mute復元→Dehoist |
| `guildMemberRemove` | 現在のMember情報をsnapshotへ保存→退出ログ→Audit照合→スナップショット削除 |
| `guildMemberUpdate` | 名前・Nickname比較→ログ→ロール変更検知→MemberRoleChangeService（遷移ごとに相関→Audit→汎用ロールサーバーログ→設定済みMutedロールのみ外部ケース作成・Audit ID dedupe→ケース新規作成時のみmodlog）→Mute状態同期→Dehoist |
| `userUpdate` | username/global name比較→所属ギルドごとにログ・スナップショット更新 |
| `voiceStateUpdate` | Join/Leave/Move分類→ボイスログ→VoiceMove追従 |
| `guildBanAdd` | 内部操作との相関→bounded Audit照合→外部BANケースまたはケースなし→時限状態同期 |
| `guildBanRemove` | 内部操作との相関→bounded Audit照合→外部Unbanケースまたはケースなし→予約取消 |
| `channelCreate` | Mutedロールの上書き追加 |
| `channelDelete` | ログ設定・Ignore・Slowmode予約を無効化 |
| `channelUpdate` | 外部Slowmode変更時に復元予約を取消 |
| `guildCreate` | ギルド再参加マーカーをACTIVEへ更新 |
| `guildDelete` | ギルド退出マーカーをLEFTへ更新し、保持期限を設定 |

`messageUpdate`では、取得した編集前スナップショットを「旧」、Gatewayメッセージ（必要なら`fetch()`した完全なメッセージ）を「新」として扱う。AutoMod判定と編集ログ生成の両方が完了するまで旧スナップショットを保持し、両処理へ旧・新の順で渡す。処理中に新しい内容でスナップショットを上書きしてはならず、完了後にだけ新しい内容、`edited_at`、保持期限を保存する。旧スナップショットがない場合も、新しい内容でAutoModを評価し、編集ログのBeforeは取得不能として扱う。新メッセージが部分ペイロード（`partial`）のときは`fetch()`で完全なメッセージの取得を試み、完全なペイロードは`fetch()`せずにそのまま使う。`fetch()`成功後は、取得した完全なメッセージに対してこのBot自身の再帰ログ防止判定を再度適用する。`fetch()`失敗が認証エラー（401）の場合は、代用viewで隠蔽せずfatalとして報告する。その他の失敗では、既存ペイロードがauthor解決済みかつ文字列contentを持つ十分なviewを構成できる場合のみ代用し、構成できない場合（contentがnullの部分ペイロード等）はエラーとして報告する。

削除を伴う処理では、削除APIを呼ぶ前に対象のMember/User表示情報をsnapshotへ保存する（snapshot-before-delete）。削除後にAPIから名前を再取得できる前提にしてはならない。`messageDelete`も同様に削除前のmessage snapshotを読み取り、ログ生成が完了するまで保持してから削除する。

Bot自身が送信したメッセージはAutoMod対象外とする。メッセージログ用スナップショットには保存してよいが、再帰ログ防止のため、ログチャンネル内に投稿された**このBot自身**のメッセージのみ保存・記録しない。他のBotやWebhookがログチャンネルへ投稿したメッセージは、スナップショット保存および編集・削除ログの対象として通常どおり扱う。部分ペイロード（author未キャッシュ）では、snapshotのauthorがこのBot自身である場合のみ再帰ログ防止の対象とする。

## 3.5 内部操作相関

Bot自身の操作で発生したGatewayイベントを外部操作として二重記録しないため、操作種別ごとに独立した、プロセス内の有界TTLキャッシュを持つ。キャッシュは相関情報を失っても永続化・再構成せず、一致しないイベントは外部操作として扱う。ただしロール変更遷移は例外であり、相関が一致しなかった場合も直ちに外部操作とみなさず、Audit照合へ進んでexecutorを分類する。一意に確定したAudit executorがこのBot自身である場合はexecutor=`Bot`とし、外部MUTE/UNMUTEケースを作成しない。

| キャッシュ | キー | エントリ | TTL・上限 | 消費するイベント |
|---|---|---|---|---|
| モデレーション操作相関 | `guildId:targetId:action` | `caseId`、`createdAt`、`expiresAt` | 15秒、最大10,000件 | `guildBanAdd`、`guildBanRemove`、`guildMemberRemove` |
| ロール変更相関 | `guildId:targetId:roleId:ADD\|REMOVE` | `createdAt`、`expiresAt` | 15秒、最大10,000件 | `guildMemberUpdate`（ロール変更のみ） |
| メッセージ削除相関 | `guildId:messageId` | `reason`、`caseId`（任意）、`createdAt`、`expiresAt` | 15秒、最大10,000件 | `messageDelete`、`messageDeleteBulk` |
| Slowmode操作相関 | `guildId:channelId` | `previousInterval`、`newInterval`、`createdAt`、`expiresAt` | 15秒、最大1,000件 | `channelUpdate` |

各キャッシュは登録順ではなくキー単位で照合し、期限切れエントリを返却しない。上限到達時は最も古いエントリを破棄する。Discord APIを呼ぶ直前に対応キャッシュへ登録し、対応するGatewayイベントで一致したエントリだけを一度消費する。別の操作種別のキャッシュを参照してはならない。BAN、UNBAN、KICKはモデレーション操作相関へ登録し、AutoMod・`/clean`等の削除はメッセージ削除相関へ、BotによるSlowmode変更はSlowmode操作相関へ登録する。MUTE/UNMUTE（Mutedロールの付与・除去）を含むBotによるロール付与・除去は、ロール変更相関へ`guildId:targetId:roleId:ADD|REMOVE`キーで登録する。ロール変更相関は、実際のロール変更API呼び出しの直前に登録し、`guildMemberUpdate`で一致した遷移を一度消費する。API失敗時は即座に削除し、消費されなかった場合はTTL満了で失効する。既にMutedの対象へのMute、既にロールがない対象へのUnmute等、ロールAPIを呼ばないno-op操作では相関を登録しない。相関が一致しない場合はAudit Logをbounded retryで照合する。外部BAN、UNBAN、MUTE、UNMUTE、KICK moderation caseには、対象・操作・実行者を一意に確定できるAudit entry IDが必須である。IDが取得できない、複数候補でambiguous、またはbounded retry後も一意に確定できない場合は外部moderation caseを作成せず、moderatorを帰属させない。該当するserver loggingはケース作成とは独立して適用する。

一意に確定したAudit entry IDを持つ外部操作のケースActionは次の固定マッピングを使う。

| イベント／照合 | 外部ケースAction |
|---|---|
| `guildMemberRemove`がAudit Logで内部操作でないKickと一致 | `KICK` |
| `guildBanAdd` | `BAN` |
| `guildBanRemove` | `UNBAN` |
| 設定済みMutedロールの外部遷移（ロール変更相関なし、かつ一意なAudit executorがBotでない場合） | `MUTE`または`UNMUTE` |

### 3.5.1 外部Audit照合のbounded retry契約

内部操作相関を最初に確認し、一致した場合は外部Audit照合を行わず外部ケースを作成しない。一致しない場合だけ、Gatewayイベントの受信時刻を基準にAudit Logを次の固定条件で照合する。

- 試行回数: 最大3回（初回を含む）
- 試行絶対offset: 0ms、500ms、1500ms（最大待機合計1500ms）
- 各クエリのlimit: 25件
- event timestamp window: Gatewayイベント受信時刻の前後5秒（`eventAt - 5s <= audit.createdAt <= eventAt + 5s`）

候補は、対象イベントに対応する期待Action、対象user ID、Audit entryの非NULL executor、上記timestamp windowのすべてを満たさなければならない。期待Audit actionはKICK=`MEMBER_KICK`、BAN=`MEMBER_BAN_ADD`、UNBAN=`MEMBER_BAN_REMOVE`とする。Mute/UnmuteはAudit actionが`MEMBER_ROLE_UPDATE`で、対象user IDとexecutorが一致し、変更内容が設定済みMuted roleの付与／除去であることを追加条件とする。KICK、BAN、UNBANはそれぞれこの期待Audit actionと対象user IDが一致することを必須とする。

ロール変更のexecutor解決は、1つの`guildMemberUpdate`に含まれる全遷移に対して、遷移ごとに次の優先順位で決定する。

1. ロール変更相関が一致した遷移はexecutor=`Bot`とし、その遷移のAudit照合を行わない。
2. 相関が一致しなかった遷移だけを対象に、1回のbounded retry試行ごとに**共有のAudit fetchを1回**実行し、取得したエントリ集合を全未解決遷移に適用する。1つの`MEMBER_ROLE_UPDATE`エントリは複数のロール変更を論理的に含み得る。各遷移は、対象role IDとADD/REMOVE方向が一致し、対象user ID・非NULL executor・timestamp windowを満たす候補がちょうど1件かを判定する。
3. 一意に確定したexecutorが**このBot自身**である場合、executor=`Bot`とし、設定済みMutedロールの遷移であっても外部MUTE/UNMUTEケースを作成しない。
4. 一意に確定したexecutorがBotでない場合、そのexecutorを`displayName (userId)`（表示名取得不能時は`userId`のみ）で描画する。設定済みMutedロールの遷移は外部MUTE/UNMUTEケース作成の対象となる。
5. 0件または複数件は`不明`とし、外部ケースを作成しない。

`discord_audit_log_entry_id`によるdedupeはmoderation case作成にのみ適用し、汎用ロール変更サーバーログの記録には適用しない。同一Audit entry IDが複数のロール遷移にまたがる場合でも、各遷移のサーバーログは独立して記録する。

3回のいずれかで条件を満たす候補が**ちょうど1件**になった場合だけ、そのentry IDを採用する。0件、複数件、action・target・executor・時刻のいずれかが不一致、またはexecutorがNULLの場合は照合失敗とし、外部moderation caseを作成せずmoderatorを帰属させない。照合失敗でも該当するserver logging、snapshot-before-delete、内部相関の消費規則は維持する。採用したentry IDは`discord_audit_log_entry_id`でdedupeする。

`guildMemberRemove`がBANまたは`guildBanAdd`と相関している場合はKICKケースを作成しない。`guildMemberRemove`でKICKを作成できるのはbounded Audit照合で一意の非内部Kick entry IDと一致した場合だけである。BAN解除の`guildBanRemove`も同じ外部操作についてKICKケースを追加作成してはならない。内部相関が一致したイベントは外部ケースを作らず、外部イベントは`discord_audit_log_entry_id`のギルド内一意制約でdedupeする。

## 3.6 スケジューラ

DBポーリング方式を採用する。

- 5秒ごとに検索
- 条件: `status=PENDING AND execute_at<=now()`
- 1回最大50件
- 排他取得は`FOR UPDATE SKIP LOCKED`相当
- 取得時に`RUNNING`、`locked_at`、`locked_by`を設定
- 成功時`COMPLETED`
- 再試行可能エラーは最大5回
- 再試行間隔は30、60、120、240、480秒
- 404または既に解除済みは冪等成功
- 403は`FAILED`
- `RUNNING`のまま5分経過した行は起動時に`PENDING`へ戻す

ジョブ種別:

- `UNBAN`
- `UNMUTE`
- `RESTORE_SLOWMODE`
- `DISABLE_RAIDMODE`

同一ギルド・対象・種別へ新しい予約を作成する場合、既存PENDING予約は`CANCELLED`にする。

予約の保守削除は終端状態だけを対象とする。`COMPLETED`は`updated_at`から30日、`CANCELLED`は`updated_at`から30日、`FAILED`は90日を経過した行を削除してよい。削除直前にトランザクション内で状態を再確認し、`PENDING`または`RUNNING`の行は理由・経過時間を問わず削除してはならない。`RUNNING`の回収は5分経過時の`PENDING`戻しだけであり、保守削除とは別処理とする。

---

## 3.8 キャッシュ

| キャッシュ | 最大・TTL |
|---|---|
| ギルド設定 | 5分、更新時即時無効化 |
| Punishment | 5分 |
| Ignore | 5分 |
| AutoMod編集重複防止 | 10分、最大10,000 |
| Duplicate | 3,000ユーザーキー、30秒 |
| モデレーション操作相関 | 15秒、最大10,000件 |
| ロール変更相関 | 15秒、最大10,000件 |
| メッセージ削除相関 | 15秒、最大10,000件 |
| Slowmode操作相関 | 15秒、最大1,000件 |
| Audit照合結果 | 30秒 |

キャッシュが失効または欠損した場合はDB/APIから取得し、古い値を無期限使用しない。

---

# 4. データモデル定義

## 4.1 共通規則

- Snowflakeは`VARCHAR(20)`。
- 日時は`TIMESTAMPTZ`、UTC保存。
- 主キーUUIDはUUIDv7推奨。
- 全可変レコードに`created_at`、`updated_at`を持たせる。
- ギルド退出時、設定・ストライク・ケースは即時削除しない。
- ギルド退出・再参加は永続マーカーで管理し、退出から90日以上Botが不在であることを確認するまで設定・ストライク・ケース等を削除しない。
- CASCADE削除はメッセージキャッシュ等の一時データに限定する。
- user-target actionの表示契約は`00-common.md §1.7`に従う。user-target actionの`target_display`は名前snapshotのみであり、IDまたは`displayName (userId)`形式を保存しない。非ユーザー対象caseはAction固有descriptorを維持する。

## 4.2 `guild_settings`

| カラム | 型 | 制約・既定 |
|---|---|---|
| `guild_id` | VARCHAR(20) | PK |
| `modlog_channel_id` | VARCHAR(20) | NULL |
| `message_log_channel_id` | VARCHAR(20) | NULL |
| `server_log_channel_id` | VARCHAR(20) | NULL |
| `voice_log_channel_id` | VARCHAR(20) | NULL |
| `mod_role_id` | VARCHAR(20) | NULL |
| `muted_role_id` | VARCHAR(20) | NULL |
| `timezone` | VARCHAR(64) | NOT NULL DEFAULT `UTC` |
| `raid_mode_enabled` | BOOLEAN | DEFAULT false |
| `raid_mode_source` | ENUM | `MANUAL`,`AUTO`,NULL |
| `raid_mode_reason` | VARCHAR(1000) | NULL |
| `raid_started_at` | TIMESTAMPTZ | NULL |
| `verification_level_before_raid` | SMALLINT | NULL、0～4 |
| `raid_verification_changed` | BOOLEAN | DEFAULT false |
| `next_case_number` | INTEGER | DEFAULT 1、CHECK > 0 |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

インデックス:

- PK `guild_id`
- `modlog_channel_id`
- `message_log_channel_id`
- `server_log_channel_id`
- `voice_log_channel_id`

## 4.3 `automod_settings`

| カラム | 型 | 既定・制約 |
|---|---|---|
| `guild_id` | VARCHAR(20) | PK/FK |
| `anti_invite_strikes` | SMALLINT | 0、0～100 |
| `anti_referral_strikes` | SMALLINT | 0、0～100 |
| `anti_everyone_strikes` | SMALLINT | 0、0～100 |
| `anti_copypasta_strikes` | SMALLINT | 0、0～100 |
| `max_user_mentions` | SMALLINT | NULL、1～100 |
| `max_role_mentions` | SMALLINT | NULL、1～100 |
| `max_lines` | SMALLINT | NULL、1～500 |
| `duplicate_enabled` | BOOLEAN | false |
| `duplicate_delete_threshold` | SMALLINT | NULL、2～20 |
| `duplicate_strike_threshold` | SMALLINT | NULL、2～20 |
| `duplicate_strikes` | SMALLINT | 1、1～100 |
| `autodehoist_character` | VARCHAR(8) | NULL、1 Unicode code point |
| `auto_raid_enabled` | BOOLEAN | false |
| `auto_raid_join_count` | SMALLINT | 10、3～100 |
| `auto_raid_window_seconds` | SMALLINT | 10、2～300 |
| `auto_raid_idle_seconds` | SMALLINT | 120固定 |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

## 4.4 `punishments`

| カラム | 型 | 制約 |
|---|---|---|
| `id` | UUID | PK |
| `guild_id` | VARCHAR(20) | FK |
| `threshold` | INTEGER | 1～1,000,000 |
| `action` | ENUM | `MUTE`,`KICK`,`SOFTBAN`,`BAN` |
| `duration_seconds` | INTEGER | NULLまたは1～31,536,000 |
| `created_by` | VARCHAR(20) | NOT NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

制約:

- UNIQUE(`guild_id`,`threshold`)
- durationはMUTE/BANのみ許可
- KICK/SOFTBANではNULL
- MUTEのdurationは2,419,200（28日）以下
- BANのdurationは31,536,000（365日）以下
- `None`はレコード削除として表現

インデックス:

- (`guild_id`,`threshold`)

## 4.5 `user_strikes`

| カラム | 型 | 制約 |
|---|---|---|
| `guild_id` | VARCHAR(20) | PKの一部 |
| `user_id` | VARCHAR(20) | PKの一部 |
| `count` | INTEGER | 0～1,000,000 |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

インデックス:

- PK(`guild_id`,`user_id`)
- (`guild_id`,`count` DESC)

## 4.6 `strike_transactions`

| カラム | 型 | 内容 |
|---|---|---|
| `id` | UUID | PK |
| `guild_id` | VARCHAR(20) | NOT NULL |
| `user_id` | VARCHAR(20) | NOT NULL |
| `delta` | INTEGER | 0以外 |
| `requested_delta` | INTEGER | NOT NULL |
| `before_count` | INTEGER | NOT NULL |
| `after_count` | INTEGER | NOT NULL |
| `source` | ENUM | `MANUAL_STRIKE`,`PARDON`,`AUTOMOD` |
| `actor_user_id` | VARCHAR(20) | Bot自動処理時はBot ID |
| `reason` | VARCHAR(1000) | NOT NULL |
| `mod_case_id` | UUID | NULL/FK |
| `created_at` | TIMESTAMPTZ | NOT NULL |

インデックス:

- (`guild_id`,`user_id`,`created_at` DESC)
- (`mod_case_id`)

## 4.7 `moderation_cases`

| カラム | 型 | 内容 |
|---|---|---|
| `id` | UUID | PK |
| `guild_id` | VARCHAR(20) | NOT NULL |
| `case_number` | INTEGER | NOT NULL |
| `action` | ENUM | 下記 |
| `target_user_id` | VARCHAR(20) | NULL |
| `target_display` | VARCHAR(128) | NOT NULL。user-target actionではdisplayName snapshotのみ。Snowflake、IDを含む整形済み値、メンションは禁止 |
| `moderator_user_id` | VARCHAR(20) | NOT NULL |
| `reason` | VARCHAR(1000) | NULL |
| `duration_seconds` | INTEGER | NULL |
| `source` | ENUM | `COMMAND`,`AUTOMOD`,`PUNISHMENT`,`RAIDMODE`,`EXTERNAL`,`SCHEDULED` |
| `status` | ENUM | `PENDING`,`COMPLETED`,`FAILED`,`PARTIAL` |
| `error_code` | VARCHAR(64) | NULL |
| `log_message_id` | VARCHAR(20) | NULL |
| `log_channel_id` | VARCHAR(20) | NULL |
| `discord_audit_log_entry_id` | VARCHAR(20) | NULL |
| `metadata` | JSONB | DEFAULT `{}` |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

Action Enum:

- `KICK`
- `BAN`
- `SOFTBAN`
- `SILENTBAN`
- `UNBAN`
- `MUTE`
- `UNMUTE`
- `STRIKE`
- `PARDON`
- `RAIDMODE_ON`
- `RAIDMODE_OFF`
- `VOICEKICK`
- `SLOWMODE`
- `AUTO_PUNISHMENT`

制約・インデックス:

- UNIQUE(`guild_id`,`case_number`)
- UNIQUE(`guild_id`,`discord_audit_log_entry_id`) WHERE NOT NULL
- (`guild_id`,`created_at` DESC)
- (`guild_id`,`case_number` DESC)
- (`guild_id`,`target_user_id`,`created_at` DESC)

user-target actionのケース作成時は`TargetIdentity`（[00-common.md §1.7](00-common.md)）を解決し、`target_user_id`へuserId、`target_display`へdisplayNameだけを保存する。失敗ケースも同じ規則で、fallback名とIDを表示層で組み立てる。user-target actionのmodlogは後からDiscord APIを再取得して書き換えず、保存済みケースのIdentityを使ってレンダリングする。

上記はuser-target actionに限る。非ユーザー対象のmoderation case（RaidMode on/off、Slowmode等）は、既存どおりAction固有の非空descriptorを`target_display`へ保存し、その値をTargetIdentityとして解析したり、`displayName (userId)`へ変換して描画したりしない。descriptorの既存意味は変更しない。

TargetIdentityを必要とするuser-target actionでは、ケース作成前の入力検証またはIdentity解決に失敗した対象について、ケース・modlog・予約を作成しない。ケース作成後のDiscord API失敗は、保存済みIdentity付きの失敗ケースとする。非ユーザー対象のケースはTargetIdentityを持たず、既存のケース意味を維持する。

Audit Log由来の外部ケースは、bounded retry後に取得した一意の`discord_audit_log_entry_id`を同一ギルドでdedupe keyとして扱う。既存IDがある場合は新しいケースを作らず、照合・再処理を冪等に完了する。IDがない、またはambiguousな場合は外部ケースを作らず、実行者をmoderatorとして保存しない。内部操作相関が一致したイベントも外部ケースを作成しない（[§3.5](#35-内部操作相関)）。

ケース番号は`guild_settings.next_case_number`をトランザクション内で取得・加算する。行が存在しない場合は、同じトランザクション内で`guild_settings`を既定値（`timezone=UTC`、`next_case_number=1`、その他NULLまたは既定値）で遅延作成してから行ロックを取得する。並行するケース作成は一意制約とトランザクション再試行により、ギルド内で番号を重複させない。modlog未設定でもケースを作成する。

ケース作成のための遅延作成は`/setup`を前提としない。一方、Mutedロールの作成と各チャンネルへの権限上書きはDiscord側の資源準備であるため、Muteを利用する前に`/setup`を実行する必要がある。`/setup`は既存の`guild_settings`を初期化し直さず、未作成の`automod_settings`とMutedロールを必要に応じて作成する。

## 4.8 `active_mutes`

MuteのDiscordロール状態とは別に、現在有効なMuteを永続化する。対象が退出してもこの行は保持し、再参加時のロール復元に使用する。無期限Muteも同じ行で表現する。

| カラム | 型 | 制約・内容 |
|---|---|---|
| `guild_id` | VARCHAR(20) | PKの一部、FK |
| `user_id` | VARCHAR(20) | PKの一部 |
| `case_id` | UUID | NOT NULL/FK |
| `expires_at` | TIMESTAMPTZ | NULLなら無期限 |
| `status` | ENUM | `ACTIVE`,`RELEASED`,`EXPIRED` |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

PKは(`guild_id`,`user_id`)、`ACTIVE`は対象ごとに最大1行とする。`ModerationService`がMute成功時の作成・期間更新、Unmute成功時の`RELEASED`更新を所有する。`SchedulerService`は期限到達時のDiscordロール解除と`EXPIRED`更新を所有し、`guildMemberAdd`の復元処理は`ACTIVE`行を読み取り、期限切れなら解除、期限内ならMutedロールを付与する。`guildMemberUpdate`はロールの外部変更を検知しても、永続状態を外部から`ACTIVE`へ変更しない。

Mute状態の変更と、対応する`UNMUTE`予約の取消・置換は同一DBトランザクションで行い、対象行を更新ロックする。期限処理も`ACTIVE`行のロック、予約の終端化、状態更新を同一トランザクションで行う。Discord API操作はDBトランザクションの外で実行し、API成功後の永続更新失敗は復旧対象として記録する。再参加処理は同じ対象の同時処理をロックまたは冪等制御し、重複付与・期限延長を起こさない。

## 4.9 `scheduled_actions`

| カラム | 型 | 内容 |
|---|---|---|
| `id` | UUID | PK |
| `guild_id` | VARCHAR(20) | NOT NULL |
| `target_user_id` | VARCHAR(20) | NULL |
| `channel_id` | VARCHAR(20) | NULL |
| `type` | ENUM | `UNBAN`,`UNMUTE`,`RESTORE_SLOWMODE`,`DISABLE_RAIDMODE` |
| `execute_at` | TIMESTAMPTZ | NOT NULL |
| `status` | ENUM | `PENDING`,`RUNNING`,`COMPLETED`,`FAILED`,`CANCELLED` |
| `payload` | JSONB | NOT NULL |
| `attempts` | SMALLINT | DEFAULT 0 |
| `locked_at` | TIMESTAMPTZ | NULL |
| `locked_by` | VARCHAR(64) | NULL |
| `last_error` | TEXT | NULL |
| `created_by_case_id` | UUID | NULL |
| `executed_case_id` | UUID | NULL、`moderation_cases.id`への参照 |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

インデックス:

- (`status`,`execute_at`)
- (`guild_id`,`target_user_id`,`type`,`status`)
- (`guild_id`,`channel_id`,`type`,`status`)
- UNIQUE(`executed_case_id`) WHERE NOT NULL

予約は作成元ケースを保持する。既存予約の意味・実行時刻・排他状態を変更しない。期限到来のUNBAN/UNMUTEは、originating caseの保存済みTargetIdentityをコピーした新しい`SCHEDULED`ケースを作成し、originating caseを更新しない。予約実装に不要な`scheduled_actions.source`カラムは持たない。新しいケースsourceの追加は既存ケースを壊さないadditive migrationとする。

期限到来のUNBAN/UNMUTEジョブは、Discord API操作と独立したケース冪等境界を持つ。Workerはまず`scheduled_actions`行を`FOR UPDATE`またはCASでclaimし、`executed_case_id IS NULL`を確認してからケース番号を割り当てる。claimと、originating caseの保存済みTargetIdentityをコピーした`SCHEDULED`ケースの作成、およびそのIDの`executed_case_id`への保存は同一トランザクションで行う。既にclaim済み、または`executed_case_id`が存在する再試行は既存IDを再利用し、SCHEDULEDケースとmodlogを重複作成しない。これにより同時Workerもケース番号を消費して重複modlogを作らない。カラム追加と既存行へのNULL導入はadditive migrationとする。

予約実行の再試行上限は共通定数`SCHEDULED_MAX_ATTEMPTS`=5である。claimのたびに`attempts`が増え、`attempts`が上限に達した後の再試行可能な失敗はジョブを`FAILED`で終端する。Worker（ディスパッチャ）はDiscord操作の成否を moderation outcome に保存された元Discord HTTPステータスで分類する。401はfatalとして伝播しケースを終端化しない（復旧可能のまま）。400/403は`FAILED`で終端化しmodlogを1回試行する。5xx/ネットワークエラーは再試行可能とし、最終試行（`attempts >= SCHEDULED_MAX_ATTEMPTS`）でのみ`FAILED`終端化とmodlog試行を行う。冪等成功（`NOT_APPLIED`/`ALREADY_APPLIED`/404）は`COMPLETED`で終端化する。UNMUTEのmute側CAS（`completeScheduledUnmute`）は一致する`ACTIVE`ミュートを`EXPIRED`にするのみで、ジョブは`RUNNING`のまま残す。ジョブの終端化とケース/modlog境界は`terminalizeScheduledCase`が担い、mute遷移とは独立させる。

限定されたクラッシュウィンドウ: Discord操作成功後〜ケース終端化（`terminalizeScheduledCase`）前にWorkerがクラッシュすると、ケースは一時的に`PENDING`のまま残る。これは意図的に限定されたウィンドウである。ジョブはstale回復で再claimされ、`createScheduledCase`が既存IDを再利用して冪等に再実行されるため、ケースやmodlogは重複しない。終端化前にクラッシュし、かつ再試行が上限まで尽くされた場合（`fail`によるretry exhaustion、または`attempts >= SCHEDULED_MAX_ATTEMPTS`でのstale回復）は、リポジトリが`executed_case_id`でリンクされた`PENDING`の`SCHEDULED`ケースをジョブの`FAILED`化と同一トランザクションで`FAILED`に更新する（フォールバック）。これによりクラッシュ後も`PENDING`ケースが残存しない。modlog配信の401はfatalとして再スローされ、その他の配信失敗は非fatal（終端化済みケースが権威）。

既知の無outbox制限（modlog配信ウィンドウ）: modlogはoutboxを持たず、ケース/ジョブのdurable終端化（`terminalizeScheduledCase`のコミット）の成功後、同期modlog配信（`writeCase`）の完了前にWorkerがクラッシュした場合、そのmodlogは永続的に失われる。ケースとジョブはdurableに確定済みであり権威として残るが、後続の調整（reconciliation）がこのmodlogを再送・補填することはない。つまり「ケース/ジョブは確定したがmodlogだけが届かない」状態が許容される。これはoutbox/再送キューを意図的に持たない限定設計であり、modlogのat-most-once配信とケース/ジョブのdurableな確定を分離する。ユーザー/member解決段階のDiscord HTTPステータスは共有のdirect/cause分類器で伝播し、401はfatal（終端化せず再スロー）、403/400は確定`FAILED`分類のためステータスを付与、5xx/ネットワークは再試行可能なステータス意味を維持する。

## 4.10 無視設定

### `ignored_roles`

| カラム | 型 |
|---|---|
| `guild_id` | VARCHAR(20) |
| `role_id` | VARCHAR(20) |
| `created_by` | VARCHAR(20) |
| `created_at` | TIMESTAMPTZ |

PK: (`guild_id`,`role_id`)

### `ignored_channels`

| カラム | 型 |
|---|---|
| `guild_id` | VARCHAR(20) |
| `channel_id` | VARCHAR(20) |
| `created_by` | VARCHAR(20) |
| `created_at` | TIMESTAMPTZ |

PK: (`guild_id`,`channel_id`)

Botより上位または強い権限を持つロールの自動無視はDBへ保存せず、実行時に計算する。

## 4.11 `message_snapshots`

| カラム | 型 | 内容 |
|---|---|---|
| `message_id` | VARCHAR(20) | PK |
| `guild_id` | VARCHAR(20) | NOT NULL |
| `channel_id` | VARCHAR(20) | NOT NULL |
| `author_user_id` | VARCHAR(20) | NOT NULL |
| `author_display` | VARCHAR(128) | NOT NULL |
| `content` | TEXT | 最大4000 Unicode code point |
| `attachments` | JSONB | URL、filename、contentType、size |
| `embeds_summary` | JSONB | title、description、url、image URL |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `edited_at` | TIMESTAMPTZ | NULL |
| `expires_at` | TIMESTAMPTZ | NOT NULL |

インデックス:

- (`guild_id`,`channel_id`,`created_at` DESC)
- (`expires_at`)

削除ログ出力後は削除する。未削除スナップショットも保持期限後に削除する。

## 4.12 `guild_member_snapshots`

| カラム | 型 |
|---|---|
| `guild_id` | VARCHAR(20) |
| `user_id` | VARCHAR(20) |
| `username` | VARCHAR(32) |
| `global_name` | VARCHAR(32) NULL |
| `nickname` | VARCHAR(32) NULL |
| `joined_at` | TIMESTAMPTZ NULL |
| `updated_at` | TIMESTAMPTZ |

PK: (`guild_id`,`user_id`)

インデックス:

- (`user_id`)

退出ログ、username、global name、nickname変更比較に使用する。`user_id`単位のlookup（`listMembersForUser(userId)`）は`guild_id`昇順で該当ユーザーの全ギルドスナップショットを返し、`userUpdate`fanoutはGatewayキャッシュではなくこの永続lookupを使用する。

## 4.13 `raid_join_events`

| カラム | 型 |
|---|---|
| `id` | UUID PK |
| `guild_id` | VARCHAR(20) |
| `user_id` | VARCHAR(20) |
| `joined_at` | TIMESTAMPTZ |

制約・インデックス:

- UNIQUE(`guild_id`,`user_id`,`joined_at`)
- (`guild_id`,`joined_at` DESC)

5分より古い行は定期削除する。Bot参加は保存しない。

## 4.14 `guild_lifecycle_markers`

Botのギルド在籍状態と保持期限を永続化する。

| カラム | 型 | 制約・内容 |
|---|---|---|
| `guild_id` | VARCHAR(20) | PK |
| `status` | ENUM | `ACTIVE`,`LEFT` |
| `departed_at` | TIMESTAMPTZ | NULL、最後に退出した時刻 |
| `rejoined_at` | TIMESTAMPTZ | NULL、最後に再参加した時刻 |
| `cleanup_eligible_at` | TIMESTAMPTZ | NULL、`departed_at + 90日` |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

`GuildLifecycleService`が`guildDelete`で行をなければ作成したうえで`LEFT`、`departed_at`、`cleanup_eligible_at`を同一トランザクションで更新し、`guildCreate`では行ロックを取得して`ACTIVE`、`rejoined_at`、`cleanup_eligible_at=NULL`へ更新する。再参加が先行した場合は削除を中止する。保守ジョブは`status=LEFT AND cleanup_eligible_at<=now()`をロックして確認し、次の順序で依存データを削除する: (1)期限切れの一時イベント・スナップショットと終端Scheduled Action、(2)無視設定・AutoMod・Punishment・Active Mute、(3)Strike、(4)Moderation Case、(5)Guild設定、(6)ライフサイクルマーカー。各段階を同一トランザクションで行い、開始後に`ACTIVE`へ戻っていた場合は全削除を中止する。失敗時はロールバックし、90日未満のデータおよび再参加ギルドのデータを削除しない。

## 4.15 重複検知キャッシュ

DBへは保存しない。

```text
Map<guildId:userId, {
  normalizedContent,
  lastMessageAt,
  duplicateOrdinal,
  messageIds: [{channelId, messageId, createdAt}]
}>
```

- 最大3,000キー
- LRU方式
- 30秒無操作で失効
- 最初のメッセージを1件目とする
- 再起動時にリセット
- message IDsは直近2分、最大20件のみ保持

## 4.16 Strikeのゼロ差分

`StrikeService`は対象の`user_strikes`行を更新ロックして、加算後を`min(1,000,000, before + requested_delta)`、Pardon後を`max(0, before - requested_delta)`で計算する。計算された実効差分が0の場合は、`user_strikes`、`strike_transactions`、`moderation_cases`を作成・更新せず、DM、modlog、Punishment選択・実行、予約作成を一切行わない。結果は「変更なし（現在値: X）」として返す。実効差分が0でない場合だけ、ストライク行、履歴、ケース、Punishment判定を同一トランザクションで処理する。`strike_transactions.delta`は引き続き0以外を許可しない。

## 4.17 データ保持

| データ | 保持期間 |
|---|---|
| Guild設定 | ギルド退出後90日 |
| ストライク | ギルド退出後90日 |
| Moderation Case | ギルド退出後90日以上。運用者が延長可 |
| Message Snapshot | 既定7日 |
| Raid Join Event | 5分 |
| 完了Scheduled Action | 30日 |
| CANCELLED Scheduled Action | 30日（`updated_at`基準） |
| 失敗Scheduled Action | 90日 |
| アプリログ | 30日以上を推奨 |

---

**第1部終了。第2部では第5章として、全スラッシュコマンドのオプション、権限、正常系・異常系、Embed、複数対象設計を定義する。**
