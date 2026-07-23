# AutoMod仕様

対象はAutoMod設定コマンド（AutoRaidModeを除く）、Ignore、メッセージイベントからのルール評価、違反の集約、削除である。

## 前提

- ストライク加算後のPunishment判定と制裁は`21-strikes-and-punishments.md`に委譲する。
- AutoRaidMode設定・参加イベント処理は`31-raidmode.md`に委譲する。
- メッセージログの出力仕様は`40-configuration-and-logs.md`に従う。

---

## 5.5 AutoMod設定コマンド

全コマンドでManage Guildを必須とする。

AntiInvite等、ストライクを発生させる機能を有効化する場合、Punishment設定が0件なら拒否する。無効化は常に許可する。

対象ルール:

- 固定ストライク系（AntiInvite・AntiReferral・AntiEveryone・AntiCopypasta）のいずれかへ正の値を設定
- Max User Mentions / Max Role Mentions / Max Lines へnull以外の値を設定
- AntiDuplicate の `duplicateEnabled=true`

## 5.5.1 固定ストライク系

以下は`set`と`off`を持つ。

| コマンド             | setオプション            |
| -------------------- | ------------------------ |
| `/antiinvite set`    | `strikes:INTEGER 1～100` |
| `/antireferral set`  | `strikes:INTEGER 1～100` |
| `/antieveryone set`  | `strikes:INTEGER 1～100` |
| `/anticopypasta set` | `strikes:INTEGER 1～100` |

`off`は対応する値を0へ設定する。

## 5.5.2 `/maxmentions`

サブコマンドグループ:

- `/maxmentions user set maximum:<1～100>`
- `/maxmentions user off`
- `/maxmentions role set maximum:<1～100>`
- `/maxmentions role off`

`maximum`と同数までは許可し、`maximum+1`から違反とする。

## 5.5.3 `/maxlines`

- `/maxlines set maximum:<INTEGER 1～500>`
- `/maxlines off`

## 5.5.4 `/antiduplicate`

### `set`

| オプション         | 型             | 必須 | 既定 |
| ------------------ | -------------- | ---: | ---- |
| `strike_threshold` | INTEGER 2～20  |  Yes | —    |
| `delete_threshold` | INTEGER 2～20  |   No | 2    |
| `strikes`          | INTEGER 1～100 |   No | 1    |

両しきい値は独立する。例えばdelete=2、strike=4なら2件目以降を削除し、4件目以降の各重複へストライクを付与する。

### `off`

`duplicate_enabled=false`とし、他値は保持する。

## 5.5.5 `/autodehoist`

- `/autodehoist set character:<STRING>`
- `/autodehoist default`
- `/autodehoist off`

`character`はUnicode code pointでちょうど1文字。結合文字列、空白、英数字は許可するが確認警告を表示する。`default`は`!`。

---

## 5.5.7 `/ignore`

### `/ignore role role:<ROLE>`

明示Ignoreへ追加。既に存在する場合は成功扱い。

### `/ignore channel channel:<CHANNEL>`

Guild内チャンネルまたはカテゴリを追加する。カテゴリを指定した場合、カテゴリ配下を動的に無視するのではなく、カテゴリID自体と現在配下のチャンネルIDを保存する。後から作成されたチャンネルは自動無視しない。

### `/ignore list`

以下を分離表示:

- 明示Ignoreロール
- 明示Ignoreチャンネル
- Botより上位の自動Ignoreロール
- 強権限による自動Ignoreロール

## 5.5.8 `/unignore`

- `/unignore role role:<ROLE>`
- `/unignore channel channel:<CHANNEL>`

次のロールは自動Ignoreのため解除不可。

- Bot最高ロール以上
- Administrator
- Ban Members
- Manage Messages
- Kick Members
- Manage Guild

明示設定が存在しても、自動Ignore条件が残る場合は明示行を削除したうえで「自動Ignoreは継続」と返す。

---

---

# 6. オートモデレーション処理フロー

