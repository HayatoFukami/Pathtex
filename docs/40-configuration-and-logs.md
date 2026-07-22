# 設定・ログ仕様

対象は`/setup`、ログチャンネル設定、`/timezone`、`/modrole`、`/settings`と、メッセージ・モデレーション・サーバー・ボイスの4種ログである。

## 前提

- 設定系コマンドはManage Guild権限が必要であり、MODロールでは代替できない。詳細は`00-common.md`に従う。
- Guild設定、メッセージ／メンバースナップショット、ケース永続化は`01-platform-and-data.md`に従う。
- VoiceMove固有のセッションとコマンドは`50-tools-and-voice.md`に従う。

---

## 5.4 設定コマンド

全コマンドで実行者のManage GuildまたはAdministratorを必須とする。MODロールでは代替できない。

## 5.4.1 `/setup`

オプションなし。

Bot権限:

- Manage Roles
- Manage Channels
- View Channels

処理:

1. `guild_settings`と`automod_settings`を作成。
2. 設定済みMutedロールが存在すれば再利用。
3. 未設定なら名前`Muted`、権限なし、mentionable=false、hoist=falseで作成。
4. 全テキスト/フォーラムチャンネルで以下をdeny:
   - Send Messages
   - Send Messages in Threads
   - Add Reactions
   - Create Public Threads
   - Create Private Threads
   - Send Voice Messages
5. Voice/StageでSpeakをdeny。
6. 成功・失敗チャンネルを集計。
7. ロールIDを保存。

既存上書きを全面置換せず、Mutedロールに関する必要denyだけを追加する。

---

## 5.4.3 ログ設定

以下は同一構成とする。

- `/messagelog set channel:<TEXT_CHANNEL>`
- `/messagelog off`
- `/modlog set channel:<TEXT_CHANNEL>`
- `/modlog off`
- `/serverlog set channel:<TEXT_CHANNEL>`
- `/serverlog off`
- `/voicelog set channel:<TEXT_CHANNEL>`
- `/voicelog off`

Bot必要権限:

- View Channel
- Send Messages
- Embed Links
- Read Message History

設定時にテストEmbedは送信しない。権限計算だけを行い、設定成功メッセージをInteractionへ返す。offはチャンネルIDをNULLにする。

## 5.4.4 `/timezone`

| オプション | 型 | 必須 |
|---|---|---:|
| `zone` | STRING、autocomplete | Yes |

IANA Time Zone IDとして検証する。例:

- `UTC`
- `Asia/Tokyo`
- `America/New_York`

有効なら正規化名を保存し、現在時刻をそのZoneで表示して確認させる。ログのDB時刻はUTCのまま変更しない。

## 5.4.5 `/modrole`

### `/modrole set role:<ROLE>`

managed role、`@everyone`、Bot自身の統合ロールは拒否する。Botより上位でもMOD認可用として設定は可能だが、Botのロール階層制約を回避できない旨を警告する。

### `/modrole off`

`mod_role_id=NULL`。

## 5.4.6 `/settings`

オプションなし。

複数Embedで以下を表示する。

1. ログチャンネル
2. MOD/Mutedロール
3. Timezone
4. RaidMode・AutoRaid
5. AutoMod各設定
6. Punishment一覧
7. 明示Ignoreロール・チャンネル
8. 自動Ignoreロール
9. Bot権限不足警告

---

---

## 8.7 ログEmbedスタイル

全4種の永続チャンネルログ（メッセージログ、モデレーションログ、サーバーログ、ボイスログ）のEmbedは、本節のスタイルに統一する。インタラクション応答、ダッシュボード表示、非ログEmbedは本スタイルの対象外とし、既存の各仕様に従う。

基本規則:

- 通常のEmbed（discord.js v14の`EmbedBuilder`）を使用する。Components v2（ボタン、セレクトメニュー等）はログEmbedに含めない。
- 表示タイトル、フィールドラベル、ドメイン値は日本語とする。内部enum名（コード上のEnum値）は変更せず、表示時に日本語ラベルへ変換する。
- 短い構造化フィールド（対象、実行者、チャンネル、期間、発生元、状態、DM、ユーザー、ロール、実行者等のラベル）は可能な限りinlineで配置し、Embedの縦幅を抑制する。
- 長文・自由形式フィールド（理由、変更前、変更後、メッセージ本文、添付、Embed情報）はinline不可のfull widthで配置する。
- 人間可読の日時フィールドや日時説明をEmbedに含めない。時刻表示はDiscord Embedのfooter timestampのみを使用する。
- Discord EmbedのtimestampはDiscordクライアントが閲覧者のローカルタイムゾーンでレンダリングする。Bot側でギルドタイムゾーンへ変換した値を渡してはならない。ギルドタイムゾーン（`/timezone`設定）は人間可読の日時表示が必要な非ログコンテキスト（インタラクション応答、設定表示等）に限って使用する。
- 各ログEmbedのfooter timestampは以下のとおり定義する。Gatewayイベントのペイロードに含まれるタイムスタンプ（例: `message.editedTimestamp`、`GuildMember.joinedTimestamp`）はログEmbedのtimestampとして使用しない。
  - **モデレーションログ**: `moderation_cases.created_at`（DBレコード作成時刻）。API操作の実行時刻を保証するものではない。
  - **メッセージ編集ログ**: ハンドラが`messageUpdate`イベントを受信した時刻（`Date.now()`）。編集されたメッセージの`editedTimestamp`ではない。
  - **メッセージ削除ログ**: ハンドラが`messageDelete`イベントを受信した時刻（`Date.now()`）。削除ペイロードにはタイムスタンプが含まれない。
  - **一括削除ログ**: ハンドラが`messageDeleteBulk`イベントを受信した時刻（`Date.now()`）。
  - **サーバーログ（Join/Leave/名前変更/ロール変更）**: ハンドラが各Gatewayイベント（`guildMemberAdd`/`guildMemberRemove`/`userUpdate`/`guildMemberUpdate`）を受信した時刻（`Date.now()`）。`GuildMember.joinedTimestamp`等のペイロード内タイムスタンプではない。
  - **ボイスログ**: ハンドラが`voiceStateUpdate`イベントを受信した時刻（`Date.now()`）。

以降の§8.8～§8.11では、上記スタイルを前提として各ログ固有の表示項目を定義する。フィールド定義表では全フィールドがinlineかfull widthかを明示する。

---

## 8.8 メッセージログ

### 8.8.1 編集ログ

`messageUpdate`で本文、添付、Embedのいずれかが変化した場合に記録する。DiscordによるEmbed展開だけの更新で本文・添付・主要Embed情報が同一なら記録しない。

Embed（§8.7スタイル適用）:

| 要素 | ラベル | 内容 | 配置 |
|---|---|---|---|
| Title | — | `メッセージ編集` | — |
| Color | — | 黄 | — |
| Author | — | 投稿者名、ID、Avatar | — |
| Channel | `チャンネル` | メンションとID | inline |
| Before | `変更前` | 編集前内容 | full width |
| After | `変更後` | 編集後内容 | full width |
| Attachments | `添付` | 追加・削除一覧 | full width |
| Message | `メッセージ` | Jump URL | inline |
| Timestamp | — | Discord Embed footer timestamp（`messageUpdate`ハンドラ受信時刻、§8.7） | — |

Discord Embedのフィールド上限を超える本文は各1000文字以内へ切り詰め、末尾に`…`を付ける。完全本文をファイル添付する機能は実装しない。

### 8.8.2 削除ログ

Embed（§8.7スタイル適用）:

| 要素 | ラベル | 内容 | 配置 |
|---|---|---|---|
| Title | — | `メッセージ削除` | — |
| Color | — | 赤 | — |
| Author | — | 投稿者名、ID、Avatar | — |
| Channel | `チャンネル` | メンションとID | inline |
| Message ID | `メッセージID` | Snowflake | inline |
| Executor | `削除実行者` | 削除実行者。特定不能時は`不明` | inline |
| Reason | `理由` | 削除理由 | full width |
| Content | `本文` | 本文。キャッシュ不存在時は`キャッシュに存在しないため取得できません` | full width |
| Attachments | `添付` | 添付URL一覧 | full width |
| Timestamp | — | Discord Embed footer timestamp（`messageDelete`ハンドラ受信時刻、§8.7） | — |

キャッシュに存在しない場合:

```text
本文: キャッシュに存在しないため取得できません
投稿者: 不明
```

### 8.8.3 削除実行者

