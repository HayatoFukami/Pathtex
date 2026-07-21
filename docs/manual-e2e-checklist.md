# 手動E2Eチェックリスト（テストギルド）

専用のDiscordテストギルドで、リリース候補のBotを実際に確認するためのチェックリストです。実施日・実施者・Botバージョンを記録し、失敗した項目は再現手順と相関IDを残してください。

## 1. 事前準備・安全確認

- [ ] 本番ギルドではなく、管理者が明示的に許可したテストギルドで実施する
- [ ] Bot Token、`DATABASE_URL`、DM本文、ユーザー入力をスクリーンショットやログへ残さない
- [ ] テスト用の実行者（管理者、Moderator、一般メンバー）と対象ユーザー（通常ユーザー、Bot、上位ロール）を用意する
- [ ] テスト対象ユーザーへ、Kick/BAN/Mute/DMが発生することを事前通知する
- [ ] Botの最高ロールを、検証対象ユーザー・Mutedロールより上に置く（別途、上位ロール拒否テスト用の対象も用意）
- [ ] テスト用のテキストチャンネル、ログチャンネル、カテゴリ、Thread、VC、対象ロールを用意する
- [ ] 失敗時に復旧できるよう、テストギルドのVerification Level、権限上書き、招待、設定値を記録する
- [ ] `/setup`、設定変更、RaidMode、AutoMod、制裁の実施時刻を控える
- [ ] 短時間のBAN/Mute/Slowmodeを使い、終了後に必ず解除・設定復元・ログ設定解除を行う
- [ ] テスト終了後に残ったテストメンバー、招待、Mutedロール、Ignore設定、Punishment、ストライクを整理する

## 2. 起動・コマンド登録

- [ ] 開発設定では`COMMAND_SCOPE=guild`と`DEV_GUILD_ID`が対象テストギルドを指している
- [ ] TokenやDB接続情報が起動ログに出ていない
- [ ] 起動時に環境変数検証、DB接続、Migration、リソース読込、Discordログインがこの順で成功する
- [ ] `Ready`後にスケジューラとイベント受付が開始される
- [ ] Gateway Intent（Members、Messages、Message Content、Voice States、Invites等）の不足がない
- [ ] テストギルドへ全対象コマンドが登録され、旧プレフィックスコマンドは存在しない
- [ ] 登録されている対象コマンドを確認する：
  `about` `invite` `ping` `roleinfo` `serverinfo` `userinfo`、
  `kick` `ban` `softban` `silentban` `unban` `clean` `voicekick` `voicemove` `mute` `unmute` `raidmode` `strike` `pardon` `check` `reason` `slowmode`、
  `setup` `punishment` `messagelog` `modlog` `serverlog` `voicelog` `timezone` `modrole` `settings`、
  `antiinvite` `anticopypasta` `antieveryone` `antireferral` `maxmentions` `maxlines` `antiduplicate` `autodehoist` `autoraidmode` `ignore` `unignore`、
  `announce` `audit` `dehoist` `inviteprune` `lookup`
- [ ] `avatarlog`、`filter`、`resolvelinks`、`prefix`およびPro契約用コマンドが登録されていない
- [ ] DMでコマンドを実行できず、ギルド内コマンドの応答は仕様どおり（一般情報以外は原則ephemeral）である
- [ ] 一般メンバーで設定・モデレーション・ツール系を実行すると権限不足になり、機密情報を含めずephemeralで返る
- [ ] MODロールでModerator系は実行できるが、設定系（Setup、ログ、AutoMod、Punishment等）は実行できない

## 3. 一般コマンド

- [ ] `/ping` — Interaction遅延、Gateway ping、DB pingが表示される。DB欄だけ失敗しても全体は成功する
- [ ] `/about` — Bot名、バージョン、Node.js/discord.js、稼働時間、接続ギルド数、統計、GitHub URLが表示される
- [ ] `/invite` — `bot applications.commands`と設定済み権限を含むOAuth2リンクがボタンで表示される
- [ ] `/roleinfo role:<ロール>` — ID、順位、人数、権限、managed/mentionable/hoist、Bot最高ロールとの比較が表示される
- [ ] `/serverinfo` — ギルド、Owner、メンバー内訳、チャンネル・ロール、Boost、Verification等が表示される
- [ ] `/userinfo` — 自分を省略指定でき、指定ユーザーのID、名前、参加日時、ロール、Avatar等が表示される
- [ ] 一般コマンドの応答が日本語で、通常メンバーにも公開して問題ない内容である

## 4. 設定・ログ