## 6.1 対象イベント

AutoModは次のイベントで実行する。

- `messageCreate`
- `messageUpdate`

次は対象外とする。

- DM
- Bot投稿
- Webhook投稿
- Discord System Message
- AutoMod処理中に削除済みとなったメッセージ
- Botが本文を取得できないメッセージ
- ログ出力先チャンネル内でBot自身が送信したログ

`messageUpdate`では編集後本文を検査する。部分オブジェクトの場合は`fetch()`して完全なMessage取得を試み、取得不能ならAutoModを実行しない。

## 6.2 全体処理順

`messageCreate`または`messageUpdate`受信後、以下の順序で処理する。

1. イベント対象確認
2. メッセージスナップショット保存
3. ギルド設定取得
4. Member取得
5. 全体Ignore判定
6. チャンネルトピック制御判定
7. 各AutoModルール評価
8. 違反理由・ストライク数集約
9. メッセージ削除
10. ストライク付与
11. Punishment評価・実行
12. モデレーションログ出力
13. メッセージスナップショット状態更新
14. アプリケーションログ出力

1件のメッセージに複数ルールが一致しても、メッセージ削除APIは最大1回、ストライク更新トランザクションも最大1回とする。

## 6.3 Ignore判定

次の順序で判定し、いずれかに該当した時点でAutoMod全体を終了する。

1. `automod_settings`が存在しない
2. 全AutoMod機能が無効
3. Bot/Webhook/System Message
4. Member取得不能
5. Guild Owner
6. Botが対象Memberを操作できない
7. 対象Memberが自動Ignoreロールを保持
8. 対象Memberが明示Ignoreロールを保持
9. メッセージチャンネルが明示Ignore
10. スレッドの親チャンネルが明示Ignore
11. 親カテゴリが明示Ignore

自動Ignoreとなるロール:

- Botの最高ロール以上
- Administrator
- Ban Members
- Manage Messages
- Kick Members
- Manage Guild

Memberが対象チャンネルでManage Messagesを持つ場合も自動Ignoreとする。