messageDeleteには実行者が含まれないため次の順に特定する。

1. Bot内部削除相関キャッシュ
2. 2秒待機
3. Audit LogのMessage DeleteまたはBulk Deleteを取得
4. チャンネル、対象、件数、時刻±5秒を照合
5. 一意に一致しない場合は`不明`

自己削除を他ユーザーによる削除と断定してはならない。

### 8.8.4 一括削除

messageDeleteBulkは1イベントにつき1つの概要Embedとする。AutoModまたはCleanによる削除は内部相関情報から理由を表示する。

Embed（§8.7スタイル適用）:

| 要素 | ラベル | 内容 | 配置 |
|---|---|---|---|
| Title | — | `メッセージ一括削除` | — |
| Color | — | 赤 | — |
| Count | `削除件数` | 削除されたメッセージ総数 | inline |
| Channel | `チャンネル` | メンションとID | inline |
| Executor | `削除実行者` | 削除実行者。特定不能時は`不明` | inline |
| Reason | `理由` | AutoModまたはCleanの内部相関情報から取得。なければ省略 | full width |
| Cached | `キャッシュ取得` | スナップショットキャッシュから取得できた件数 | inline |
| Authors | `投稿者別` | 投稿者別の削除件数（上位のみ、全量が長大な場合は上位10件＋`他N名`） | full width |
| Preview | `プレビュー` | 最大10件の本文プレビュー（各100文字以内へ切り詰め） | full width |
| Timestamp | — | Discord Embed footer timestamp（`messageDeleteBulk`ハンドラ受信時刻、§8.7） | — |

## 8.9 モデレーションログ

全ケースはmodlog設定の有無にかかわらずDBへ保存する。

### 8.9.0 日本語表示変換

内部enum名（コード上のEnum値）は変更せず、modlog Embed描画時に以下の日本語表示へ変換する。内部値をそのままユーザー可視文字列として使用してはならない。

**Action表示（Title `ケース #N — アクション日本語名` およびEmbed内で使用）:**

| 内部Action | 日本語表示 |
|---|---|
| `KICK` | キック |
| `BAN` | BAN |
| `SOFTBAN` | ソフトBAN |
| `SILENTBAN` | サイレントBAN |
| `UNBAN` | BAN解除 |
| `MUTE` | ミュート |
| `UNMUTE` | ミュート解除 |
| `STRIKE` | ストライク |
| `PARDON` | ストライク取消 |
| `RAIDMODE_ON` | レイドモード有効 |
| `RAIDMODE_OFF` | レイドモード解除 |
| `VOICEKICK` | ボイスキック |
| `SLOWMODE` | スローモード |
| `AUTO_PUNISHMENT` | 自動制裁 |

**Source表示（`発生元`フィールド値）:**

| 内部Source | 日本語表示 |
|---|---|
| `COMMAND` | コマンド |
| `AUTOMOD` | AutoMod |
| `PUNISHMENT` | 自動制裁 |
| `RAIDMODE` | レイドモード |
| `EXTERNAL` | 外部 |
| `SCHEDULED` | 予約実行 |

**Status表示（`状態`フィールド値）:**

| 内部Status | 日本語表示 |
|---|---|
| `PENDING` | 保留 |
| `COMPLETED` | 成功 |
| `FAILED` | 失敗 |
| `PARTIAL` | 一部失敗 |

**Duration表示（`期間`フィールド値）:**

- `duration_seconds`がNULL → `永続`
- `duration_seconds`が非NULL → 人間可読形式（例: `10分`、`2時間30分`、`7日`、`365日`）

**DM表示（`DM`フィールド値）:**

- `成功`
- `失敗`
- `対象外`

### 8.9.1 Embed共通構成

Embed共通構成（§8.7スタイル適用）:

| 要素 | ラベル | 内容 | 配置 |
|---|---|---|---|
| Title | — | `ケース #N — <Action日本語表示>`（例: `ケース #42 — キック`） | — |
| Color | — | Action別（後述） | — |
| Target | `対象` | 表示名、ID | inline |
| Moderator | `実行者` | 表示名、ID | inline |
| Reason | `理由` | 理由または`理由未指定` | full width |
| Duration | `期間` | 日本語表示（§8.9.0） | inline |
| Source | `発生元` | 日本語表示（§8.9.0） | inline |
| Status | `状態` | 日本語表示（§8.9.0） | inline |
| DM | `DM` | 成功・失敗・対象外 | inline |
| Timestamp | — | Discord Embed footer timestamp（`moderation_cases.created_at`＝DBレコード作成時刻、§8.7） | — |
| Footer | — | ケースID（UUID） | — |