- [ ] `/setup` — `Muted`ロールを作成または再利用し、テキスト・フォーラム・VC/Stageへ必要なdenyを設定する
- [ ] `/setup` — 成功・失敗チャンネル数が表示され、再実行で既存設定を破壊せず冪等に完了する
- [ ] `/messagelog set channel:<ログ>`、`/modlog set`、`/serverlog set`、`/voicelog set` — 権限確認後に設定され、テストEmbedを勝手に送信しない
- [ ] `/settings` — ログ、MOD/Mutedロール、Timezone、RaidMode、AutoMod、Punishment、Ignore、Bot権限警告が表示される
- [ ] `/timezone zone:Asia/Tokyo` — 表示時刻が変更され、DB時刻はUTCのままである
- [ ] `/timezone zone:不正値` — 拒否され、既存設定が変わらない
- [ ] `/modrole set role:<通常ロール>` → Moderator権限での実行を確認 → `/modrole off`
- [ ] managedロール、`@everyone`、Bot統合ロールを`/modrole set`すると拒否される
- [ ] 各ログで`off`を実行すると設定が解除される。ログ設定だけの失敗で業務操作自体は失敗扱いにならない

## 5. モデレーション・ケース

各操作で、実行結果が対象ごとの成功/失敗、ケース番号、理由、DM結果を含み、modlogに`ケース #N`が一度だけ記録されることを確認する。

- [ ] `/kick target:<テスト対象> reason:手動テスト` — DM後にKickされ、ケースとmodlogの状態が「成功」になる
- [ ] `/ban target:<対象> duration:10s delete_messages:0 reason:時限BAN` — BAN、UNBAN予約、DM、ケースを確認する
- [ ] 予約中に同じ対象を期間なしで`/ban` — 解除予約が取消される
- [ ] `/silentban` — BANされるがメッセージ削除日数は常に0である
- [ ] `/softban` — BAN後すぐにUnbanされ、時限予約は作られない
- [ ] `/unban user_ids:<BAN済みID>` — Unban成功と予約取消を確認する
- [ ] `/unban user_ids:<BANされていないID>` — `NOT_APPLIED`として対象だけ失敗する
- [ ] `/mute target:<対象> duration:10s reason:Muteテスト` — Mutedロール、UNMUTE予約、DM、ケースを確認する
- [ ] `/unmute target:<対象>` — ロールが外れ、予約が取消される。未Muteでも冪等成功する
- [ ] `/reason case_number:<直前の番号> reason:更新後の理由` — DBとmodlogの「理由」フィールドが更新される
- [ ] `/reason reason:最新ケースの理由` — ケース番号省略でも対象を正しく選ぶ
- [ ] `/slowmode set interval:5 duration:10s` → `status` — 現在値、復元日時、復元値が表示される
- [ ] 予約後に`/slowmode status`を確認し、時間到達後に元の値へ復元される
- [ ] `/slowmode off` — 値が0になり、復元予約が取消される
- [ ] `/clean limit:...` — 条件なし、`bots`、`embeds`、`links`、`images`、`contains`、`regex`、ユーザー条件をそれぞれ試し、OR条件・件数集計・一括削除ログを確認する
- [ ] `/clean`の不正regex、空regex、501文字以上regex、limit範囲外が拒否される
- [ ] 自分自身、Bot自身、Owner、Botより上位の対象は仕様どおり拒否され、他対象の処理は継続する
- [ ] `additional_targets`の重複、mention形式、21件超、不正IDを確認し、不正時は一切処理を開始しない

## 6. ストライク・自動制裁

- [ ] `/strike target:<対象> amount:1 reason:手動ストライク` — before/after、Strikeケース、DM、modlogを確認する
- [ ] `/check user:<対象>` — 現在値、Muted/BAN状態、解除日時、次のしきい値、直近5履歴が表示される
- [ ] `/pardon target:<対象> amount:1 reason:訂正` — 0未満にならず、実際の減少値が履歴・DMに反映される
- [ ] 0までPardonした後に再度Pardon — 「変更なし」となり、履歴・ケース・DM・制裁が増えない
- [ ] `/punishment set threshold:2 action:mute duration:10s`、`threshold:5 action:ban duration:10s`を設定し、`list`と`remove`を確認する
- [ ] 複数しきい値を一度に越えるStrike — 到達した最大thresholdの制裁だけが実行され、低い制裁へフォールバックしない
- [ ] しきい値到達後の追加Strike — 同じ制裁を再実行しない
- [ ] Pardonでしきい値未満へ戻した後の再到達 — 制裁が再実行される
- [ ] Strikeケースと自動制裁ケースが別番号でmodlogに出る。DM失敗を再現できる場合も制裁は継続する

