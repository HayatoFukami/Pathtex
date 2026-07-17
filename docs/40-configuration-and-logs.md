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

## 8.8 メッセージログ

### 8.8.1 編集ログ

`messageUpdate`で本文、添付、Embedのいずれかが変化した場合に記録する。DiscordによるEmbed展開だけの更新で本文・添付・主要Embed情報が同一なら記録しない。

Embed:

| 要素 | 内容 |
|---|---|
| Title | `メッセージ編集` |
| Color | 黄 |
| Author | 投稿者名、ID、Avatar |
| Channel | メンションとID |
| Before | 編集前内容 |
| After | 編集後内容 |
| Attachments | 追加・削除一覧 |
| Message | Jump URL |
| Timestamp | ギルドTimezone |

Discord Embedのフィールド上限を超える本文は各1000文字以内へ切り詰め、末尾に`…`を付ける。完全本文をファイル添付する機能は実装しない。

### 8.8.2 削除ログ

Embed:

- Title: `メッセージ削除`
- 投稿者名・ID
- チャンネル
- 本文
- 添付URL
- Message ID
- 削除実行者
- 削除理由
- 作成日時
- 削除検知日時

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

messageDeleteBulkは1イベントにつき1つの概要Embedとする。

- 削除件数
- チャンネル
- 実行者
- キャッシュ取得件数
- 投稿者別件数
- 最大10件の本文プレビュー

AutoModまたはCleanによる削除は内部相関情報から理由を表示する。

## 8.9 モデレーションログ

全ケースはmodlog設定の有無にかかわらずDBへ保存する。

Embed共通構成:

| 要素 | 内容 |
|---|---|
| Title | `Case #N — ACTION` |
| Color | Action別 |
| Target | 表示名、ID |
| Moderator | 表示名、ID |
| Reason | 理由または`理由未指定` |
| Duration | 期間または`Permanent` |
| Source | Command、AutoMod、Punishment、RaidMode、External |
| Status | Completed、Failed、Partial |
| DM | 成功・失敗・対象外 |
| Timestamp | ギルドTimezone |
| Footer | Case ID |

Action色:

- Kick/Mute/Strike: 橙
- Ban/Softban/Silentban: 赤
- Unban/Unmute/Pardon: 緑
- RaidMode ON: 赤
- RaidMode OFF: 緑
- Failed: 灰

外部操作はAudit Logから実行者と理由を取得する。対応する内部相関がある場合は二重ケースを作らない。

## 8.10 サーバーログ

出力対象:

- Member Join
- Member Leave
- Username変更
- Global Display Name変更
- Guild Nickname変更

### Join

表示:

- User名・ID
- Botか
- アカウント作成日時
- アカウント年齢
- 参加日時
- 新規アカウント警告。作成7日未満なら黄、24時間未満なら赤
- RaidModeによるKick予定か

### Leave

表示:

- User名・ID
- 参加日時
- 在籍期間
- 退出時ロール。最大20件
- Audit Log照合によるKick/Banの可能性
- 不明なら`自主退出または特定不能`

### 名前変更

Before/Afterを表示する。`userUpdate`は所属する全ギルドのserverlogへ送る。1ユーザーが多数ギルドにいる場合は同時実行数5で処理する。

## 8.11 ボイスログ

`voiceStateUpdate`を次のように分類する。

| 旧Channel | 新Channel | 種別 |
|---|---|---|
| NULL | 非NULL | Join |
| 非NULL | NULL | Leave |
| A | B、A≠B | Move |
| A | A | ログ対象外 |

Embed:

- User名・ID
- Join: 参加先
- Leave: 退出元
- Move: 移動元・移動先
- 各Channel ID
- ギルドTimezoneのTimestamp

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

DB時刻は常にUTC。表示時だけギルド設定Timezoneへ変換する。

表示形式:

```text
yyyy-MM-dd HH:mm:ss ZZZZ
```

併せてDiscord timestamp `<t:UNIX:F>`をEmbedへ含めてよい。Timezone設定が不正・消失した場合はUTCへフォールバックし、設定をUTCへ修復する。

---