Action色（内部Action名で指定）:

| 内部Action | 色 |
|---|---|
| `KICK`, `MUTE`, `STRIKE` | 橙 |
| `BAN`, `SOFTBAN`, `SILENTBAN`, `RAIDMODE_ON` | 赤 |
| `UNBAN`, `UNMUTE`, `PARDON`, `RAIDMODE_OFF` | 緑 |
| `VOICEKICK`, `AUTO_PUNISHMENT` | 橙 |
| `SLOWMODE` | 青 |
| `FAILED` ステータスの全ケース | 灰 |

外部BAN、UNBAN、MUTE、UNMUTE、KICK moderation caseは、bounded retry後に対象・操作・実行者を一意に確定したAudit entry IDがある場合だけ作成する。Audit entry IDがunavailable、ambiguous、またはbounded retry後も一意に確定できない場合は、外部moderation caseを作成せず、moderatorを帰属させない。対応する内部相関がある場合も外部ケースを作成しない。ケースがなくても、該当するserver log（Join/Leave、名前・ロール遷移等）は通常どおり記録する。

### 8.9.2 TargetIdentityと外部監査

user-target actionのTarget欄は必ず`displayName (userId)`で描画する。名前解決は`00-common.md §1.7`の順序に限定し、ケース保存後にLive APIへ問い合わせて表示名を変えてはならない。user-target actionの`target_display`へIDや整形済み値を保存せず、ケースの保存済みdisplayName snapshotとtarget_user_idから表示する。失敗ケースも`不明なユーザー (userId)`を含める。非ユーザー対象caseのTarget欄はAction固有の既存descriptorをそのまま描画し、TargetIdentityとして解析しない。

ケースベースのmodlog APIは`ModlogService`が所有する。`ModlogService`は保存済みケースを受け取り、Action、Source、Statusを§8.9.0の日本語表示へ変換し、TargetIdentity、理由、期間とともに一貫してEmbedへレンダリングする。モデレーション、Strike、AutoMod、Punishment、RaidMode、Scheduler等のfeature callerはTarget文字列やmodlog Embedを構築せず、ケース作成／更新と`ModlogService`の公開契約だけを呼び出す。入力／Identity解決がケース作成前に失敗した結果にはケースもmodlogもない。

一意に確定した外部Audit Logイベントだけが`discord_audit_log_entry_id`をdedupe keyとして扱う。同一ギルド・同一IDが既にケース化されている場合は既存ケースを再利用し、外部ケースを二重作成しない。IDを確定できないイベントはケース化しない。内部操作相関が一致したイベントは外部ケースにしない。名前変更・退出・削除を伴うイベントはAudit照合またはAPI削除の前にsnapshot-before-deleteを完了させる。

外部Audit照合は[01-platform-and-data.md §3.5.1](01-platform-and-data.md)の固定bounded retry契約を使う（最大3回、絶対offset 0/500/1500ms、limit 25、イベント時刻±5秒）。相関を先に確認し、相関なしの場合だけ、期待Action、対象user ID、非NULL executor、時刻windowをすべて満たす候補がちょうど1件かを判定する。KICK=`MEMBER_KICK`、BAN=`MEMBER_BAN_ADD`、UNBAN=`MEMBER_BAN_REMOVE`を期待し、Muted role transitionは`MEMBER_ROLE_UPDATE`とMuted roleの付与／除去まで一致しなければならない。0件または複数件はambiguousとして外部moderation caseを作成しない。

### 8.9.3 Phase 2 P2C2 test expectations

P2C2では、KICK/BAN/UNBANおよび設定済みMuted roleのMUTE/UNMUTEについて、次を検証する。