## 7. AutoMod

事前にPunishmentを1件以上設定し、テスト後に全ルールをoffへ戻す。メッセージ送信者・チャンネルを変えてIgnoreも確認する。

- [ ] `/antiinvite set strikes:1` → 他ギルド招待・無効招待を投稿 — 削除1回、ストライク1回、理由とmodlogを確認する
- [ ] 自ギルドの招待は許可され、URLリダイレクトを追跡しない
- [ ] `/antireferral set strikes:1` → `/ref/`、`ref=`、対象ドメインURL — 削除・加算を確認する
- [ ] `/antieveryone set strikes:1` → 実際の`@everyone`/`@here` — 違反。通常文字列やコード表記は違反にならない
- [ ] `/anticopypasta set strikes:1` → リソースに該当するコピペ — 正規化後に違反となる
- [ ] `/maxmentions user set maximum:1` と role版 — 上限ちょうどは許可、超過分だけストライクになる
- [ ] `/maxlines set maximum:2` — 2行は許可、3行以上は仕様の計算で削除・加算される
- [ ] `/antiduplicate set delete_threshold:2 strike_threshold:3 strikes:1` — 30秒以内の同一内容を送り、2件目から削除、3件目から加算を確認する
- [ ] `/autodehoist set character:!` → 対象メンバーの名前変更 — 先頭記号が除去される。`default`と`off`も確認する
- [ ] `/ignore role role:<ロール>`、`/ignore channel channel:<チャンネル>`、`list`、`unignore` — 明示Ignoreと自動Ignoreを分けて表示する
- [ ] Administrator等の自動Ignoreロールは`unignore`できず、「自動Ignore継続」と表示される
- [ ] Ignore対象ではAutoModだけが停止し、コマンド・メッセージログ・サーバーログ・ボイスログは停止しない
- [ ] チャンネルtopicに`{invites}`、`{spam}`を設定すると指定ルールだけ無効になる。AntiReferral等は無効にならない
- [ ] 1メッセージで複数ルールに一致 — 削除は最大1回、ストライク更新は最大1トランザクション、理由は集約される
- [ ] 同じメッセージを編集して再一致 — 同じルールのストライクは二重加算されず、削除・新規ルール検出は仕様どおり
- [ ] Bot、Webhook、System、DM、ログチャンネルのBot投稿はAutoMod対象外である
- [ ] 各ルールの確認後、`off`または設定解除し、通常投稿が削除・加算されないことを確認する

## 8. RaidMode・参加イベント

- [ ] `/raidmode on reason:手動テスト` — Verification Levelを保存し、必要ならHIGHへ変更、MANUAL状態・ケース・modlogを確認する
- [ ] `/raidmode status` — ON/OFF、MANUAL/AUTO、発動日時、理由、発動前Level、AutoRaid設定が表示される
- [ ] ON中に再度`on` — 状態・ケースを重複作成しない
- [ ] `/raidmode off` — Botが変更した場合だけ発動前Verification Levelへ戻す。手動変更された値は上書きしない
- [ ] `/autoraidmode set joins:3 seconds:10` → `status` — 設定が表示される
- [ ] 短時間に非Botのテスト参加を閾値まで発生させる — sliding windowでAUTO RaidModeが発動し、HIGH化、ケース、警告modlog、解除予約を確認する
- [ ] RaidMode中の非Bot参加 — DM後にKickされ、対象ごとのケースとserver/modlogが出る
- [ ] Bot参加 — AutoRaid判定、Kick、解除時刻延長のいずれにも影響しない
- [ ] 最後の非Bot参加から120秒以上経過 — AUTOだけが解除され、Verification Levelが条件付きで復元される
- [ ] 解除前に新しい参加を発生させる — 解除されず、最後の参加から120秒後へ予約が延長される
- [ ] `/autoraidmode off` — 自動検知だけを止め、現在ONのRaidModeは解除しない

## 9. ツール・ボイス

