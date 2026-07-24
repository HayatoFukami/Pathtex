# 共通仕様

この文書は、すべての実装担当が必ず先に読む横断仕様である。個別機能の振る舞いは各機能仕様書に置き、ここにはプロジェクト全体の制約、実装契約、認可、障害時の共通方針、品質基準を置く。

## 読み方

1. `README.md`で担当範囲を確認する。
2. 本書と`01-platform-and-data.md`を読む。
3. 担当する機能仕様書を読む。

個別仕様と本書が矛盾する場合は、本書の「共通ルール」より個別仕様の明示的な例外を優先する。それ以外の矛盾は実装で補完せず、仕様の不整合として扱う。

以下の章番号は、移行元の仕様書との照合のため保持している。

---

# 1. 概要

## 1.1 目的

本プロジェクトは、Java/JDAで実装されたDiscordモデレーションBot「Vortex」のユーザー向け機能を、TypeScriptと最新のDiscord APIを用いて再実装するものである。

旧Vortexのプレフィックスコマンド方式は廃止し、Discordのアプリケーションコマンドへ移行する。主としてスラッシュコマンドを使用し、旧コマンドの文字列引数はUSER、ROLE、CHANNEL、INTEGER、BOOLEAN等の型付きオプションへ変換する。

再現対象は旧Javaコードの内部クラス構造ではなく、公式Wikiおよび公開ソースから確認できる外部挙動である。

## 1.2 対象機能

以下を実装対象とする。

1. 一般コマンド
2. モデレーションコマンド
3. 設定コマンド
4. AutoMod設定コマンド
5. ツールコマンド
6. ギルド・ユーザー単位のストライク
7. ストライクしきい値に基づく自動制裁
8. 手動・自動アンチレイドモード
9. メッセージ編集・削除ログ
10. ケース番号付きモデレーションログ
11. サーバーログ
12. ボイスログ
13. 時限BAN、時限Mute、時限Slowmode
14. Mutedロールの作成・維持
15. AutoMod無視ロール・チャンネル
16. `{invites}`、`{spam}`チャンネルトピック制御
17. VoiceKick、VoiceMove
18. Announce、Audit、Dehoist、InvitePrune、Lookup

