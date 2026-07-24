# ツール・ボイス操作仕様

対象は`/voicekick`、`/voicemove`、`/announce`、`/audit`、`/dehoist`、`/inviteprune`、`/lookup`である。

## 前提

- 認可、Bot権限、ロール階層、共通エラー処理は`00-common.md`に従う。
- VoiceMoveのメモリ内セッションは再起動で復旧しない。永続予約の扱いは`01-platform-and-data.md`に従う。

---

## 3.7 VoiceMoveセッション

VoiceMoveはメモリ内に保持する。

```text
Map<guildId, {
  controllerUserId,
  botCurrentChannelId,
  startedAt,
  expiresAt
}>
```

動作:

1. `/voicemove start`でBotが指定VCへ接続。
2. Bot自身が別VCへ移動されたことを`voiceStateUpdate`で検出。
3. Botの旧VCに残るメンバー一覧をスナップショット化。
4. 非Botメンバーを新VCへ移動。
5. 同時実行数5。
6. 成功・失敗件数を開始者へDMする。DM失敗時はアプリログのみ。
7. Bot切断、`/voicemove stop`、6時間経過、再起動で終了。

セッションは永続化しない。Botの移動ではなく単なる切断の場合、メンバー移動を行わない。

---

## 5.3.15 `/voicekick`

共通対象のみ。理由オプションは持たない。最終対象数は`00-common.md`の共通対象規則と`MAX_BULK_TARGETS`（1～20、既定20）に従う。`additional_targets`の静的上限（最大19件・400文字）は設定によらず弱まらない。注入された上限はコマンドパーサとVoiceServiceの両方で強制され、VoiceServiceは上限超過を対象解決（Discordアクセス）前にall-or-nothingで拒否する。空の対象一覧も同様にDiscordアクセス前に拒否する。

認可: Move MembersまたはMODロール  
Bot権限: Move Members、Manage Channels、View Channel

処理:

1. 各対象の現在VCを確認。
2. 対象VCと同一カテゴリに一時VCを作成。
3. 対象を一時VCへ移動。
4. 全対象処理後、一時VCを削除。
5. 削除に失敗した場合、空チャンネルを再度1回削除する。
6. ケースとmodlogを対象ごとに作成。

VC未接続対象は失敗とする。

## 5.3.16 `/voicemove`

### `/voicemove start`

| オプション | 型 | 必須 |
|---|---|---:|
| `channel` | VOICE_CHANNEL | No |

省略時は実行者の現在VC。実行者が未接続なら拒否。

認可: Move MembersまたはMODロール  
Bot権限: Connect、Move Members、View Channel

既存セッションがある場合は置換せず、先に`stop`を要求する。

### `/voicemove stop`

現在のセッションを終了しBotを切断する。セッション開始者またはModeratorのみ実行可能。

### `/voicemove status`

開始者、Bot現在VC、開始日時、期限を表示する。

---

---

## 5.6 ツールコマンド

## 5.6.1 `/announce`

| オプション | 型 | 必須 |
|---|---|---:|
| `channel` | TEXT_CHANNEL | Yes |
| `role` | ROLE | Yes |
| `message` | STRING 1～2000 | Yes |

認可: Manage MessagesまたはMODロール  
Bot権限: View Channel、Send Messages、Mention Everyone。ロールを一時編集する場合はManage Roles。

処理:

1. 対象ロールがmentionableか確認。
2. falseでBotがMention Everyoneを持たない場合、ロール順位を確認し一時的にtrueへ変更。
3. `<@&roleId> message`を送信。
4. `allowedMentions.roles=[roleId]`とし、ユーザー・everyone解析は無効化。
5. `finally`で元のmentionableへ戻す。
6. 送信成功・復元失敗時は警告を返す。

## 5.6.2 `/audit`

| オプション | 型 | 必須 |
|---|---|---:|
| `scope` | choice `all/from/action` | Yes |
| `user` | USER | scope=from時 |
| `action` | STRING autocomplete | scope=action時 |
| `limit` | INTEGER 1～100 | No、25 |

認可: View Audit LogまたはMODロール  
Bot権限: View Audit Log

`scope`と条件オプションが一致しない場合は拒否する。

1ページ最大10件。各項目:

```text
[時刻] ACTION
実行者: name (id)
対象: type / name / id
理由: reason
変更: key: old → new
```

前後Buttonは実行者本人のみ操作可能、有効期限15分。モバイル表示を考慮しコードブロックは使用せず、Embed descriptionへ短い項目として表示する。

## 5.6.3 `/dehoist`

| オプション | 型 | 必須 |
|---|---|---:|
| `symbol` | STRING | No、既定`!` |

認可: Manage NicknamesまたはMODロール  
Bot権限: Manage Nicknames

対象はeffective display nameが指定symbolで始まるMember。先頭の連続symbolを除去し、空になる場合は`Dehoisted User`とする。新Nicknameは32文字以内。

Owner、Botより上位、自身のNicknameを変更できないMemberは失敗一覧へ入れる。同時実行数3。

## 5.6.4 `/inviteprune`

| オプション | 型 | 必須 |
|---|---|---:|
| `max_uses` | INTEGER 0以上 | No、既定1 |

認可: Manage GuildまたはMODロール  
Bot権限: Manage Guild

`uses <= max_uses`の通常招待を削除する。

対象外:

- Vanity URL
- 取得できない招待
- Guild Widget等、招待オブジェクトでないリンク

削除同時実行数3。コード、作成者、使用回数を結果へ表示する。

## 5.6.5 `/lookup`

| オプション | 型 | 必須 |
|---|---|---:|
| `query` | STRING 2～200 | Yes |

全員が実行可能。

判定順:

1. Invite URLを正規化
2. Invite codeとして取得
3. SnowflakeならUser取得
4. Userが404ならGuild Preview取得
5. 全失敗でNot Found

Invite URLとして受理:

- `discord.gg/<code>`
- `discord.com/invite/<code>`
- `discordapp.com/invite/<code>`

User表示:

- username
- global name
- ID
- Bot
- アカウント作成日
- Avatar

Invite/Guild表示:

- Guild名・ID
- Description
- Icon
- Invite code
- 招待先チャンネル
- 概算メンバー数・オンライン数
- Verification
- Boost
- Guild Features

Botが参加していない非公開ギルドをIDだけで取得できない場合は、Discord API制約として次を表示する。

> このギルドはIDだけでは公開情報を取得できません。有効な招待コードを指定してください。

## 5.6.6 ユーザー対象ツールのIdentity

`/voicekick`の対象は、処理前にVC状態とMember/User snapshotを取得し、`00-common.md §1.7–1.8`のTargetIdentityで結果・ケース・modlogへ表示する。VC未接続、移動失敗、一時VC作成／削除失敗でもfallback名とIDを省略しない。

`/audit`の実行者・対象表示も同じ解決順序を使う。Audit取得不能時を含め、IDがある場合は`不明なユーザー (userId)`とし、Audit Log由来のモデレーションケースは`40-configuration-and-logs.md §8.9.1`の外部ID dedupeとsnapshot-before-deleteに従う。`/lookup`のUser表示は取得時点のlive値であり、ケースの`target_display`へ再利用してはならない。

---