IgnoreはAutoModのみに適用する。コマンド実行可否、メッセージログ、サーバーログ、ボイスログには影響しない。これは旧Vortex Wikiの仕様と一致する。[Ignoring Roles and Channels](https://github.com/jagrosh/Vortex/wiki/Ignoring-Roles-and-Channels)

## 6.4 チャンネルトピック制御

通常テキストチャンネルでは自身のtopic、スレッドでは親チャンネルのtopicを参照する。比較時は小文字化する。

| Topic文字列 | 無効化するルール                                     |
| ----------- | ---------------------------------------------------- |
| `{invites}` | AntiInvite                                           |
| `{spam}`    | AntiEveryone、AntiCopypasta、MaxLines、AntiDuplicate |
| 両方        | 上記すべて                                           |

次はtopic指定では無効にならない。

- AntiReferral
- Max User Mentions
- Max Role Mentions
- AutoRaidMode
- AutoDehoist

Topic中の文字列は完全一致ではなく部分一致でよい。例えば`Rules {invites}`も有効。

## 6.5 ルール評価順序

以下の順序で全ルールを評価する。

1. AntiInvite
2. AntiReferral
3. AntiEveryone
4. AntiCopypasta
5. Max User Mentions
6. Max Role Mentions
7. Max Lines
8. AntiDuplicate

カスタムFilterとResolve Linksは対象外のため呼び出さない。

各ルールは次の結果を返す。

| フィールド      | 型          | 内容                     |
| --------------- | ----------- | ------------------------ |
| `rule`          | Enum        | ルール識別子             |
| `matched`       | BOOLEAN     | 一致したか               |
| `deleteMessage` | BOOLEAN     | 削除要求                 |
| `strikes`       | INTEGER     | 加算要求                 |
| `reason`        | STRING      | 人間可読理由             |
| `evidence`      | JSON        | 件数、コード、ドメイン等 |
| `warning`       | STRING/NULL | API検査失敗等            |

## 6.6 複数違反の集約

全ルール評価後:

1. `matched=true`の結果だけを収集する。
2. 0件なら終了する。
3. `deleteMessage=true`が1件以上なら削除を1回実行する。
4. 各ルールのストライク数を合計する。
5. 合計が100を超える場合は100へ丸める。
6. 合計が0ならStrikeServiceを呼ばない。
7. 理由は判定順に`; `で連結する。
8. modlog metadataへ全ルールの証拠を保存する。
9. 削除失敗でもストライクは付与する。
10. ストライク付与失敗でもメッセージ削除をロールバックしない。

同一メッセージの編集で同じルールが再度一致した場合、`messageId + rule`をキーとする10分TTLキャッシュを確認する。

- 既にストライク付与済み: 削除は実行してよいが同ルールのストライクは再加算しない
- 新しいルールに一致: 新しいルール分だけ加算
- Bot再起動後: キャッシュは消失するため再加算の可能性を許容する

## 6.7 ルール別仕様

### 6.7.1 AntiInvite

検出対象:

- `discord.gg/<code>`
- `discord.com/invite/<code>`
- `discordapp.com/invite/<code>`
- `discord dot gg/<code>`
- `discord(.)gg/<code>`
- URLの前後・区切りに空白を挟む既知の難読化

Invite codeは2～32文字の英数字、ハイフン、アンダースコアとして抽出する。

抽出後:

1. Discord Invite APIで取得を試みる。
2. 現在のギルドへの招待なら許可。
3. 他ギルドへの招待なら違反。
4. 無効・期限切れ・取得不能コードは違反。
5. 同一メッセージに複数招待があっても、設定値1回分だけ加算。
6. URLリダイレクト先の解決は行わない。

理由例:

```text
Discord招待リンクの投稿
```

### 6.7.2 AntiReferral

次のいずれかを検出する。

- URL path中の`/ref/`
- Queryまたはfragment中の`ref=`
- `referrer=`
- `referral=`
- `resources/referral_domains.txt`に含まれるドメイン

URL解析:

- `http://`または`https://`だけをURLとして扱う
- hostnameを小文字化
- 末尾ドットを削除
- 国際化ドメインはASCII/Punycodeへ正規化
- サブドメインは登録ドメインとのsuffix一致を許可
- リダイレクト追跡はしない

1メッセージにつき設定値1回分を加算する。

### 6.7.3 AntiEveryone

対象者がメッセージチャンネルでMention Everyone権限を持つ場合、このルールだけをスキップする。

検出:

- 実際の`@everyone`
- 実際の`@here`
- 名前が大文字小文字を無視して`everyone`または`here`であるメンション可能ロールへの実メンション

次は違反にしない。

- 通常文字列としての`everyone`
- 通常文字列としての`here`
- 完全な1行インラインコードの`` `@everyone` ``
- 実際にはメンションされていないロール名

### 6.7.4 AntiCopypasta

`resources/copypastas.txt`を起動時に読み込む。ファイル欠損時はBotの起動を続行するがAntiCopypastaを実行不能とし、設定画面に警告を出す。

本文正規化:

1. Unicode NFKC
2. 小文字化
3. Zero-width文字除去
4. 連続空白を1個へ
5. 前後空白削除

各コピペ定義は以下を持つ。

```text
name
requiredPhrases[]
optionalPhrases[]
minimumOptionalMatches
```

`requiredPhrases`がすべて含まれ、optional一致数がしきい値以上なら違反。

### 6.7.5 Max User Mentions

Discord MessageのmentionsコレクションからユニークUser IDを数える。

除外:

- 投稿者自身
- Botユーザー
- 同じUserの重複メンション

`count > maximum`の場合:

```text
strikes = count - maximum
```

例: maximum=10、ユニーク対象13人なら3ストライク。

### 6.7.6 Max Role Mentions

実際にMessageへ記録されたユニークRole IDを数える。`@everyone`はRole Mentions件数に含めない。

```text
strikes = roleCount - maximum
```

上限以下なら違反なし。

### 6.7.7 Max Lines

行数:

```text
content.split(/\r\n|\r|\n/).length
```

空本文は1行。末尾改行も追加の空行として数える。

`lineCount > maximum`の場合:

```text
strikes = ceil((lineCount - maximum) / maximum)
```

例:

| 上限 | 行数 | ストライク |
| ---: | ---: | ---------: |
|   10 |   10 |          0 |
|   10 |   11 |          1 |
|   10 |   20 |          1 |
|   10 |   21 |          2 |
|   10 |   30 |          2 |

### 6.7.8 AntiDuplicate

比較用内容:

1. メッセージ本文
2. 添付ファイル名
3. Embed title/description
4. Unicode NFKC
5. 小文字化
6. Zero-width文字削除
7. 連続空白を1個へ
8. 前後空白削除

正規化結果が空の場合は重複検査しない。

同一ギルド・同一ユーザーについて:

- 直前メッセージと同一
- 前回から30秒以内

の両方を満たす場合、`duplicateOrdinal`を1加算する。それ以外は1へ戻す。

判定:

- `ordinal >= deleteThreshold`: 削除
- `ordinal >= strikeThreshold`: 設定ストライク付与
- しきい値は「N件目を含む」

delete thresholdへ初めて到達した場合、同一ユーザー・同一チャンネル・直近2分の同一正規化内容を持つ先行メッセージも削除候補とする。ただし先行メッセージ削除による追加ストライクは発生させない。

## 6.8 メッセージ削除

削除前にAutoMod違反情報をメモリへ保存し、`messageDelete`イベントで通常削除ログと関連付ける。

削除API結果:

| 結果                | 処理                           |
| ------------------- | ------------------------------ |
| 成功                | 続行                           |
| Unknown Message     | 削除済みとして続行             |
| Missing Permissions | ストライク処理は続行、警告記録 |
| その他4xx           | 再試行なし                     |
| 5xx/通信失敗        | 最大2回再試行                  |

AutoModによる削除もmessagelogへ出力する。ExecutorはBot、理由は一致ルール名とする。

## 6.8.1 Fatal 401伝播規則

AutoMod処理中のDiscord API呼び出し（メッセージ削除、一括削除、ストライク付与、AutoDehoist、Member取得、Invite取得）でHTTP 401またはDiscord code 401を検出した場合、そのエラーは警告やフォールバックとして吸収せず、`isUnauthorized`共有分類子で判定して直ちに再送出する。cause-wrapped（`error.cause.status === 401`または`error.cause.code === 401`）も含む。

再送出された401はlogging pipelineを経由してgateway fatalハンドラへ到達し、プロセスの停止処理を開始する。

401以外のエラー（403 Missing Permissions、5xx、通信失敗等）は既存の警告・再試行・フォールバック语义を維持する。

Runtime adapterの`getMember`はDiscord code 10007（Unknown Member）のみを不在（null）として扱い、`getInvite`はDiscord code 10006（Unknown Invite）のみを不在として扱う。403 Missing Permissions・5xx・通信失敗を含むその他のエラーはnullへ縮退させず、401と同様に再送出する。再送出されたエラーはlogging pipelineの`isUnauthorized`判定を経て、401ならgateway fatal、それ以外は構造化エラーログ（警告パス）へ到達する。

## 6.9 AutoModの対象Identity

違反メッセージ作者を処理開始時に`00-common.md §1.7`のTargetIdentityへ解決する。メッセージ削除前に作者のMember/User情報をsnapshot-before-deleteし、作者取得や削除が失敗しても`displayName (userId)`を保持する。集約StrikeとPunishmentのケースは`21-strikes-and-punishments.md §6.9.5`に従い、modlogは保存済みケースからレンダリングする。Webhook等の既存対象外規則は変更しない。