サーバーログとボイスログは旧Vortex Proの機能だが、本実装では対象に含める。旧Proのその他の機能は含めない。[Vortex Pro](https://github.com/jagrosh/Vortex/wiki/Vortex-Pro)

## 1.3 対象外

以下は本実装では対象外とする。

- アバターログ
- リンクリダイレクト解決
- カスタムフィルター
- 専用Botオプション
- カスタムプレフィックス

カスタムプレフィックスは、すべてのユーザー操作をDiscord管理のアプリケーションコマンドへ移行するため不要である。

## 1.4 互換性方針

- 旧コマンド名は可能な限り維持する。
- 旧コマンドの複数ユーザー指定は、主対象USERオプションと追加ID文字列で代替する。
- 時間指定は人間可読形式を受理するが、曖昧な月・年は受理しない。
- Discord API上で完全再現できない挙動は、明示した独自補完仕様へ置き換える。
- 旧英語メッセージとの文字列一致は要求しない。
- コマンドレスポンスは日本語固定とする。
- Discord Audit Log、DM、Botのアプリケーションログも日本語を基本とする。

## 1.5 独自補完事項

公式Wikiで一意に決まらない項目は以下に固定する。

| 項目 | 採用仕様 |
|---|---|
| 既定タイムゾーン | `UTC` |
| AutoRaid自動解除 | 最後の非Bot参加試行から120秒後 |
| 一括対象数 | 最大20ユーザー（`MAX_BULK_TARGETS`で1～20へ低下可能、既定20。20が絶対上限） |
| ストライク手動増減 | 1回1～100 |
| ストライク総数 | 0～1,000,000 |
| 重複メッセージ時間窓 | 30秒 |
| AutoModの1メッセージ最大加算 | 100ストライク |
| メッセージキャッシュ | PostgreSQL、7日保持 |
| 通常Mute/Ban最大期間 | 28日 |
| 時限BAN最大期間 | 365日 |
| Slowmode最大期間 | 28日 |
| 理由省略時 | `理由未指定` |
| Embed色 | 情報=青、成功=緑、警告=黄、失敗=赤、制裁=橙 |
| Discord API失敗時 | 対象単位で成功・失敗を記録し、可能な対象を継続 |
| VoiceMove有効期間 | 6時間、再起動時は終了 |

旧Vortexの公開ソースでWikiより詳細な挙動が確認できる場合、対象範囲内では公開ソースを補助根拠として採用する。ただし、カスタムFilterやResolve Linksのような対象外機能は呼び出さない。

## 1.6 用語

| 用語 | 定義 |
|---|---|
| ギルド | Discord UI上の「サーバー」 |
| MODロール | `/modrole`で設定されたモデレーション権限代替ロール |
| Native権限 | Discord標準のKick Members、Ban Members等 |
| ケース | 1件のモデレーション操作を表す永続レコード |
| AutoMod | `messageCreate`または`messageUpdate`から自動実行される検査 |
| 時限制裁 | 指定日時に自動解除されるBAN、Mute、Slowmode |
| 操作可能 | Botの権限とロール順位の両方を満たすこと |
| Snowflake | DiscordのID。常に文字列として扱う |
| TargetIdentity | ユーザー対象の表示契約。`{ userId: string, displayName: string }`で表す |

---

## 1.7 ユーザー対象のIdentity契約

ユーザーを対象にする全機能は、Discord APIの表示名を直接持ち回らず、次の値オブジェクトへ正規化する。

```text
TargetIdentity = {
  userId: string,       // Snowflake
  displayName: string   // 表示用の名前だけ。IDを含めない
}
```

TargetIdentityの永続化およびTargetIdentity形式のmodlog描画は、明示的なuser-target actionに限る。対象は`KICK`、`BAN`、`SOFTBAN`、`SILENTBAN`、`UNBAN`、`MUTE`、`UNMUTE`、`STRIKE`、`PARDON`、`AUTO_PUNISHMENT`、RaidMode中のKick、`VOICEKICK`、および外部のユーザー操作である。RaidMode on/off、Slowmode等の非ユーザー対象ケースは、既存のtargetなし等の意味を維持する。ユーザー対象の表示は常に`displayName (userId)`とする。`displayName`へID、既に整形済みの`name (id)`、括弧付きID、メンションを保存または再利用してはならない。永続化する`moderation_cases.target_display`（[01-platform-and-data.md §4.7](01-platform-and-data.md)）にも、user-target actionのIDや整形済み値を入れず、正規化済みの名前スナップショットだけを入れる。

解決順序は次のとおりで、取得できた値を正規化し、trim後に非空かつ128 Unicode code point以内で、IDのみ・置換済みID・既成の整形値・メンションでない最初の値を`displayName`とする。条件に合わない値は候補から除外して次へ進む。数字を含む通常の名前は許可する。

1. イベント／Interactionに含まれるMemberのdisplayName
2. ギルドから取得した最新MemberのdisplayName
3. 最新Userのglobal name、なければusername
4. `guild_member_snapshots`のnickname、global name、username
5. `不明なユーザー`

UserまたはMemberの取得失敗、対象不在、Discord API失敗を含む失敗結果でも、対象が持つIDを失わず、解決できたfallback名とIDを`displayName (userId)`として応答・ログ・ケース表示する。IDしかない場合も`不明なユーザー (userId)`とする。TargetIdentityは対象解決Serviceの公開契約とし、Handlerは独自の名前fallbackを実装しない。

TargetIdentityの正規化に失敗した場合は、ケース作成前の入力／解決エラーとして扱い、その対象のケースとmodlogを作成しない。解決後にDiscord操作や予約が失敗した場合は、解決済みIdentityを必ず結果へ含める。過去のケースに保存された値は再書込みしない。

ただし、歴史的ケースの`target_display`が空白、IDのみ、整形済み値、メンション等のinvalid historical valueである場合は、文字どおり`不明なユーザー (userId)`を描画する。この履歴表示ではlive Member/Userまたはsnapshotを検索せず、DBをbackfill・rewriteしない。

## 1.8 ユーザー対象アクションマトリクス

| 領域 | 対象Identityの扱い | ケース／外部操作／予約 |
|---|---|---|
| コマンドモデレーション（Kick/Ban/Softban/Silentban/Unban/Mute/Unmute） | 各対象をTargetIdentityへ解決し、成功・失敗とも表示名とIDを返す | 対象ごとにケース。時限Ban/Muteは対応予約を作成・置換 |
| Strike/Pardon | ギルド外もUser IDを対象にTargetIdentity化 | Strike/Pardonケースと履歴。自動制裁は別ケース |
| AutoMod | メッセージ作者をTargetIdentity化 | 集約したStrike／制裁ケースへ作者のスナップショットを付与 |
| Punishment | 到達したStrike対象をTargetIdentity化 | 自動制裁ケースを作成。低い閾値へfallbackしない |
| RaidMode | 参加者をTargetIdentity化（Botは除外） | ロックダウン中Kickは対象ごとにケース |
| VoiceKick | VC参加者をTargetIdentity化 | 対象ごとにケース。VC不在もIdentity付き失敗 |
| scheduled unban/unmute | 予約payloadのuserIdと作成元ケースの保存済みIdentityを使う | 実行時に新しい`SCHEDULED`ケースを作成し、originating caseのIdentityをコピーする。originating caseは変更しない |
| 外部操作（Audit Log由来） | 一意に確定したAudit entry IDの対象だけAudit対象とsnapshotからTargetIdentity化 | `discord_audit_log_entry_id`で重複排除し、確定できた場合だけ外部ケースを1件作成。不可／曖昧ならケースなしでserver logのみ |

既存の権限・Member/User不在・部分成功・DM失敗の規則は変更しない（[§5.1.5](#5115-共通応答)、[§8.3](#83-memberuser不在)）。

## 1.9 ロール変更サーバーログの共通規則

`guildMemberUpdate`で検知したロールの付与・除去は、Mutedロールに限らずすべてのロールを対象に、ロールごとに1件のサーバーログを記録する。旧来の`Mutedロール変更`等のMuted専用サーバーログ表示は使用せず、すべてのロール変更は汎用ロール変更レコードで記録する。既存の外部MUTE/UNMUTEケースとmodlogは設定済みMutedロール遷移に対して維持する。非Mutedロールの変更はmoderation caseを作成しない。

- 1つの`guildMemberUpdate`で複数のロール変更がある場合、除去を先に、付与を後に、それぞれ安定した順序（role ID昇順）で1件ずつ記録する。
- 各レコードは対象の表示名+ID、ロール名+ID、付与/除去、executorを表示する。
- executor描画: ロール変更相関が一致、または一意なAudit executorがこのBot自身なら`Bot`。一意に確定した外部executorなら`displayName (userId)`（表示名取得不能時は`userId`のみ）。不明またはambiguousなら`不明`。
- 一意なAudit executorがBotである設定済みMutedロール遷移は、相関の有無にかかわらず外部MUTE/UNMUTEケースを作成しない。
- 遷移ごとに相関を先に確認し、相関一致遷移はAudit照合を省略する。未解決遷移だけを対象に、1回のbounded retry試行ごとに共有のAudit fetchを1回実行する（[01-platform-and-data.md §3.5.1](01-platform-and-data.md)）。
- 1件のサーバーログ送信失敗は、他のロールログやケース処理を停止しない。
- ロール変更相関キー`{guild}:{target}:{role}:{ADD|REMOVE}`は、実際のロール変更API呼び出しの直前に登録し、`guildMemberUpdate`で一致した遷移を一度消費する。API失敗時は即座に削除し、消費されなければTTL満了で失効する。ロールAPIを呼ばないno-op操作（既にMuted/既にロールなし）では相関を登録しない。
- ロール変更レーンの所有者は`MemberRoleChangeService`（または同等のcoordinator）であり、共有の`ExternalAuditPolicy`を使ってexecutorを解決する。

# 2. 技術スタック

## 2.1 正式採用

| 要素 | 仕様 |
|---|---|
| 言語 | TypeScript 5.x、`strict: true` |
| モジュール | ECMAScript Modules |
| Node.js | Node.js 24 LTS推奨、最低22.12.0 |
| Discordライブラリ | discord.js 14.26.x以上のv14系 |
| Voice | `@discordjs/voice` |
| ORM | Prisma ORM |
| DB | PostgreSQL 16以上 |
| 日時処理 | Luxon |
| 入力検証 | Zod |
| 正規表現 | RE2互換実装 |
| テスト | Vitest |
| アプリログ | Pino |
| パッケージ管理 | pnpm |
| コンテナ | Docker、Docker Compose |

discord.jsの現行v14ドキュメントはNode.js 22.12.0以上を要求するため、これを最低バージョンとする。[discord.js Documentation](https://discord.js.org/docs)

## 2.2 TypeScript設定

以下を必須とする。

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- `useUnknownInCatchVariables: true`
- `noImplicitOverride: true`
- Targetは`ES2023`以上
- Snowflakeを`number`へ変換しない
- DB・Discord境界の未検証データにはZodを適用する

## 2.3 Discord API

- Discord API v10を使用する。
- 本番コマンドはグローバル登録する。
- 開発では`DEV_GUILD_ID`へのギルドコマンドとして登録する。
- デプロイCLIはRESTのbulk overwriteで同期する。
- `COMMAND_SCOPE=global`ではGlobal Commands endpointを使用する。
- `COMMAND_SCOPE=guild`では`DEV_GUILD_ID`を必須とする。
- 同一スコープの未定義コマンドは削除する。

Discordのアプリケーションコマンドには、コマンドあたり最大25オプション、選択肢最大25、名前最大32文字等の制約がある。本仕様のコマンド定義はこれを超えてはならない。[Application Commands](https://docs.discord.com/developers/interactions/application-commands)

全コマンドについて:

- `contexts=[GUILD]`
- `integration_types=[GUILD_INSTALL]`
- DMでは利用不可
- NSFW限定にしない

## 2.4 Gateway Intents

以下を有効化する。

- `Guilds`
- `GuildMembers`
- `GuildModeration`
- `GuildMessages`
- `MessageContent`
- `GuildVoiceStates`
- `GuildInvites`

以下は不要。

- `GuildPresences`
- DM系Intent
- Reaction系Intent

`GuildMembers`と`MessageContent`はPrivileged Intentである。Developer Portalで有効化し、Discordの規模要件に達した場合は審査を受ける。MessageContentがない場合、本文・Embed・添付が空になるため、本BotのAutoModとメッセージログは正常動作しない。[Gateway Intents](https://docs.discord.com/developers/topics/gateway#gateway-intents)

起動時にIntent不足を直接検出できない場合でも、Gateway close code 4014を致命エラーとしてログ出力し、無限再接続しない。

## 2.5 Bot招待権限

推奨権限:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Manage Messages
- Kick Members
- Ban Members
- Manage Roles
- Manage Nicknames
- Manage Channels
- Manage Guild
- View Audit Log
- Connect
- Move Members
- Mention Everyone

Administratorは必須としない。各機能は実行時に必要権限だけを検査する。

Discordのロール階層により、Botは自身の最高ロール以上のユーザーをKick、Ban、Nickname変更できず、自身の最高ロール以上のロールを編集・付与できない。[Discord Permissions](https://docs.discord.com/developers/topics/permissions#permission-hierarchy)

## 2.6 データベース選定

PostgreSQLを正式採用する。SQLiteは単体テストまたは開発専用とし、本番では使用しない。

選定理由:

- ケース番号採番にトランザクションが必要
- ストライク同時更新に行ロックが必要
- 予約ジョブの排他取得が必要
- JSONBでDiscordイベントの補助情報を保存できる
- Prisma Migrationにより再現可能なスキーマ管理ができる

DBトランザクションの既定分離レベルは`READ COMMITTED`とする。ただし、ストライク更新とケース番号採番では対象行を更新ロックする。

## 2.7 デプロイ構成

正式構成:

1. `bot`コンテナ
2. `postgres`コンテナ
3. 日次DBバックアップジョブ
4. 任意でSentry等の外部監視

Botは単一プロセス、単一シャードを既定とする。PM2は使用しない。Dockerの再起動ポリシーは`unless-stopped`とする。

起動順序:

1. 環境変数検証
2. PostgreSQL接続確認
3. Prisma Migration適用
4. リソースファイル読込
5. Discord Client生成
6. Discordログイン
7. `RUNNING`のまま残った予約ジョブを回収
8. Ready受信
9. スケジューラ開始
10. イベント受付開始

SIGTERM時:

1. 新規Interaction受付停止
2. 最大15秒、処理中タスクを待機
3. Scheduler停止
4. Voice接続終了
5. Discord Client破棄
6. Prisma切断
7. 終了コード0

## 2.8 環境変数

| 変数 | 必須 | 検証 |
|---|---:|---|
| `DISCORD_TOKEN` | Yes | 空文字不可。ログへ出力禁止 |
| `DISCORD_CLIENT_ID` | Yes | 17～20桁Snowflake |
| `DATABASE_URL` | Yes | PostgreSQL URL |
| `COMMAND_SCOPE` | Yes | `global`または`guild` |
| `DEV_GUILD_ID` | 条件付 | guild時に必須 |
| `BOT_VERSION` | Yes | SemVer |
| `INVITE_PERMISSIONS` | No | decimal文字列 |
| `LOG_LEVEL` | No | 既定`info` |
| `SENTRY_DSN` | No | URL |
| `MESSAGE_RETENTION_DAYS` | No | 1～30、既定7 |
| `MAX_BULK_TARGETS` | No | 1～20、既定20。複数対象コマンド（moderation/strikes/voice）の最終対象数上限を一括で下げる。20を超えることはできず、Discord/API由来の静的上限（additional_targets最大19件・400文字等）は弱めない |
| `OWNER_USER_IDS` | No | Snowflakeのカンマ区切り |
| `INSTANCE_ID` | No | 既定はhostname＋PID |

環境変数に不正値がある場合はDiscordへ接続せず終了コード1で終了する。

---

---

## 3.2 レイヤー責務

| レイヤー | 責務 |
|---|---|
| Command/Event Handler | Discord入力の取得、defer、レスポンス |
| Service | 業務ルール、処理順、権限検査の要求 |
| Repository | Prismaによる永続化 |
| Domain | Enum、値オブジェクト、判定ロジック |
| Job | 永続予約処理 |
| Logger Service | DiscordログEmbed生成・送信 |

コマンドハンドラからPrismaを直接呼び出してはならない。モデレーション操作は必ず`ModerationService`、ストライク変更は必ず`StrikeService`を経由する。

## 3.3 コマンドハンドラ契約

各コマンドは以下を定義する。

| 項目 | 内容 |
|---|---|
| `data` | discord.jsコマンド登録定義 |
| `execute` | コマンド実行 |
| `autocomplete` | 任意 |
| `requiredBotPermissions` | Bot側の権限 |
| `authorizationPolicy` | `PUBLIC`、`MODERATOR`、`MANAGE_GUILD` |
| `guildOnly` | 常にtrue |
| `deferMode` | `NONE`、`EPHEMERAL`、`PUBLIC` |

3秒を超える可能性がある処理は、Discord API操作より前に`deferReply()`する。

原則:

- 一般情報: 通常レスポンス
- モデレーション: ephemeral
- 設定: ephemeral
- AutoMod設定: ephemeral
- ツール: ephemeral
- `/announce`で送る本体のみ公開

---

# 5. コマンド仕様一覧

## 5.1 共通コマンド設計

## 5.1.1 コマンド種別

本実装では全機能をCHAT_INPUT型のスラッシュコマンドとして実装する。

USERコマンドおよびMESSAGEコマンドは実装しない。理由は以下のとおり。

- 旧Vortexに対応する右クリック専用機能が存在しない。
- 同一機能を複数インターフェースで提供すると権限チェックと監査ログが重複する。
- 複数対象、理由、期間等はスラッシュコマンドの型付きオプションでなければ入力できない。

## 5.1.2 共通対象指定

旧コマンドで複数ユーザーを指定できたコマンドは、次のオプションを使用する。

| オプション | 型 | 必須 | バリデーション |
|---|---|---:|---|
| `target` | USER | No | 主対象 |
| `additional_targets` | STRING | No | 空白またはカンマ区切りのSnowflakeまたは`<@ID>`。最大19件、最大400文字 |

対象指定規則:

1. `target`と`additional_targets`の少なくとも一方を必須とする。
2. `additional_targets`を空白、カンマ、改行で分割する。
3. `<@123>`および`<@!123>`を`123`へ正規化する。
4. 各値は17～20桁の10進Snowflakeでなければならない。
5. `target`を先頭として重複IDを除去する。
6. 最終対象数は`MAX_BULK_TARGETS`（1～20、既定20）以下。同値は設定からコマンドパーサと対象サービス（moderation/strikes/voice）の両方へ注入され、20を超えることはできない。
7. 不正IDまたは最終対象数超過（既定では21件以上）が含まれる場合、処理を一切開始せず拒否する。
8. Kick、Mute等でMemberが必要な場合はギルドからMemberを取得する。
9. Ban、Strike等でUserだけで処理可能な場合はDiscord APIからUser取得を試みる。
10. Userを取得できないIDは、その対象だけ失敗とする。

入力意味論: Snowflake形式不正、batch token不正、または21件超過は既存どおり入力全体のall-or-nothingエラーとし、処理・ケース・modlogを開始せず、TargetIdentityも作成しない。構文上有効なSnowflakeについてMember/Userが取得不能な場合だけ、対象単位のfallback Identity（`不明なユーザー (userId)`を含む）を作成して失敗結果へ含める。

対象ごとの権限・ロール順位エラーは他対象の処理を中止しない。

## 5.1.3 時間指定

`duration`はSTRING型とし、次を受理する。

- `30s`
- `10m`
- `2h`
- `7d`
- `1w`
- `1h30m`
- `30 seconds`
- `10 minutes`
- `2 hours`
- `7 days`
- `1 week`

処理規則:

- 大文字小文字を無視する。
- 単位は秒、分、時間、日、週のみ。
- 小数、負数、0、月、年、日本語単位は拒否する。
- 複合指定では同じ単位を2回使用できない。
- 通常のMuteは1秒～28日。
- Banは1秒～365日。
- Slowmode自動解除期間は1秒～28日。
- DiscordのSlowmode間隔自体は0～21600秒。

## 5.1.4 理由

`reason`の共通仕様:

- STRING型
- 最大1000 Unicode code point
- 前後空白を除去
- 空文字は拒否
- 任意の場合、省略時は`理由未指定`
- 必須の場合、`理由未指定`という自動補完は行わない
- Discord Audit Logへ渡す文字列は、ケース番号を付けたうえで512文字以内へ切り詰める

Audit Log形式:

```text
[Vortex Case #123] 理由本文
```

## 5.1.5 共通応答

モデレーション、設定、AutoMod、ツールコマンドの受付結果は原則ephemeralとする。

一括処理結果Embed:

| 要素 | 内容 |
|---|---|
| Title | `処理結果: <操作名>` |
| Color | 全成功=緑、一部失敗=黄、全失敗=赤 |
| 成功 | `displayName (userId)`、ケース番号 |
| 失敗 | `displayName (userId)`、機械可読エラー、説明 |
| Footer | `成功 X / 失敗 Y / 合計 Z` |
| Timestamp | Discord timestamp |

25フィールドまたは6000文字を超える場合はfollow-upへ分割する。

ユーザー対象コマンドの成功・失敗を含むすべての対象結果は、このIdentity形式を使う。ただしMalformed Snowflake、件数超過等のall-or-nothing入力検証失敗は対象を確定できないため、TargetIdentityを返さず既存の入力エラーとする。構文上有効な対象が後続のMember/User解決または事前条件で失敗した場合だけ、fallback Identity付きエラーを返す。ケース作成前の失敗はケースとmodlogを作成しない。

## 5.1.6 共通エラーコード

| コード | 意味 |
|---|---|
| `INVALID_INPUT` | オプション形式不正 |
| `NOT_IN_GUILD` | ギルド内専用 |
| `NOT_AUTHORIZED` | 実行者権限不足 |
| `BOT_PERMISSION_MISSING` | Bot権限不足 |
| `MEMBER_NOT_FOUND` | Member不在 |
| `USER_NOT_FOUND` | User取得不能 |
| `TARGET_IS_OWNER` | Guild Owner |
| `TARGET_IS_SELF` | 実行者自身を対象にできない |
| `TARGET_IS_BOT` | Bot自身を対象にできない |
| `ROLE_HIERARCHY` | ロール順位不足 |
| `ALREADY_APPLIED` | 既に適用済み |
| `NOT_APPLIED` | 適用されていない |
| `DISCORD_API_ERROR` | Discord API失敗 |
| `CONFIGURATION_MISSING` | Mutedロール等の設定不足 |

---

---

# 7. 権限モデル

## 7.1 認可区分

| 区分 | 条件 |
|---|---|
| `PUBLIC` | ギルドメンバー全員 |
| `MODERATOR` | 対応Native権限、Administrator、またはMODロール |
| `MANAGE_GUILD` | Manage GuildまたはAdministrator。MODロール代替不可 |

## 7.2 Moderator判定

次の順に判定する。

1. Guild Ownerなら許可。
2. Administratorなら許可。
3. コマンド対応Native権限を持つなら許可。
4. 設定済みMODロールを持つなら許可。
5. それ以外は拒否。

MODロールが削除済みの場合、設定をNULLへ更新して拒否する。

## 7.3 Native権限対応表

| 操作 | 実行者Native権限 |
|---|---|
| Kick | Kick Members |
| Ban/Softban/Silentban/Unban | Ban Members |
| Mute/Unmute | Manage Roles |
| Strike/Pardon/Check/Reason | Kick Members、Ban Members、Manage Guildのいずれか |
| RaidMode | Manage GuildまたはKick Members |
| Clean/Slowmode/Announce | Manage Messages |
| VoiceKick/VoiceMove | Move Members |
| Audit | View Audit Log |
| Dehoist | Manage Nicknames |
| InvitePrune | Manage Guild |

## 7.4 設定系権限

次はManage GuildまたはAdministrator必須。

- Setup
- Punishment
- 各ログ設定
- Timezone
- ModRole
- Settings
- 全AutoMod設定
- Ignore/Unignore

Discordコマンド登録時にも`default_member_permissions=ManageGuild`を設定する。ただし実行時チェックを省略してはならない。

## 7.5 Bot権限

コマンド全体の開始前に、必須Bot権限を対象ギルドまたは対象チャンネルで検査する。

複数チャンネルを対象とするSetup等では、チャンネル単位で検査し、部分成功を許可する。

不足時は権限名を列挙する。

```text
Botに次の権限がありません:
- ロールの管理
- メンバーを移動
```

## 7.6 ロール階層

Botは次を操作できない。

- Guild Owner
- Bot自身
- Bot最高ロール以上のMember
- Bot最高ロール以上のRole
- managed role

実行者は原則として自身以上のMemberを制裁できない。

例外:

- Guild Ownerは実行者側の階層チェックを免除
- Bot側の階層チェックはOwnerでも免除されない
- Banで対象が既にギルド外の場合はMember階層チェック不能のためUser ID BANを許可

## 7.7 自己・Bot・Owner対象

| 対象 | Kick/Ban/Mute | Strike/Pardon |
|---|---|---|
| 実行者自身 | 拒否 | 拒否 |
| Bot自身 | 拒否 | 拒否 |
| 他Bot | 権限と順位を満たせば許可 | 許可 |
| Guild Owner | 拒否 | Strike/Pardonは許可するが自動制裁は実行不能として記録 |

## 7.8 チャンネル権限

Clean、Slowmode、Announce、ログ出力では対象チャンネルに対するBotの実効権限を使用する。ギルド全体のbase permissionだけで判定してはならない。

Threadでは親チャンネルとThread双方の権限を確認する。

---

# 8. エラーハンドリング・エッジケース

## 8.1 エラー処理原則

1. 予測可能な業務エラーは例外ではなくResult型で返す。
2. Discord API・DB・プログラム例外は捕捉して構造化ログへ記録。
3. ユーザーへStack Trace、Token、DB情報を表示しない。
4. エラーには相関IDを付与する。
5. モデレーション操作がDiscord側で成功した後にDB更新が失敗しても、逆操作でロールバックしない。
6. 復旧用の重大エラーをアプリログへ`error`で記録する。

ユーザー向け例:

```text
処理中にエラーが発生しました。
参照ID: 01J...
Discord上では操作が完了している可能性があります。modlogを確認してください。
```

## 8.2 DM失敗

DM送信失敗は制裁失敗とみなさない。

- `metadata.dmDelivered=false`
- `metadata.dmErrorCode`を保存
- modlogへ`DM通知: 失敗`
- 公開チャンネルで対象をメンションしない
- DM失敗だけを理由に再試行しない

## 8.3 Member/User不在

| ケース | 動作 |
|---|---|
| Kick/Mute/UnmuteでMember不在 | 対象失敗 |
| Ban/SilentbanでMember不在 | User IDが有効なら続行 |
| SoftbanでMember不在 | BAN可能なら続行 |
| UnbanでBAN不在 | `NOT_APPLIED` |
| Strike/Pardonでギルド外 | User取得可能なら許可 |
| Voice操作でVC未接続 | 対象失敗 |

## 8.4 冪等性

| 状態 | 動作 |
|---|---|
| 既BANへBAN | 成功、期間更新 |
| 非BANへUnban | 失敗 |
| 既MutedへMute | 成功、期間更新 |
| 非MutedへUnmute | 成功、予約取消 |
| ON中にRaidMode ON | 状態表示、ケースなし |
| OFF中にRaidMode OFF | 状態表示、ケースなし |
| 解除ジョブ対象が解除済み | COMPLETED |
| 削除対象メッセージが消失 | 削除済み成功 |

## 8.5 Discord APIエラー

| HTTP | 方針 |
|---|---|
| 400 | 再試行なし |
| 401 | 致命的認証エラー。新規処理停止 |
| 403 | 権限不足。再試行なし |
| 404 | 通常コマンドは失敗、解除ジョブは冪等成功 |
| 429 | discord.jsのRate Limit処理に従う |
| 5xx | 1、2、4秒で最大3回 |
| Network Error | 5xxと同じ |

バルク操作の同時実行数:

- 通常モデレーション: 5
- Nickname変更: 3
- 招待削除: 3
- チャンネル上書き: 3
- Voice移動: 5

## 8.6 Interactionエラー

- 3秒を超える可能性があれば先にdefer。
- defer前エラー: ephemeral reply。
- defer後エラー: editReply。
- 既にreply済み: ephemeral follow-up。
- Token失効: アプリログのみ。
- 同じInteractionを二重実行しないようInteraction IDを5分TTLで保持。
- command・component・modal・autocompleteのいずれから発生した401も、直接の`status`/`code`=401と`cause`ラップされた401の両方を致命的認証エラーとしてfatalへ伝播し、新規処理を停止する（8.5の401方針と同じ）。401以外のエラーは相関ID付きのユーザー応答またはアプリログに留める。

### 8.6.1 Interaction dedupeの容量意味（fail closed）

Interaction IDの重複排除キャッシュは有界であり、容量到達時の意味を固定する。

- 受理（accept）されたIDは、TTL（5分）の間ずっと重複として拒否され続ける。容量を作るために**期限の切れていないエントリを退避（evict）してはならない**。
- 期限切れエントリのみを古い順に削除する。期限切れを削除してもなお`maxSize`に達している場合、**新しいIDは受理せず拒否する**（fail closed）。
- fail closedとは、容量逼迫時に genuine な新規Interactionを落とす方が、TTL内の再送Interactionを二重実行するリスクより安全であるという選択である。
- したがってキャッシュは「受理済みIDのTTL保護」を常に優先し、上限はメモリ天井としてのみ機能する。

## 8.7 正規表現安全性

CleanのregexはRE2互換で実行する。

拒否条件:

- 500文字超過
- コンパイル不能
- 未対応の後方参照
- 未対応のlookbehind
- 空正規表現

JavaScript標準RegExpをユーザー入力へ直接使用してはならない。

---

# 9. 非機能要件

## 9.1 アプリケーションログ

PinoによるJSON構造化ログを標準出力へ出す。

必須フィールド:

- `timestamp`
- `level`
- `event`
- `correlationId`
- `interactionId`
- `guildId`
- `channelId`
- `userId`
- `caseId`
- `durationMs`
- `errorName`
- `discordCode`

出力禁止:

- Discord Bot Token
- DATABASE_URLのpassword
- DM本文
- 通常メッセージ全文
- ユーザー入力reason全文

reasonとメッセージ本文はログ上で先頭100文字以下に切り詰める。

## 9.2 監視

最低限のメトリクス:

- Gateway接続状態
- WebSocket ping
- コマンド件数・失敗率
- AutoMod一致数
- 制裁成功・失敗数
- DB応答時間
- Scheduler遅延
- Pending/Failed Job数
- Discord REST 429数
- ログ送信失敗数

Ready喪失5分、DB接続失敗、Failed Job増加、コマンド失敗率10%超過を警告対象とする。

## 9.3 性能

目標:

| 処理 | 目標 |
|---|---|
| 単純コマンド初期応答 | 1秒以内 |
| defer開始 | Interaction受信から2秒以内 |
| AutoMod判定 | p95 100ms以内。Discord API検査を除く |
| 設定キャッシュ取得 | p95 20ms以内 |
| Scheduler遅延 | 通常10秒以内 |
| 通常ログ送信 | イベントから5秒以内 |

## 9.4 スケーラビリティ

初期リリースは以下を前提とする。

- 単一Botプロセス
- 単一Gateway Shard
- PostgreSQL 1台
- 最大500ギルド
- 同時実行コマンド100件未満

将来の複数プロセス化に備え、SchedulerはDBロック対応とする。ただしDuplicateキャッシュ、内部操作相関、VoiceMoveはプロセスローカルであり、複数プロセス化時にはRedis等への移行が必要。

## 9.5 可用性・復旧

- コンテナ異常終了後は自動再起動。
- 予約制裁はDBから復旧。
- VoiceMoveは復旧しない。
- Duplicate検知状態は復旧しない。
- 起動時に期限超過した予約を即時処理する。
- DBバックアップは日次、7世代以上。
- Migration前にバックアップを取得する。

## 9.6 セキュリティ

- Tokenをリポジトリへ保存しない。
- `.env`をGit管理対象外とする。
- 本番DBユーザーにDB作成権限を与えない。
- Prismaのパラメータ化クエリを使用する。
- ユーザー正規表現はRE2。
- AnnouncementではAllowed Mentionsを明示。
- Embedへユーザー入力を入れる際、`@everyone`、`@here`を発火させない。
- Audit Log reasonへ制御文字を保存しない。
- Interactionの実行者IDをButton操作でも再検査する。
- Bot Owner専用の任意コード実行・SQL実行コマンドは実装しない。

## 9.7 テスト方針

### 単体テスト

必須対象:

- Duration parser
- Snowflake/複数対象parser
- PermissionService
- ロール階層判定
- Punishmentしきい値選択
- Strike/Pardon境界
- AntiInvite正規表現
- Referral URL解析
- Mention数計算
- Line数・ストライク計算
- Duplicate ordinal
- Topic制御
- Timezone検証
- Clean OR条件
- AutoRaid sliding window
- Embed文字数分割

### 統合テスト

PostgreSQL Testcontainerを使用する。

- 同時Strike加算でlost updateがない
- ケース番号が重複しない
- Scheduler排他取得
- 予約置換・取消
- Reason更新
- Guild設定削除・Channel削除整合
- Punishment到達トランザクション

### Discordモックテスト

discord.jsのInteraction、GuildMember、MessageをAdapterで抽象化し、以下を検証する。

- 権限不足
- 403/404/429/5xx
- 部分成功
- DM失敗後も制裁継続
- modlog失敗後もコマンド成功
- BAN成功・UNBAN失敗のSoftban部分失敗

### E2E

専用テストギルドで最低限以下を手動確認する。

- Setup
- Mute/Unmute
- Ban/Unban
- Slowmode復元
- メッセージ編集・削除ログ
- Voice Join/Leave/Move
- AutoRaid発動・解除
- コマンド登録権限
- 再起動後の予約復旧

## 9.8 コード品質

- ESLint、PrettierをCIで実行。
- TypeScriptコンパイルエラーを許容しない。
- テスト失敗時はDockerイメージを公開しない。
- Service層の循環依存を禁止。
- 1コマンドファイルに複数トップレベルコマンドを実装しない。
- Discord API呼び出しをRepositoryへ混在させない。

## 9.9 多言語対応

本実装では多言語対応を対象外とし、日本語固定とする。

ただし将来対応を阻害しないため、ユーザー向け文字列をコマンドロジックへ直接散在させず、`locales/ja.ts`等へ集約する。初期リリースでは日本語以外の翻訳ファイルを作成しない。

## 9.10 受け入れ基準

以下をすべて満たした場合に実装完了とする。

1. 第5章の全コマンドが登録・実行可能。
2. 対象外コマンドが登録されていない。
3. Bot再起動後も時限BAN/Mute/Slowmode予約が維持される。
4. ストライクの同時加算でデータ欠損がない。
5. Punishmentの複数しきい値到達時に最大しきい値だけ実行される。
6. AutoModの複数一致で削除が1回、ストライク更新が1回。
7. AutoRaidがスライディングウィンドウで発動する。
8. Bot参加がRaid判定・Kick対象外。
9. 四種の永続チャンネルログEmbedがfooter timestampのみで時刻を表示し、人間可読の日時フィールドを含まない。ギルドタイムゾーン設定は非ログコンテキストでのみ使用される。
10. ReasonでDBとmodlog Embedを更新できる。
11. MODロールが設定系コマンドを実行できない。
12. Botより上位のMemberへ操作できない。
13. DM失敗で制裁が中止されない。
14. 主要単体・統合テストが成功する。

---

# 10. 除外機能一覧の再確認

| 機能 | 本実装 | 除外理由 |
|---|---|---|
| アバターログ | 対象外 | Vortex Pro限定であり、指定されたPro対象はサーバーログとボイスログだけである |
| リンクリダイレクト解決 | 対象外 | Vortex Pro限定機能であり、外部URLアクセスに伴うSSRF対策等も別途必要になるため |
| カスタムフィルター | 対象外 | Vortex Pro限定かつ当時ベータ機能であり、本タスクの明示的除外対象である |
| 専用Botオプション | 対象外 | Vortex Proの運用・契約上の専用Bot機能であり、単一Applicationとして再実装するため |
| カスタムプレフィックス | 対象外 | Discordアプリケーションコマンドへ全面移行し、プレフィックス解析自体を行わないため |

## 10.1 登録禁止コマンド

次のChat Input、User、Messageコマンドを登録してはならない。

```text
avatarlog
resolvelinks
filter
prefix
```

専用Bot切替、Pro契約、Bot Token差替え等に対応するコマンドも登録しない。

## 10.2 対象外機能に関する設定・DB

対象外機能について、以下を作成してはならない。

- DBカラム
- Prisma Model
- Scheduler Job
- Gatewayイベント処理
- REST endpoint
- 管理コマンド
- Feature flag
- ダミーの「未対応」コマンド

AntiReferralとAntiInviteはHTTPリダイレクトを追跡せず、メッセージ本文に直接現れるURLだけを評価する。

## 10.3 最終スコープ

本実装で提供するログは次の4種類だけである。

1. メッセージログ
2. モデレーションログ
3. サーバーログ
4. ボイスログ

サーバーログとボイスログは旧Vortex Pro機能だが、本仕様では正式な実装対象であり、Pro契約・Feature flag・課金判定を設けず、全ギルドで設定可能とする。

---

---

## 5.7 コマンド一覧の登録確認

実装対象コマンドは次のとおり。

```text
about
invite
ping
roleinfo
serverinfo
userinfo

kick
ban
softban
silentban
unban
clean
voicekick
voicemove
mute
unmute
raidmode
strike
pardon
check
reason
slowmode

setup
punishment
messagelog
modlog
serverlog
voicelog
timezone
modrole
settings

antiinvite
anticopypasta
antieveryone
antireferral
maxmentions
maxlines
antiduplicate
autodehoist
autoraidmode
ignore
unignore

announce
audit
dehoist
inviteprune
lookup
```

次のコマンドは登録してはならない。

```text
avatarlog
filter
resolvelinks
prefix
```

専用Botオプションに対応するコマンドも登録しない。