- 相関一致時はAudit queryを行わず、外部ケースを作成しない。
- 相関なしで絶対offset 0/500/1500msの最大3回、各limit 25、±5秒windowを守る。
- action、target user ID、非NULL executor、event timestamp windowがすべて一致する候補が1件だけのときだけケースを作成する。
- 欠落、action／target／executor／時刻不一致、または複数候補ではケース・moderator帰属・modlogを作成せず、該当server logは保持する。
- 同一Audit entry IDの再受信・再試行はdedupeされ、ケースとmodlogを重複作成しない。
- 設定済みMuted role遷移で一意に確定したAudit executorがこのBot自身である場合、汎用ロール変更サーバーログにexecutor=`Bot`を記録し、外部MUTE/UNMUTEケース・modlogを作成しない。

## 8.10 サーバーログ

出力対象:

- Member Join
- Member Leave
- Username変更
- Global Display Name変更
- Guild Nickname変更
- ロール変更（付与・除去）
- BAN追加（外部BAN検知）
- BAN解除（外部UNBAN検知）

上記がサーバーログの全出力対象（排他的リスト）である。BAN追加・BAN解除は外部BAN/UNBAN検知時に意図的に出力するサーバーログである。サーバーログの対象外はチャンネルライフサイクル（チャンネル作成・チャンネル更新・チャンネル削除）のみである。チャンネル作成はMutedロール上書きのみ、チャンネル更新はSlowmode相関・復元ジョブ取消のみ処理する。チャンネル削除はサーバーログを出力せず、ログ設定・Ignore・Slowmode復元ジョブ・メッセージスナップショット（`message_snapshots`）の解除をcomposite cleanupとして実行するのみである（基盤§3.5のchannelDelete契約に従う）。

### Join

Embed（§8.7スタイル適用）:

| 要素 | ラベル | 内容 | 配置 |
|---|---|---|---|
| Title | — | `メンバー参加` | — |
| Color | — | 情報=青、新規アカウント警告時=黄または赤 | — |
| User | `ユーザー` | 表示名、ID | inline |
| Bot | `Bot` | Botか否か（`はい`/`いいえ`） | inline |
| Account age | `アカウント年齢` | アカウント経過期間（例: `3日`）。作成日時は表示しない | inline |
| Warning | `警告` | 新規アカウント警告。作成7日未満なら黄、24時間未満なら赤 | full width |
| RaidMode | `レイドモード` | RaidModeによるKick予定か（`予定あり`/`なし`） | inline |
| Timestamp | — | Discord Embed footer timestamp（`guildMemberAdd`ハンドラ受信時刻、§8.7） | — |

### Leave

Embed（§8.7スタイル適用）:

| 要素 | ラベル | 内容 | 配置 |
|---|---|---|---|
| Title | — | `メンバー退出` | — |
| Color | — | 灰 | — |
| User | `ユーザー` | 表示名、ID | inline |
| Tenure | `在籍期間` | 在籍期間 | inline |
| Roles | `退出時ロール` | 退出時ロール。最大20件 | full width |
| Cause | `退出理由` | Audit Log照合によるKick/Banの可能性。不明なら`自主退出または特定不能` | full width |
| Timestamp | — | Discord Embed footer timestamp（`guildMemberRemove`ハンドラ受信時刻、§8.7） | — |

### 名前変更

Embed（§8.7スタイル適用）:

| 要素 | ラベル | 内容 | 配置 |
|---|---|---|---|
| Title | — | `ユーザー名変更`、`グローバル表示名変更`、または`ニックネーム変更` | — |
| Color | — | 青 | — |
| User | `ユーザー` | 表示名、ID | inline |
| Before | `変更前` | 変更前の値 | full width |
| After | `変更後` | 変更後の値 | full width |
| Timestamp | — | Discord Embed footer timestamp（`userUpdate`または`guildMemberUpdate`ハンドラ受信時刻、§8.7） | — |

`userUpdate`は所属する全ギルドのserverlogへ送る。1ユーザーが多数ギルドにいる場合は同時実行数5で処理する。

### ロール変更

`guildMemberUpdate`でロールの付与・除去を検知した場合、ロールごとに1件のサーバーログを記録する。Mutedロールに限らずすべてのロールが対象である。旧来の`Mutedロール変更`等のMuted専用サーバーログ表示は使用しない。既存の外部MUTE/UNMUTEケースとmodlogは設定済みMutedロール遷移に対して維持し、非Mutedロールの変更はmoderation caseを作成しない。