- [ ] `/announce channel:<チャンネル> role:<ロール> message:テスト` — 本文だけが公開送信され、指定ロールだけがmentionされる。`@everyone`等は発火しない
- [ ] announce後、ロールの元のmentionable状態が復元される
- [ ] `/audit scope:all limit:...`、`from`、`action` — Audit Logの時刻、実行者、対象、理由、変更が表示され、ページボタンは実行者本人だけ操作できる
- [ ] `/dehoist symbol:!` — 連続する先頭記号を除去し、空名は`Dehoisted User`になる。Owner・上位対象は失敗一覧になる
- [ ] `/inviteprune max_uses:1` — 使用数が1以下の通常招待だけ削除され、コード・作成者・使用数が表示される。Vanity URLは対象外
- [ ] `/lookup query:<招待URL>`、ユーザーID、未知の値 — Invite/User/Guild情報または明確なNot Foundが表示される
- [ ] `/voicekick target:<VC接続中ユーザー>` — 一時VC経由で切断され、空の一時VCが削除され、ケース・modlogが出る
- [ ] VC未接続ユーザーへの`/voicekick` — 対象だけ失敗する
- [ ] `/voicemove start channel:<VC>` → Botの移動 — 旧VCの非Botメンバーが新VCへ移動し、開始者へ結果DMが送られる
- [ ] `/voicemove status`、`stop` — 開始者・現在VC・期限を確認し、stopでBotが切断される
- [ ] VoiceMoveのセッションは再起動で復旧せず、単なるBot切断ではメンバー移動が発生しない

## 10. イベント・ログ確認

- [ ] メッセージ送信後に編集 — `メッセージ編集`Embedへ変更前/変更後、投稿者、チャンネル、Jump URLが出る。人間可読の日時フィールドはなく、footer timestampのみである
- [ ] メッセージ削除 — `メッセージ削除`Embedへ本文、添付、メッセージID、削除実行者、理由が出る。キャッシュなしは取得不能表示になる。人間可読の日時フィールドはない
- [ ] 複数メッセージを一括削除 — `メッセージ一括削除`Embed、削除件数、チャンネル、キャッシュ取得数、投稿者別件数、最大10件のプレビューになる。footer timestampのみで人間可読の日時はない
- [ ] メンバー参加・退出 — serverlogへアカウント年齢、在籍期間、ロール、退出理由推定が出る。人間可読の参加日時・退出日時はなく、footer timestampのみである
- [ ] username、global name、nicknameを変更 — 「変更前」「変更後」がserverlogへ出る
- [ ] VCへJoin、Leave、AからBへのMove — それぞれ対応するvoicelogが出る。同一VC内のMute/Deafen等は出ない
- [ ] 外部BAN/Unban/KickをDiscord UIから実施 — Audit Log照合でExternalケースが作られ、内部操作と二重記録されない
- [ ] modlog未設定でもケースが保存され、ログチャンネルを削除・権限不足にした場合は業務操作成功とログ送信失敗が分離される
- [ ] 全ログEmbedがfooter timestampのみで時刻を表示し、人間可読の日時フィールドやギルドタイムゾーンに依存した表示がない。ギルドタイムゾーン設定（`/timezone`）はログEmbedに影響しない（§8.13）
- [ ] アプリログにtimestamp、level、event、correlationId、interactionId、guildId等があり、Token・パスワード・本文全文・reason全文がない

## 11. 予約処理・再起動

- [ ] 10秒BAN、10秒Mute、Slowmode復元、AUTO Raid解除を作成し、予約がPENDINGとして扱われることを確認する
- [ ] 予約実行後にBAN解除、Mutedロール解除、Slowmode復元、RaidMode解除とケース/状態更新を確認する
- [ ] 予約実行前にBotを再起動する — DBから予約を回収し、期限到達分を処理する
- [ ] 再起動中に`RUNNING`だった予約が起動時に回収され、二重実行されない
- [ ] 期限切れ予約は起動後に即時処理され、既に解除済み・404は冪等成功になる
- [ ] 再起動後も時限BAN/Mute/Slowmode予約は維持される
- [ ] VoiceMoveセッション、AutoDuplicate状態は再起動後に復旧しない
- [ ] SIGTERM時に新規Interaction停止、処理待機、Scheduler停止、Voice切断、Discord/DB切断が行われ、終了コード0になる

## 12. 記録テンプレート

```markdown
## 手動E2E実施記録

- 実施日/時刻（JST）:
- 実施者:
- Botバージョン / commit:
- テストギルドID:
- DB・環境識別子（秘密情報を除く）:
- 結果: PASS / PASS（一部注記） / FAIL

### 失敗・注記
- チェック項目:
- 再現手順:
- 期待結果:
- 実際の結果:
- 相関ID / ケース番号:
- スクリーンショット・ログの保存先（秘密情報なし）:

### 後片付け
- [ ] BAN/Mute/Strike/Punishmentを解除
- [ ] Slowmode/Verification Level/RaidModeを復元
- [ ] AutoMod/Ignore/ログ設定を整理
- [ ] テスト用招待・ロール・チャンネル・メンバーを整理
```
