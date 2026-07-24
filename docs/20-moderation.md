# モデレーション仕様

対象は`/kick`、`/ban`、`/silentban`、`/softban`、`/unban`、`/mute`、`/unmute`、`/reason`、`/slowmode`、`/clean`である。

## 前提

- 認可、Bot権限、ロール階層、共通対象指定、理由、時間指定、ケース記録は`00-common.md`に従う。
- ケース・予約・内部操作相関・メッセージスナップショットは`01-platform-and-data.md`に従う。
- `/strike`、`/pardon`、`/check`および自動制裁は`21-strikes-and-punishments.md`の担当とする。

---

## 5.3 モデレーションコマンド

## 5.3.1 `/kick`

| オプション | 型 | 必須 |
|---|---|---:|
| `target` | USER | 条件付 |
| `additional_targets` | STRING | 条件付 |
| `reason` | STRING | No |

認可: Kick MembersまたはMODロール  
Bot権限: Kick Members

対象ごとの処理:

1. Memberを取得。
2. Owner、Bot自身、実行者自身、ロール順位を検査。
3. ケースを`PENDING`で作成。
4. Kick前DMを送信する。
5. `member.kick()`を実行。
6. ケースを`COMPLETED`または`FAILED`へ更新。
7. modlogを送信。

DM:

```text
<guild名> からキックされました。
理由: <reason>
ケース: #<number>
```

## 5.3.2 `/ban`

| オプション | 型 | 必須 | 制約 |
|---|---|---:|---|
| 共通対象 | — | Yes | 最大20（`MAX_BULK_TARGETS`で低下可能） |
| `duration` | STRING | No | 最大365日 |
| `delete_messages` | INTEGER | No | 0～7日、既定7 |
| `reason` | STRING | No | 最大1000 |

認可/Bot権限: Ban Members

処理:

1. Userを取得。
2. Memberが存在する場合はロール順位を検査。
3. Owner、Bot自身を拒否。
4. ケース作成。
5. DM送信を試行。
6. `deleteMessageSeconds=delete_messages×86400`でBAN。
7. durationありならUNBAN予約を作成。
8. durationなしなら既存UNBAN予約を取消。
9. modlog送信。

既にBAN済みの場合:

- BAN APIの再実行は行わない。
- durationありなら予約を更新。
- durationなしなら解除予約を取消。
- 新規ケースは作成し、metadataへ`alreadyBanned=true`を保存。
- 結果は成功扱い。

## 5.3.3 `/silentban`

オプションは`/ban`と同じ。ただし`delete_messages`は持たず、常に`deleteMessageSeconds=0`とする。

旧Vortexの「メッセージ削除を行わないBAN」に対応する。

## 5.3.4 `/softban`

| オプション | 型 | 必須 |
|---|---|---:|
| 共通対象 | — | Yes |
| `delete_messages` | INTEGER 0～7 | No、既定7 |
| `reason` | STRING | No |

認可/Bot権限: Ban Members

処理:

1. BAN前検査・DM。
2. 指定日数のメッセージ削除を伴うBAN。
3. BAN成功後、直ちにUnban。
4. BAN成功・Unban失敗の場合はケースを`PARTIAL`とし、対象がBAN中であることを結果へ明記。
5. 時限予約は作成しない。
6. 既存UNBAN予約があれば取消。

BAN APIとUnban APIの間に固定待機時間を設ける必要はない。APIレート制限はdiscord.jsへ委譲する。

## 5.3.5 `/unban`

| オプション | 型 | 必須 |
|---|---|---:|
| `user_ids` | STRING | Yes |
| `reason` | STRING | No |

`user_ids`は1～20件（`MAX_BULK_TARGETS`で上限を低下可能）のSnowflake。USERオプションは使用しない。上限は重複除去後の最終件数に適用する。つまり重複IDで上限を超えても、重複除去後に上限以下であれば受理する。

認可/Bot権限: Ban Members

対象ごとにBAN情報を取得し、BAN済みの場合だけUnbanする。成功時に該当UNBAN予約を取消する。BANされていない対象は`NOT_APPLIED`で失敗とする。

## 5.3.6 `/mute`

| オプション | 型 | 必須 |
|---|---|---:|
| 共通対象 | — | Yes |
| `duration` | STRING | No、最大28日 |
| `reason` | STRING | No |

認可: Manage RolesまたはMODロール  
Bot権限: Manage Roles

処理:

1. `muted_role_id`を確認。
2. ロール不存在なら`/setup`を案内して拒否。
3. Member、ロール順位、Ownerを検査。
4. DM送信。
5. 既にMutedロールを保持している場合はロールAPIを呼ばず、相関も登録しない（no-op）。それ以外の場合、ロール変更相関`guildId:targetId:mutedRoleId:ADD`を実際のロール付与API呼び出しの直前に登録し、Mutedロール付与。API失敗時は相関を即座に削除する。
6. durationありならUNMUTE予約を置換。
7. durationなしなら既存予約を取消。
8. ケース・modlog作成。