1つのイベントで複数のロール変更がある場合、除去を先に、付与を後に、それぞれrole ID昇順の安定した順序で記録する。1件のログ送信失敗は他のロールログやケース処理を停止しない。

Embed（§8.7スタイル適用）:

| 要素 | ラベル | 内容 | 配置 |
|---|---|---|---|
| Title | — | `ロール付与`または`ロール除去` | — |
| Color | — | 付与=緑、除去=灰 | — |
| User | `ユーザー` | 表示名・ID | inline |
| Role | `ロール` | ロール名・ID | inline |
| Executor | `実行者` | 相関一致または一意なAudit executorがBotなら`Bot`。一意に確定した外部executorなら`displayName (userId)`（表示名取得不能時は`userId`のみ）。不明またはambiguousなら`不明` | inline |
| Timestamp | — | Discord Embed footer timestamp（`guildMemberUpdate`ハンドラ受信時刻、§8.7） | — |

Executor解決は遷移ごとに次の優先順位で行う。まずロール変更相関を確認し、一致した遷移はexecutor=`Bot`としてAudit照合を省略する。相関が一致しなかった遷移だけを対象に、1回のbounded retry試行ごとに**共有のAudit fetchを1回**実行し、取得したエントリ集合を全未解決遷移に適用する。1つの`MEMBER_ROLE_UPDATE`エントリは複数のロール変更を論理的に含み得る。各遷移は対象role IDとADD/REMOVE方向が一致する候補がちょうど1件かを判定し、一意に確定したexecutorだけをその遷移のexecutorとして採用する（[01-platform-and-data.md §3.5.1](01-platform-and-data.md)）。

一意に確定したexecutorが**このBot自身**である場合、設定済みMutedロールの遷移であっても外部MUTE/UNMUTEケースを作成しない。`discord_audit_log_entry_id`によるdedupeはmoderation case作成にのみ適用し、汎用ロール変更サーバーログの記録には適用しない。

## 8.11 ボイスログ

`voiceStateUpdate`を次のように分類する。

| 旧Channel | 新Channel | 種別 |
|---|---|---|
| NULL | 非NULL | Join |
| 非NULL | NULL | Leave |
| A | B、A≠B | Move |
| A | A | ログ対象外 |

Embed（§8.7スタイル適用）:

| 要素 | ラベル | 内容 | 配置 |
|---|---|---|---|
| Title | — | `ボイス参加`、`ボイス退出`、または`ボイス移動` | — |
| Color | — | 青 | — |
| User | `ユーザー` | 表示名、ID | inline |
| Channel | `チャンネル` | Join=参加先、Leave=退出元、Move=移動元・移動先と各Channel ID | inline |
| Timestamp | — | Discord Embed footer timestamp（`voiceStateUpdate`ハンドラ受信時刻、§8.7） | — |

Mute、Deafen、Streaming、Video状態変化は対象外。

## 8.12 ログ送信失敗

ログ送信失敗時:

1. 業務操作は成功のまま。
2. ケースへ`logDeliveryFailed=true`。
3. 5xx/通信失敗は最大3回再試行。
4. 403または404なら再試行しない。
5. 404なら該当ログチャンネル設定をNULLへ更新。
6. ユーザー向け結果へ`操作は成功しましたがログ送信に失敗しました`と表示。

## 8.13 Timezone

DB時刻は常にUTC。ギルドタイムゾーン（`/timezone`設定）は、以下の非ログコンテキストに限って人間可読の日時表示に使用する:

- `/timezone`設定確認時の現在時刻表示
- `/settings`の設定値表示
- インタラクション応答に含まれる日時情報（例: `/slowmode status`の復元日時）
- 予約情報やケース詳細の確認表示（コマンド応答経由）

表示形式:

```text
yyyy-MM-dd HH:mm:ss ZZZZ
```

永続チャンネルログEmbedでは人間可読の日時フィールドを一切表示しない（§8.7）。Discord Embedのfooter timestampは**Discordクライアントが閲覧者のローカルタイムゾーンでレンダリングする**ため、Bot側でギルドタイムゾーンへ変換した値を渡してはならない。Discord timestamp `<t:UNIX:F>` をログEmbedへ含めることも禁止する。

Timezone設定が不正・消失した場合はUTCへフォールバックし、設定をUTCへ修復する。

---