既にMutedの場合も成功扱いとし、期間指定があれば解除予約を更新する。

## 5.3.7 `/unmute`

| オプション | 型 | 必須 |
|---|---|---:|
| 共通対象 | — | Yes |
| `reason` | STRING | No |

認可/Bot権限はMuteと同じ。

既にMutedロールがない場合はロールAPIを呼ばず、相関も登録しない（no-op）。それ以外の場合、ロール変更相関`guildId:targetId:mutedRoleId:REMOVE`を実際のロール削除API呼び出しの直前に登録し、Mutedロールを削除する。API失敗時は相関を即座に削除する。既存UNMUTE予約を取消する。既にロールがない場合も冪等成功とする。

---

## 5.3.11 `/reason`

| オプション | 型 | 必須 |
|---|---|---:|
| `reason` | STRING 1～1000 | Yes |
| `case_number` | INTEGER 1以上 | No |

認可: Strikeと同じ。

case省略時:

1. `reason IS NULL`
2. 空文字
3. `理由未指定`

のいずれかであるギルド全体の最新ケースを検索する。モデレータによる絞り込みは行わない。

更新後、modlogメッセージが取得できれば「理由」フィールドを編集する。メッセージ消失時もDB更新は成功とし、警告を返す。

---

## 5.3.13 `/slowmode`

認可: Manage MessagesまたはMODロール  
Bot権限: Manage Channels

### `/slowmode set`

| オプション | 型 | 必須 |
|---|---|---:|
| `interval` | INTEGER 0～21600 | Yes |
| `duration` | STRING | No、最大28日 |

現在チャンネルのみ対象。durationありの場合、変更前のSlowmode秒数をpayloadへ保存し、RESTORE_SLOWMODEを予約する。

### `/slowmode off`

現在値を0へ設定し、予約を取消する。

### `/slowmode status`

現在値、予約復元日時、復元予定値を表示する。

予約中に人間がSlowmodeを変更した場合、`channelUpdate`で予約を取消する。ただしBot自身の変更は内部相関キャッシュで除外する。

## 5.3.14 `/clean`

| オプション | 型 | 必須 | 既定 |
|---|---|---:|---|
| `limit` | INTEGER 2～1000 | No | 100 |
| `bots` | BOOLEAN | No | false |
| `embeds` | BOOLEAN | No | false |
| `links` | BOOLEAN | No | false |
| `images` | BOOLEAN | No | false |
| `user` | USER | No | — |
| `user_id` | STRING | No | — |
| `contains` | STRING 1～500 | No | — |
| `regex` | STRING 1～500 | No | — |

認可/Bot権限: Manage Messages

検索条件はORで結合する。フィルターが1つもない場合は取得した全メッセージが対象。これは旧Clean仕様の「各パラメータを個別実行した場合と同じ」という挙動を再現する。[Cleaning Messages](https://github.com/jagrosh/Vortex/wiki/Cleaning-Messages)

判定:

- `bots`: BotまたはWebhook投稿
- `embeds`: Embedが1件以上
- `links`: `http://`、`https://`、`www.`
- `images`: 画像/動画添付、画像/動画Embed
- `contains`: Unicode case-fold後の部分一致
- `regex`: RE2検索
- `user`/`user_id`: author ID一致

処理:

1. 100件単位で過去メッセージを取得。
2. `limit`件まで評価。
3. 14日未満を100件単位でbulk delete。
4. 14日以上を1件ずつ削除。
5. 同時実行数3。
6. 成功・既削除・失敗を集計。

最終レスポンス:

```text
検索: X件
一致: Y件
削除成功: Z件
失敗: N件
```

## 5.3.17 対象Identityとケース表示

user-target commandは`00-common.md §1.7–1.8`のTargetIdentity解決を使う。MemberをKick/Mute等で変更する前にMember/User情報をsnapshot-before-deleteし、成功・失敗を問わず結果は`displayName (userId)`で表示する。user-target caseとmodlogは[01-platform-and-data.md §4.7](01-platform-and-data.md)の保存済みsnapshotから描画し、後日のDiscord API取得結果で過去のケース表示を変えない。Slowmode等の非ユーザー対象コマンドは既存のAction固有descriptorとケース意味を維持する。

Unbanは既存どおりID入力を使用するが、IDから解決したfallback名を含むTargetIdentityを失敗結果にも付ける。時限UNBAN/UNMUTEは、予約の作成元ケースを変更せず、実行時にTargetIdentityをコピーした`SCHEDULED`ケースを新規作成する。新しいケースsourceの追加は既存ケースを壊さないadditive migrationとする。
