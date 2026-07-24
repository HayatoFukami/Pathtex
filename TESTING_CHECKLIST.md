# Pathtex テストチェックリスト

Pathtex（Discord日本語モデレーションBot / discord.js v14 + TypeScript + Prisma/PostgreSQL）の手動動作確認用チェックリストです。専用のテストギルドで、非エンジニアでも実施できる粒度で記述しています。

調査根拠: `docs/00-common.md`〜`docs/50-tools-and-voice.md`（仕様書=正本）、`src/commands/`・`src/features/*/commands.ts`（コマンド実装）、`src/index.ts`・`src/runtime/`（イベント・スケジューラ実装）、`docs/manual-e2e-checklist.md`（既存の手動E2Eチェックリスト、本チェックリストの前身）。

## 共通事前条件

- [ ] 本番ギルドではなく、管理者が明示的に許可したテスト用Discordギルドを用意した
- [ ] Bot Token、`DATABASE_URL`、DM本文、ユーザー入力をスクリーンショットやログに残さないことを確認した
- [ ] `.env`（`DISCORD_TOKEN`、`DISCORD_CLIENT_ID`、`DATABASE_URL`、`COMMAND_SCOPE=guild`、`DEV_GUILD_ID`、`BOT_VERSION`、`MAX_BULK_TARGETS`等）が設定され、テストギルド向けに登録される
- [ ] テスト用の実行者アカウントを3種類用意した: ①サーバー管理者(Administrator) ②Moderator相当のNative権限のみ持つメンバー ③一般メンバー（管理権限なし）
- [ ] テスト対象ユーザー（一般ユーザー、Botアカウント、Botより上位ロールを持つユーザー、Guild Owner）を用意した
- [ ] テスト対象ユーザーへ、Kick/BAN/Mute/DMが発生する可能性を事前通知した
- [ ] Botの最高ロールを、検証対象ユーザー・Mutedロールより上位に配置した（上位ロール拒否テスト用に、Bot以上のロールを持つ対象も別途用意）
- [ ] テスト用のテキストチャンネル、ログ用チャンネル4種、カテゴリ、Thread、VC、対象ロールを用意した
- [ ] テストギルドの現在のVerification Level、権限上書き、招待一覧、既存設定値を記録した（復旧用）
- [ ] 短時間（10秒等）のBAN/Mute/Slowmodeを使い、検証後は解除・設定復元・ログ設定解除を必ず行う
- [ ] テスト終了後、残ったテストメンバー・招待・Mutedロール・Ignore設定・Punishment・ストライクを整理する

各項目は以下の形式で記載します。

```text
- [ ] テスト対象
  - 事前条件: 実施前に必要な状態・権限・設定
  - 手順: 具体的な操作
  - 期待結果: 正しく動作した場合に見えるはずのもの
```

---

# 1. コマンド

## 1.1 起動・コマンド登録確認

- [ ] **Bot起動シーケンス**
  - 事前条件: `COMMAND_SCOPE=guild`、`DEV_GUILD_ID`がテストギルドを指している
  - 手順: Botプロセスを起動し、起動ログを観察する
  - 期待結果: 環境変数検証→PostgreSQL接続確認→Prisma Migration適用→リソースファイル読込→Discordログイン→予約ジョブ回収→Ready受信→スケジューラ開始→イベント受付開始、の順で成功する。TokenやDB接続情報（パスワード含む）がログに出力されない
- [ ] **コマンド登録一覧確認**
  - 事前条件: Bot起動済み
  - 手順: テストギルドのコマンド一覧（Discordクライアントの`/`入力）を確認する
  - 期待結果: 仕様上の47コマンド（下記2〜8章の全コマンド）がすべて登録されている。`avatarlog`・`filter`・`resolvelinks`・`prefix`等の対象外コマンドが存在しない
- [ ] **DM実行不可**
  - 手順: BotとのDMで任意のスラッシュコマンドを実行しようとする
  - 期待結果: コマンドがDM上に表示されない、または実行できない（`contexts=[GUILD]`）
- [ ] **一般メンバーの権限不足**
  - 事前条件: 管理権限を持たない一般メンバーでログイン
  - 手順: `/setup`等の管理コマンドを実行する
  - 期待結果: 権限不足として拒否され、応答はephemeral（実行者にしか見えない）で、機密情報を含まない
- [ ] **MODロールの範囲確認**
  - 事前条件: `/modrole set`でMODロールを設定済み、そのロールを持つ実行者
  - 手順: モデレーションコマンド（例`/kick`）と設定コマンド（例`/setup`）をそれぞれ実行する
  - 期待結果: モデレーション系は実行できるが、設定系（Setup/ログ/AutoMod/Punishment等）はMODロールでは実行できずManage Guild必須のまま拒否される
- [ ] **異常系: 環境変数不正**
  - 手順: `DISCORD_TOKEN`を空にする、または`COMMAND_SCOPE=guild`で`DEV_GUILD_ID`未設定のまま起動する
  - 期待結果: Discordへ接続せず、終了コード1で終了する

## 1.2 一般コマンド（全メンバー実行可）

- [ ] **`/about`**
  - 手順: `/about`を実行する
  - 期待結果: Bot名/Avatar、`BOT_VERSION`、Node.js/discord.jsバージョン、稼働時間、接続ギルド数、キャッシュ済みユーザー数、DB上の総ケース数・総ストライク数、GitHub URL、Footer「Vortex TypeScript Reimplementation」が表示される
  - 異常系: DB統計取得に失敗する状況（DB切断等）でも他項目は表示され、統計欄のみ「取得失敗」と出る
- [ ] **`/invite`**
  - 手順: `/invite`を実行する
  - 期待結果: `bot applications.commands`スコープと設定済み権限を含むOAuth2招待リンクが、リンクボタン付きEmbedで表示される
- [ ] **`/ping`**
  - 手順: `/ping`を実行する
  - 期待結果: Interaction応答遅延、Gateway ping、DB ping（`SELECT 1`往復時間）が表示される
  - 異常系: DB接続を意図的に切ってから実行 → コマンド全体は成功し、DB欄のみ「失敗」と表示される
- [ ] **`/roleinfo role:<ロール>`**
  - 手順: 任意のロールを指定して実行する
  - 期待結果: 名前、ID、色、作成日時、ギルド内順位、メンバー数、mentionable/hoist/managed、アイコン、権限一覧、Bot最高ロールとの比較が表示される
  - 異常系: 権限が多いロールを指定 → 権限一覧が複数フィールドに分割される
- [ ] **`/serverinfo`**
  - 手順: `/serverinfo`を実行する
  - 期待結果: サーバー名/ID/アイコン、Owner、作成日時、総メンバー数・ユーザー数・Bot数、チャンネル/ロール数、Boost数・Tier、Verification Level、Explicit Content Filter、Preferred Locale、Guild Features、Vanity URLが表示される
- [ ] **`/userinfo`（対象省略）**
  - 手順: `user`オプションを省略して実行する
  - 期待結果: 実行者自身の情報（username、global display name、ID、Bot/Systemフラグ、作成日時、参加日時、Nickname、最高ロール、全ロール（先頭30件まで）、Avatar、Timeout終了日時）が表示される
- [ ] **`/userinfo user:<他ユーザー>`**
  - 手順: 他メンバーを指定して実行する
  - 期待結果: 指定した対象の情報が表示される
- [ ] **一般コマンドの言語・可視性確認**
  - 手順: 上記すべてを一般メンバーで実行する
  - 期待結果: 応答がすべて日本語で、公開表示（ephemeralでない）でも問題ない内容である

## 1.3 モデレーションコマンド

共通事前条件: 実行者はKick/Ban/Manage Roles等の対応Native権限またはMODロールを持つ。BotはKick Members/Ban Members/Manage Roles等の必要権限を保持。テスト対象ユーザーはBotより下位ロール。

- [ ] **`/kick target:<対象> reason:<理由>`（正常系）**
  - 手順: テスト対象ユーザーを指定してKickする
  - 期待結果: 対象にDM「\<guild名\>からキックされました。理由:...ケース:#...」が届いた後Kickされ、modlogにケース番号付きで「成功」と記録される
- [ ] **`/kick`異常系: 自分自身を対象**
  - 手順: 実行者自身を`target`に指定する
  - 期待結果: `TARGET_IS_SELF`として拒否される
- [ ] **`/kick`異常系: Bot自身・Guild Owner・Botより上位ロールを対象**
  - 手順: それぞれをtargetに指定する
  - 期待結果: それぞれ`TARGET_IS_BOT`/Owner拒否/`ROLE_HIERARCHY`で拒否される
- [ ] **`/kick`異常系: Bot権限不足**
  - 手順: BotのKick Members権限を一時的に外して実行する
  - 期待結果: `BOT_PERMISSION_MISSING`として、不足権限名を列挙して拒否される
- [ ] **`/kick`異常系: Member不在（ギルド未在籍ID）**
  - 手順: ギルドに存在しないユーザーIDを`additional_targets`に含める
  - 期待結果: その対象のみ`MEMBER_NOT_FOUND`で失敗、他対象の処理は継続する
- [ ] **`/ban target:<対象> duration:10s delete_messages:0 reason:時限BAN`**
  - 手順: 期間付きでBANする
  - 期待結果: BANされ、UNBAN予約が作成され、DM送信を試行し、ケースが記録される
- [ ] **`/ban`異常系: 予約中に再度期間なしBAN**
  - 事前条件: 上記の時限BANが予約中
  - 手順: 同じ対象へ`duration`なしで再度`/ban`
  - 期待結果: 解除予約が取消される（無期限BANへ変化）
- [ ] **`/ban`異常系: 既にBAN済みの対象へBAN**
  - 手順: 既にBANされている対象へ`/ban`を実行する
  - 期待結果: BAN APIは再実行されず、新規ケースが作成され`alreadyBanned=true`として成功扱いになる。予約は指定に応じて更新/取消される
- [ ] **`/silentban target:<対象>`**
  - 手順: 実行する
  - 期待結果: BANされるが、`delete_messages`オプションはなく、メッセージ削除は常に0日
- [ ] **`/softban target:<対象>`**
  - 手順: 実行する
  - 期待結果: BAN後すぐにUnbanされる（=メッセージのみ削除）。時限予約は作られない
  - 異常系: BAN成功後にUnbanが失敗する状況（権限剥奪等）→ ケースが`PARTIAL`となり、対象がBAN中であることが結果に明記される
- [ ] **`/unban user_ids:<BAN済みID>`**
  - 手順: BAN済みIDを指定する
  - 期待結果: Unban成功、対応するUNBAN予約が取消される
- [ ] **`/unban`異常系: BANされていないID**
  - 手順: BANされていないユーザーIDを指定する
  - 期待結果: `NOT_APPLIED`として対象のみ失敗する
- [ ] **`/mute target:<対象> duration:10s reason:Muteテスト`**
  - 事前条件: `/setup`実行済み（Mutedロール作成済み）
  - 手順: 実行する
  - 期待結果: Mutedロールが付与され、UNMUTE予約が作成され、DM・ケースが記録される
- [ ] **`/mute`異常系: Mutedロール未設定**
  - 事前条件: `/setup`未実行のギルド（またはロール削除後）
  - 手順: `/mute`を実行する
  - 期待結果: `/setup`実行を案内して`CONFIGURATION_MISSING`で拒否される
- [ ] **`/mute`異常系: 既にMuted**
  - 手順: 既にMutedの対象へ再度`/mute duration:...`
  - 期待結果: ロールAPIは呼ばれず（no-op）成功扱いとなり、解除予約の期間が更新される
- [ ] **`/unmute target:<対象>`**
  - 手順: Muted状態の対象を指定する
  - 期待結果: ロールが外れ、UNMUTE予約が取消される
  - 異常系: 未Mutedの対象へ実行 → ロールAPIを呼ばず冪等に成功する
- [ ] **`/reason case_number:<直前の番号> reason:更新後の理由`**
  - 手順: 直前に作成したケース番号を指定して理由を更新する
  - 期待結果: DBとmodlog Embedの「理由」フィールドが更新される
- [ ] **`/reason reason:最新ケースの理由`（case_number省略）**
  - 手順: `case_number`を省略して実行する
  - 期待結果: 理由が`NULL`/空文字/`理由未指定`のいずれかであるギルド全体の最新ケースが自動選択され更新される
  - 異常系: modlogメッセージが削除済みの状態で実行 → DB更新は成功し、警告が返る
- [ ] **`/slowmode set interval:5 duration:10s`**
  - 手順: 現在のチャンネルで実行する
  - 期待結果: Slowmodeが5秒に設定され、10秒後に元の値へ復元する予約が作成される
- [ ] **`/slowmode status`**
  - 手順: 予約中に実行する
  - 期待結果: 現在値、復元予定日時、復元予定値が表示される
- [ ] **`/slowmode off`**
  - 手順: 実行する
  - 期待結果: 値が0になり、復元予約が取消される
- [ ] **`/slowmode`異常系: 手動でSlowmode変更**
  - 事前条件: `/slowmode set`で復元予約が存在する
  - 手順: Discord UIから手動でチャンネルのSlowmode値を変更する
  - 期待結果: `channelUpdate`イベントにより復元予約が取消される
- [ ] **`/clean limit:50`（フィルタなし）**
  - 手順: 実行する
  - 期待結果: 直近の全メッセージが対象になり、件数集計（検索/一致/削除成功/失敗）が返る
- [ ] **`/clean bots:true`, `embeds:true`, `links:true`, `images:true`, `contains:<文字列>`, `regex:<正規表現>`, `user:<ユーザー>`**
  - 手順: 各フィルタをそれぞれ単独で試す
  - 期待結果: 各条件に一致するメッセージのみ削除される。複数条件を同時指定した場合はOR結合で一致する
- [ ] **`/clean`異常系: 不正な正規表現**
  - 手順: `regex`に501文字以上、空文字、コンパイル不能な文字列、後方参照/lookbehindを含む文字列を指定する
  - 期待結果: それぞれ拒否され、処理が実行されない
- [ ] **`/clean`異常系: limit範囲外**
  - 手順: `limit:1`または`limit:1001`を指定する
  - 期待結果: 拒否される（許容範囲2〜1000）
- [ ] **`additional_targets`共通異常系（kick/ban/mute等）**
  - 手順: 重複ID、`<@ID>`形式混在、21件以上、桁数不正なIDを`additional_targets`に指定する
  - 期待結果: 重複は除去される。21件超過（`MAX_BULK_TARGETS`超）や不正IDを含む場合は処理が一切開始されず、all-or-nothingで拒否される

## 1.4 ストライク・自動制裁コマンド

共通事前条件: 実行者はKick Members/Ban Members/Manage Guildのいずれか、またはMODロール。

- [ ] **`/strike target:<対象> amount:1 reason:手動ストライク`**
  - 手順: 実行する
  - 期待結果: ストライクがbefore→afterへ加算され、Strikeケース・DM・modlogが記録される
- [ ] **`/strike`異常系: ギルド外ユーザー**
  - 手順: ギルドに在籍しないユーザーIDへストライクを付与する
  - 期待結果: ストライク自体は成功するが、対応するMute/Kick等の自動制裁はMember不在のため失敗として記録される
- [ ] **`/pardon target:<対象> amount:1 reason:訂正`**
  - 手順: 実行する
  - 期待結果: `after=max(0, before-amount)`で減算され、実際の減少値が履歴・DMに反映される。過去の制裁は自動解除されない
- [ ] **`/pardon`異常系: 0までPardon済みの対象へ再度Pardon**
  - 手順: ストライク0の対象へ`/pardon`を実行する
  - 期待結果: 実効差分0のため「変更なし」として返り、履歴・ケース・DM・制裁は一切増えない
- [ ] **`/check user:<対象>`**
  - 手順: 実行する
  - 期待結果: 現在ストライク数、Muted/BAN状態、解除予定日時、次のPunishmentしきい値・Action、直近5件の履歴が表示される
  - 異常系: BAN状態取得に失敗する状況 → 他情報は表示され、BAN欄のみ「取得失敗」となる
- [ ] **`/punishment set threshold:2 action:mute duration:10s`**
  - 手順: 実行する
  - 期待結果: しきい値2でMute（10秒）が設定される。同一しきい値への再設定は上書きされる
- [ ] **`/punishment set`異常系: Kick/Softbanへduration指定**
  - 手順: `action:kick duration:10s`を指定する
  - 期待結果: `INVALID_INPUT`として拒否される
- [ ] **`/punishment set`異常系: 上限超過duration**
  - 手順: `action:mute duration:29d`（28日超過）、`action:ban duration:366d`（365日超過）を指定する
  - 期待結果: それぞれ拒否される
- [ ] **`/punishment remove threshold:<未設定のしきい値>`**
  - 手順: 存在しないしきい値を指定して削除する
  - 期待結果: `NOT_APPLIED`として拒否される
- [ ] **`/punishment list`**
  - 手順: 実行する
  - 期待結果: しきい値昇順でAction、期間、設定者、更新日時が表示される
- [ ] **複数しきい値の同時到達**
  - 事前条件: 閾値2=Mute、5=Banを設定済み、対象ストライク1
  - 手順: `/strike amount:4`で一気に5まで到達させる
  - 期待結果: 到達した中で最大のthreshold（5=Ban）のみが実行され、低い制裁（Mute）へフォールバックしない
- [ ] **しきい値到達後の追加Strike**
  - 事前条件: 直前の制裁が実行済み
  - 手順: 同じ対象へさらにストライクを加算する（thresholdを再度超えない範囲）
  - 期待結果: 同じ制裁が再実行されない
- [ ] **Pardon後の再到達**
  - 手順: Pardonでしきい値未満へ戻した後、再びしきい値へ到達させる
  - 期待結果: 制裁が再実行される

## 1.5 設定・ログコマンド

共通事前条件: 実行者はManage GuildまたはAdministrator（MODロールでは代替不可）。

- [ ] **`/setup`（初回）**
  - 手順: Mutedロール未作成のギルドで実行する
  - 期待結果: `Muted`ロールが作成され、全テキスト/フォーラムチャンネルにSend Messages等のdeny、VC/StageにSpeak denyが設定される。成功・失敗チャンネル数が表示される
- [ ] **`/setup`（再実行）**
  - 手順: 既に`/setup`済みのギルドで再実行する
  - 期待結果: 既存のMutedロールを再利用し、既存設定を破壊せず冪等に完了する
- [ ] **`/messagelog set channel:<チャンネル>`、`/modlog set`、`/serverlog set`、`/voicelog set`**
  - 手順: それぞれログ用チャンネルを設定する
  - 期待結果: Bot権限（View Channel/Send Messages/Embed Links/Read Message History）確認後に設定される。テストEmbedは自動送信されない
- [ ] **各ログの`off`**
  - 手順: `/messagelog off`等を実行する
  - 期待結果: チャンネルIDがNULLになり、ログが送信されなくなる
  - 異常系: ログ設定のみ失敗する状況でも、モデレーション等の業務操作自体は失敗扱いにならない
- [ ] **`/timezone zone:Asia/Tokyo`**
  - 手順: 実行する
  - 期待結果: 表示時刻がJSTになる（例: `/settings`表示）。DB内部の時刻はUTCのまま変更されない
- [ ] **`/timezone zone:不正な値`**
  - 手順: IANA Time Zone IDでない文字列を指定する
  - 期待結果: 拒否され、既存設定は変更されない
- [ ] **`/modrole set role:<通常ロール>`**
  - 手順: 実行する
  - 期待結果: 設定成功後、そのロールを持つメンバーがModerator権限のコマンドを実行できる
- [ ] **`/modrole set`異常系: managedロール/@everyone/Bot統合ロール**
  - 手順: それぞれを指定する
  - 期待結果: 拒否される
- [ ] **`/modrole off`**
  - 手順: 実行する
  - 期待結果: `mod_role_id`がNULLになり、MODロールでの権限昇格が無効化される
- [ ] **`/settings`**
  - 手順: 実行する
  - 期待結果: ログチャンネル、MOD/Mutedロール、Timezone、RaidMode/AutoRaid設定、AutoMod各設定、Punishment一覧、明示/自動Ignore、Bot権限不足警告が複数Embedで表示される

## 1.6 AutoMod設定コマンド

共通事前条件: 実行者はManage Guild。ストライクを発生させる機能は、有効化前にPunishmentが1件以上設定されている必要がある（無効化は常に可）。

- [ ] **`/antiinvite set strikes:1`**
  - 手順: 実行する
  - 期待結果: 設定が保存される
  - 異常系: Punishment未設定の状態で有効化しようとする → 拒否される
- [ ] **`/antiinvite off`**、**`/antireferral off`**、**`/antieveryone off`**、**`/anticopypasta off`**
  - 手順: それぞれ実行する
  - 期待結果: 対応する値が0へ戻り、無効化される（無効化はPunishment設定状態に関わらず常に成功）
- [ ] **`/maxmentions user set maximum:1`**、**`/maxmentions user off`**、**`/maxmentions role set maximum:1`**、**`/maxmentions role off`**
  - 手順: それぞれ実行する
  - 期待結果: user/role独立に上限が設定・解除される
- [ ] **`/maxlines set maximum:2`**、**`/maxlines off`**
  - 手順: それぞれ実行する
  - 期待結果: 上限設定・解除が反映される
- [ ] **`/antiduplicate set delete_threshold:2 strike_threshold:3 strikes:1`**
  - 手順: 実行する
  - 期待結果: 設定が保存される
- [ ] **`/antiduplicate off`**
  - 手順: 実行する
  - 期待結果: `duplicate_enabled=false`となるが他の値は保持される
- [ ] **`/autodehoist set character:!`**、**`/autodehoist default`**、**`/autodehoist off`**
  - 手順: それぞれ実行する
  - 期待結果: `character`は1 Unicode code pointのみ許容（結合文字・空白・英数字は確認警告付きで許可）。`default`は`!`になる
- [ ] **`/ignore role role:<ロール>`**
  - 手順: 実行する
  - 期待結果: 明示Ignoreへ追加される。既に登録済みでも成功扱い
- [ ] **`/ignore channel channel:<チャンネル/カテゴリ>`**
  - 手順: カテゴリを指定して実行する
  - 期待結果: カテゴリIDと現在配下のチャンネルIDが保存される（後から作成したチャンネルは自動で無視対象にならない）
- [ ] **`/ignore list`**
  - 手順: 実行する
  - 期待結果: 明示Ignoreロール/チャンネル、Botより上位の自動Ignoreロール、強権限による自動Ignoreロールが分離表示される
- [ ] **`/unignore role role:<ロール>`**
  - 手順: 明示登録済みロールを解除する
  - 期待結果: 解除される
- [ ] **`/unignore`異常系: 自動Ignore対象ロール**
  - 手順: Administrator等、自動Ignore条件を満たすロールを`/unignore`しようとする
  - 期待結果: 明示行があれば削除されるが「自動Ignoreは継続」と表示され、実質的なIgnoreは解除されない

## 1.7 RaidModeコマンド

- [ ] **`/raidmode on reason:手動テスト`**
  - 事前条件: 実行者がManage Guild/Kick Members/MODロールのいずれか
  - 手順: 実行する
  - 期待結果: 現在のVerification Levelを保存し、HIGH未満ならHIGHへ変更、MANUAL状態でケース・modlogが作成される
- [ ] **`/raidmode on`異常系: 既にON**
  - 手順: ON状態で再度`on`を実行する
  - 期待結果: 状態変更・ケース作成を行わず、現在状態のみ返す
- [ ] **`/raidmode status`**
  - 手順: 実行する
  - 期待結果: ON/OFF、MANUAL/AUTO、発動日時、理由、発動前Verification Level、AutoRaid設定が表示される
- [ ] **`/raidmode off`**
  - 手順: 実行する
  - 期待結果: Botが変更した場合のみ発動前Verification Levelへ復元する。管理者が手動で値を変更していた場合は上書きしない
- [ ] **`/autoraidmode on`**（10 joins/10秒）、**`/autoraidmode set joins:3 seconds:10`**、**`/autoraidmode status`**
  - 手順: それぞれ実行する
  - 期待結果: 設定が保存・表示される
- [ ] **`/autoraidmode off`**
  - 事前条件: RaidModeがON状態
  - 手順: 実行する
  - 期待結果: 自動検知のみ無効化され、現在ONのRaidModeは解除されない

## 1.8 ツール・ボイスコマンド

- [ ] **`/voicekick target:<VC接続中ユーザー>`**
  - 事前条件: 実行者がMove Members/MODロール、対象がVC接続中
  - 手順: 実行する
  - 期待結果: 一時VC経由で切断され、空になった一時VCが削除され、ケース・modlogが記録される
- [ ] **`/voicekick`異常系: VC未接続**
  - 手順: VCに接続していない対象を指定する
  - 期待結果: その対象のみ失敗する
- [ ] **`/voicemove start channel:<VC>`**
  - 手順: 実行する
  - 期待結果: Botが指定VCへ接続する
- [ ] **Botの手動移動によるVoiceMove追従**
  - 事前条件: `/voicemove start`実行済み
  - 手順: BotをDiscord UIから別VCへドラッグ移動する
  - 期待結果: 旧VCの非Botメンバーが新VCへ移動し、開始者へ結果DMが送られる
- [ ] **`/voicemove status`**
  - 手順: 実行する
  - 期待結果: 開始者、Bot現在VC、開始日時、期限が表示される
- [ ] **`/voicemove stop`**
  - 手順: セッション開始者またはModeratorが実行する
  - 期待結果: Botが切断され、セッションが終了する
- [ ] **`/voicemove start`異常系: セッション重複**
  - 事前条件: 既にセッションが存在する
  - 手順: 再度`/voicemove start`を実行する
  - 期待結果: 既存セッションは置換されず、先に`stop`が必要と案内される
- [ ] **`/voicemove start`異常系: 実行者が未接続**
  - 手順: `channel`省略かつ実行者がVC未接続の状態で実行する
  - 期待結果: 拒否される
- [ ] **`/announce channel:<チャンネル> role:<ロール> message:テスト`**
  - 手順: 実行する
  - 期待結果: 本文のみが公開送信され、指定ロールだけがメンションされる（`@everyone`等は発火しない）。送信後、ロールの元のmentionable状態が復元される
- [ ] **`/audit scope:all limit:20`**
  - 手順: 実行する
  - 期待結果: Audit Logの時刻、実行者、対象、理由、変更内容がページ形式で表示される
- [ ] **`/audit scope:from user:<対象>`**、**`/audit scope:action action:<種別>`**
  - 手順: それぞれ実行する
  - 期待結果: 条件に一致するログのみ表示される
- [ ] **`/audit`異常系: scopeと条件オプションの不一致**
  - 手順: `scope:from`で`user`を省略する、または`scope:action`で`action`を省略する
  - 期待結果: 拒否される
- [ ] **`/dehoist symbol:!`**
  - 手順: 先頭に`!`を持つニックネームのメンバーがいる状態で実行する
  - 期待結果: 先頭の連続記号が除去される。除去後空になる場合は`Dehoisted User`になる
  - 異常系: Owner・Botより上位の対象が含まれる → その対象は失敗一覧に入る
- [ ] **`/inviteprune max_uses:1`**
  - 手順: 使用数1以下の招待が存在する状態で実行する
  - 期待結果: 該当する通常招待のみ削除される。Vanity URLは対象外
- [ ] **`/lookup query:<招待URL>`**、**`/lookup query:<ユーザーID>`**、**`/lookup query:<未知の値>`**
  - 手順: それぞれ実行する
  - 期待結果: Invite/User/Guild情報が表示されるか、明確なNot Foundが表示される

---

# 2. イベント

## 2.1 メッセージイベント

- [ ] **`messageCreate`スナップショット保存**
  - 手順: テストチャンネルへ任意のメッセージを送信する
  - 期待結果: 内部的にメッセージスナップショットが保存され（削除・編集ログの基礎データになる）、AutoModが評価される
- [ ] **`messageUpdate`編集ログ**
  - 手順: 送信済みメッセージを編集する
  - 期待結果: `メッセージ編集`Embedへ変更前/変更後、投稿者、チャンネル、Jump URLが出力される。footer timestampのみで人間可読の日時フィールドはない
- [ ] **`messageUpdate`異常系: 部分ペイロード＋fetch失敗**
  - 手順: （擬似的に）本文が空の部分ペイロードとなるケースを確認する。困難な場合はコードレビューで代替可
  - 期待結果: 完全なメッセージを`fetch()`で取得できない場合、AutoModは評価されずエラーとして報告される
- [ ] **`messageDelete`削除ログ**
  - 手順: 送信済みメッセージを削除する
  - 期待結果: `メッセージ削除`Embedへ本文、添付、メッセージID、削除実行者、理由が出力される。スナップショットがない場合は「キャッシュに存在しないため取得できません」と表示される
- [ ] **`messageDeleteBulk`一括削除ログ**
  - 手順: 複数メッセージを一括削除する（Discord UIの一括削除機能等）
  - 期待結果: `メッセージ一括削除`Embed（削除件数、チャンネル、キャッシュ取得数、投稿者別件数、最大10件のプレビュー）が1件出力される
- [ ] **Bot自身のログチャンネル投稿の除外**
  - 手順: ログチャンネル内でBot自身が送信したメッセージを編集・削除する
  - 期待結果: 再帰的なログが記録されない（他Bot/Webhookの投稿は通常どおり記録される）

## 2.2 メンバー・ユーザーイベント

- [ ] **`guildMemberAdd`参加ログ**
  - 手順: テストアカウントでギルドに参加する
  - 期待結果: `メンバー参加`Embedへアカウント年齢、新規アカウント警告（該当時）、RaidMode予定有無が出力される。作成7日未満は黄、24時間未満は赤警告
- [ ] **`guildMemberAdd`Mute復元**
  - 事前条件: 対象が退出前にMuted状態だった
  - 手順: 対象が再参加する
  - 期待結果: `active_mutes`が`ACTIVE`かつ期限内ならMutedロールが再付与される。期限切れなら解除処理される
- [ ] **`guildMemberRemove`退出ログ**
  - 手順: テストアカウントがギルドから退出する
  - 期待結果: `メンバー退出`Embedへ在籍期間、退出時ロール（最大20件）、退出理由推定（Kick/Ban/自主退出）が出力される
- [ ] **`userUpdate`名前変更ログ**
  - 手順: テストアカウントのusernameまたはglobal display nameを変更する
  - 期待結果: 該当ユーザーが所属する全ギルドのserverlogへ`ユーザー名変更`/`グローバル表示名変更`Embedが送られる
- [ ] **`guildMemberUpdate`ニックネーム変更ログ**
  - 手順: サーバー内ニックネームを変更する
  - 期待結果: `ニックネーム変更`Embedへ変更前/変更後が出力される
- [ ] **`guildMemberUpdate`ロール付与・除去ログ（Bot操作）**
  - 手順: `/mute`でMutedロールを付与する
  - 期待結果: 相関一致により実行者=`Bot`として汎用ロール変更ログが出力される。設定済みMutedロール遷移のため外部MUTE/UNMUTEケースは作成されない
- [ ] **`guildMemberUpdate`ロール付与・除去ログ（Discord UI操作）**
  - 手順: Discord UIから手動でMutedロールを付与する
  - 期待結果: Audit Log照合により実行者が`displayName (userId)`で記録され、外部MUTEケースとmodlogが作成される
- [ ] **`guildMemberUpdate`非Mutedロールの変更**
  - 手順: MutedロールでないロールをDiscord UIから付与・除去する
  - 期待結果: サーバーログには`ロール付与`/`ロール除去`が記録されるが、moderation caseは作成されない
- [ ] **`guildMemberUpdate`複数ロール同時変更**
  - 手順: 1回の操作で複数ロールを同時に付与・除去する
  - 期待結果: 除去が先、付与が後、それぞれrole ID昇順の安定した順序で1件ずつ記録される
- [ ] **`guildMemberUpdate`異常系: 実行者特定不能**
  - 手順: Audit Logの照合が一意に定まらない状況（複数候補等、再現困難な場合はコードレビューで代替可）
  - 期待結果: 実行者=`不明`で記録され、moderation caseは作成されない

## 2.3 ボイスイベント

- [ ] **`voiceStateUpdate`Join/Leave/Move**
  - 手順: VCへ参加、退出、別VCへ移動する
  - 期待結果: それぞれ対応する`ボイス参加`/`ボイス退出`/`ボイス移動`Embedがvoicelogへ出力される
- [ ] **`voiceStateUpdate`対象外の変化**
  - 手順: 同一VC内でMute/Deafen/画面共有のON/OFFを行う
  - 期待結果: voicelogへの出力はない

## 2.4 BAN/Kickイベント

- [ ] **`guildBanAdd`外部BAN検知**
  - 手順: Discord UIから直接BANを実行する（Bot経由でなく）
  - 期待結果: Audit Log照合でExternalケースが作成され、内部操作と二重記録されない
- [ ] **`guildBanRemove`外部Unban検知**
  - 手順: Discord UIから直接Unbanする
  - 期待結果: 外部Unbanケースが作成され、対応するUNBAN予約が取消される
- [ ] **`guildMemberRemove`外部Kick検知**
  - 手順: Discord UIから直接Kickする
  - 期待結果: Audit Log照合で一意のKick entryと一致すればKICKケースが作成される。BANと相関する場合はKICKケースを重複作成しない

## 2.5 チャンネル・ギルドライフサイクルイベント

- [ ] **`channelCreate`Muted上書き追加**
  - 事前条件: `/setup`済み
  - 手順: 新しいテキストチャンネルを作成する
  - 期待結果: Mutedロールへの権限上書き（deny）が自動追加される
- [ ] **`channelUpdate`Slowmode相関取消**
  - 手順: 上記モデレーション章のSlowmode手動変更テストを参照
  - 期待結果: Bot起因のSlowmode変更相関では復元予約は取り消されない（相関一致時）。手動変更時は取り消される
- [ ] **`channelDelete`関連設定の無効化**
  - 手順: ログ設定チャンネルまたはIgnoreチャンネルを削除する
  - 期待結果: サーバーログは出力されないが、該当のログ設定・Ignore設定・Slowmode復元予約・メッセージスナップショットが解除される
- [ ] **`guildCreate`再参加マーカー更新**
  - 手順: （検証が難しい場合はコードレビューで代替）Botをギルドから一度Kickし、再招待する
  - 期待結果: ギルド在籍マーカーが`ACTIVE`に更新され、既存設定・ストライク・ケースが保持される
- [ ] **`guildDelete`退出マーカー更新**
  - 手順: Botをギルドからキックする
  - 期待結果: 在籍マーカーが`LEFT`となり、保持期限（退出から90日）が設定される

## 2.6 AutoModイベント処理（messageCreate/messageUpdate起点）

- [ ] **AntiInvite**
  - 事前条件: `/antiinvite set strikes:1`設定済み、Punishment設定済み
  - 手順: 他ギルドの招待リンクを投稿する
  - 期待結果: 削除1回、ストライク1回、理由・modlogが記録される
  - 異常系: 自ギルドの招待を投稿 → 許可される（違反にならない）
- [ ] **AntiReferral**
  - 手順: `/ref/`、`ref=`パラメータ付きURL、または登録済みリファラルドメインを投稿する
  - 期待結果: 削除・ストライク加算される
- [ ] **AntiEveryone**
  - 手順: 実際の`@everyone`/`@here`を投稿する（Mention Everyone権限なしの一般メンバーで）
  - 期待結果: 違反として処理される
  - 異常系: 通常文字列としての`everyone`やインラインコード`` `@everyone` `` を投稿 → 違反にならない
- [ ] **AntiCopypasta**
  - 手順: `resources/copypastas.txt`に登録済みのコピペ文を投稿する
  - 期待結果: 正規化後に一致し違反となる
- [ ] **Max User Mentions / Max Role Mentions**
  - 手順: 上限を超える人数・ロール数をメンションする
  - 期待結果: 超過分に応じたストライクが加算される（上限ちょうどは許可）
- [ ] **Max Lines**
  - 手順: 上限行数を超えるメッセージを送信する
  - 期待結果: `ceil((行数-上限)/上限)`のストライクが加算される
- [ ] **AntiDuplicate**
  - 手順: 30秒以内に同一内容のメッセージを複数回送信する
  - 期待結果: `delete_threshold`到達時点から削除、`strike_threshold`到達時点からストライク加算が始まる
- [ ] **チャンネルトピック制御**
  - 手順: チャンネルトピックに`{invites}`または`{spam}`を設定し、対応する違反を投稿する
  - 期待結果: 指定ルールのみ無効化される。AntiReferral等トピックで無効化できないルールは引き続き機能する
- [ ] **Ignore対象**
  - 事前条件: `/ignore role`または`/ignore channel`設定済み
  - 手順: Ignore対象ロール/チャンネルから違反メッセージを送信する
  - 期待結果: AutoModのみ停止する。コマンド実行・メッセージログ・サーバーログ・ボイスログは通常どおり動作する
- [ ] **複数ルール同時一致**
  - 手順: 1メッセージで複数ルール（例: 招待URL＋大量メンション）に同時一致させる
  - 期待結果: 削除は最大1回、ストライク更新は最大1トランザクション、理由が`; `区切りで連結される
- [ ] **編集による再一致**
  - 手順: 一度違反削除されたメッセージと同じルールに再度一致するよう編集する（削除後は無理な場合は別メッセージで代替）
  - 期待結果: 同じルールでのストライク二重加算は発生しない（10分TTLキャッシュ）
- [ ] **Bot/Webhook/DM投稿の除外**
  - 手順: WebhookやBotアカウントから違反相当の内容を投稿する
  - 期待結果: AutoMod対象外として処理されない

## 2.7 RaidModeイベント処理（guildMemberAdd起点）

- [ ] **AutoRaidMode発動**
  - 事前条件: `/autoraidmode set joins:3 seconds:10`設定済み
  - 手順: 10秒以内に非Botアカウントを3人参加させる
  - 期待結果: スライディングウィンドウでAUTO RaidModeが発動し、Verification LevelがHIGHへ変更され、ケース・警告modlog・解除予約が作成される
- [ ] **RaidMode中の新規参加Kick**
  - 事前条件: RaidMode発動中
  - 手順: 新規アカウントでギルドに参加する
  - 期待結果: ロックダウン通知DM送信後、最大2秒でKickされ、ケースとログが記録される
- [ ] **Bot参加の除外**
  - 事前条件: RaidMode発動中またはAutoRaid監視中
  - 手順: 別のBotアカウントを招待して参加させる
  - 期待結果: 発動判定・Kick・解除時刻延長のいずれにも影響しない
- [ ] **AutoRaid自動解除**
  - 事前条件: AUTO RaidMode発動中
  - 手順: 最後の非Bot参加から120秒以上経過するまで待つ
  - 期待結果: AUTOのみ解除され、Botが変更した場合はVerification Levelが条件付きで復元される
- [ ] **解除延長**
  - 手順: 解除予定時刻前に新しい参加を発生させる
  - 期待結果: 解除されず、最後の参加から120秒後へ予約が延長される

---

# 3. 定期タスク

- [ ] **予約ジョブ実行（UNBAN）**
  - 事前条件: 10秒後に解除される時限BANを作成済み
  - 手順: 10秒以上待機する
  - 期待結果: 5秒間隔のポーリングでジョブが検出・実行され、BANが解除され、対応するケースが記録される
- [ ] **予約ジョブ実行（UNMUTE）**
  - 手順: 10秒の時限Muteを作成し、10秒以上待機する
  - 期待結果: Mutedロールが自動解除される
- [ ] **予約ジョブ実行（RESTORE_SLOWMODE）**
  - 手順: 10秒後に復元されるSlowmodeを設定し、待機する
  - 期待結果: 元のSlowmode値へ復元される
- [ ] **予約ジョブ実行（DISABLE_RAIDMODE）**
  - 手順: AutoRaidMode発動後、無参加のまま120秒待機する
  - 期待結果: RaidModeが自動解除される
- [ ] **再起動時の予約回収**
  - 事前条件: 予約(PENDING)が存在する
  - 手順: Botを再起動する
  - 期待結果: 起動時にDBから予約を回収し、期限到達分を即時処理する。`RUNNING`のまま残っていた行は起動時に`PENDING`へ戻る
- [ ] **予約実行の直列化**
  - 手順: （コードレビューでの確認可）1 tickのdispatch実行中に次のtickが到来する状況を確認する
  - 期待結果: 次のtickはスキップされ、二重claimが発生しない
- [ ] **予約実行の再試行**
  - 手順: Discord API側で一時的なエラー（5xx等）が発生する状況を再現困難な場合はコードレビューで代替
  - 期待結果: 30/60/120/240/480秒間隔で最大5回まで再試行され、上限到達後は`FAILED`になる
- [ ] **RetentionServiceの定期掃除（既定1時間間隔）**
  - 事前条件: `MESSAGE_RETENTION_DAYS`（既定7日）を経過したメッセージスナップショットが存在する状況、または長時間の運用ログで確認
  - 手順: 保持期限を過ぎたデータの掃除を確認する（短時間で確認する場合は`MESSAGE_RETENTION_DAYS=1`等に設定してテスト）
  - 期待結果: 期限切れのメッセージスナップショット・Raid Join Event・終端Scheduled Actionがそれぞれ独立に削除される。1つの失敗が他の削除を妨げない
- [ ] **VoiceMoveセッションの自動終了（6時間経過）**
  - 手順: 長時間運用またはコードレビュー（`src/index.ts`の`voiceExpiryTimer`）で確認する
  - 期待結果: セッション開始から6時間経過すると自動終了する。再起動でも復旧しない
- [ ] **AutoDuplicate検知キャッシュの失効（30秒無操作）**
  - 手順: 重複投稿後、30秒以上何も投稿しない
  - 期待結果: `duplicateOrdinal`がリセットされ、以降は1件目としてカウントされる
- [ ] **SIGTERM時のシャットダウンシーケンス**
  - 手順: Botプロセスへ`SIGTERM`を送る
  - 期待結果: 新規Interaction受付停止→処理中タスク待機（最大15秒）→Scheduler停止→Voice接続終了→Discord Client破棄→Prisma切断→終了コード0、の順で正常終了する

---

# 4. UIコンポーネント

## 4.1 `/settings` 設定ダッシュボード（ボタン・セレクトメニュー・モーダル）

- [ ] **ホーム画面表示**
  - 手順: `/settings`を実行する
  - 期待結果: ホームページが表示され、「ログ設定」「アクセス設定」等へのナビゲーションボタンが表示される
- [ ] **ページ遷移ボタン（nav-logs / nav-access / nav-home）**
  - 手順: 各ナビゲーションボタンをクリックする
  - 期待結果: 対応するページ（ログ設定/アクセス設定/ホーム）へ遷移する
- [ ] **更新ボタン（refresh）**
  - 手順: refreshボタンをクリックする
  - 期待結果: 表示内容が最新の設定値へ更新される
- [ ] **セットアップボタン（setup）**
  - 手順: ダッシュボード上のセットアップ実行ボタンをクリックする
  - 期待結果: `/setup`コマンドと同等の処理（権限プリフライトチェック含む）が実行される
- [ ] **ログチャンネル選択（channel-message/moderation/server/voice）**
  - 手順: 各ログ種別のチャンネル選択メニューからチャンネルを選ぶ
  - 期待結果: 選択したチャンネルがそのログ種別の送信先として保存される
- [ ] **MODロール選択（role-select）**
  - 手順: ロール選択メニューからロールを選ぶ
  - 期待結果: MODロールとして設定される
- [ ] **MODロール解除（role-clear）**
  - 手順: role-clearボタンをクリックする
  - 期待結果: MODロール設定が解除される
- [ ] **Timezone設定モーダル（timezone-open → timezone-submit）**
  - 手順: timezone-openボタンをクリックしてモーダルを開き、IANA Time Zone名を入力して送信する
  - 期待結果: モーダルが開き、送信後にTimezoneが更新される
  - 異常系: 不正なTimezone文字列を入力して送信する → 拒否され、既存設定が変わらない
- [ ] **ダッシュボードの有効期限（15分TTL）**
  - 手順: `/settings`実行後15分以上経過してからボタンを操作する
  - 期待結果: 期限切れとして操作が無効になる
- [ ] **異常系: 他ユーザーによる操作**
  - 手順: `/settings`を実行したユーザー以外がダッシュボードのボタンを操作する
  - 期待結果: 実行者本人以外の操作は拒否される（Interactionの実行者IDを再検査）

## 4.2 `/audit` ページネーションボタン

- [ ] **前後ページボタン**
  - 事前条件: `/audit scope:all`を実行し、複数ページ分のログが存在する
  - 手順: 「次へ」「前へ」ボタンをクリックする
  - 期待結果: ページが切り替わり、対応するAudit Logエントリが表示される
- [ ] **異常系: 実行者以外の操作**
  - 手順: `/audit`を実行したユーザー以外がページボタンを操作する
  - 期待結果: 拒否される（本人のみ操作可能）
- [ ] **異常系: 有効期限切れ（15分経過）**
  - 手順: `/audit`実行後15分以上経過してからボタンを操作する
  - 期待結果: 操作が無効になる

---

# 5. 外部連携

Pathtexは天気・翻訳・画像生成等の外部SaaS APIとは連携せず、Discord自体のAPI（Gateway/REST/Audit Log/Invite API）を主要な外部連携先とする。加えて任意設定でSentry（エラー監視）と連携する。

- [ ] **Discord Audit Log照合（外部操作検知）**
  - 手順: 上記2.4節（外部BAN/Unban/Kick）、2.2節（外部ロール変更）のテストを実施する
  - 期待結果: bounded retry（最大3回、offset 0/500/1500ms、各limit25件、イベント時刻±5秒window）でAudit Logと照合し、一意に確定できた場合のみ外部ケースを作成する
- [ ] **Discord Invite API（AntiInvite招待コード検証）**
  - 手順: 2.6節AntiInviteのテストを実施する
  - 期待結果: 抽出した招待コードをDiscord Invite APIで検証し、自ギルド招待/他ギルド招待/無効招待を判別する
- [ ] **Discord Invite API（`/lookup`）**
  - 手順: 1.8節`/lookup`のテストを実施する
  - 期待結果: Invite URL・User ID・Guild情報をDiscord APIから取得して表示する
- [ ] **DM送信（Discord DM API）**
  - 手順: Kick/Ban/Mute/Strike/RaidMode Kick等でDM送信を確認する
  - 期待結果: DM送信に成功する。DMが閉じている等で失敗しても制裁自体は中止されない（`metadata.dmDelivered=false`が記録される）
- [ ] **Discord REST API失敗時の挙動**
  - 手順: Bot権限を一時的に外す等でDiscord API呼び出しを失敗させる（403を発生させる）
  - 期待結果: 403は再試行されず、対象単位の失敗として記録される。他対象の処理は継続する
- [ ] **Sentry連携（`SENTRY_DSN`設定時）**
  - 事前条件: `SENTRY_DSN`を設定してBotを起動
  - 手順: 意図的にアプリケーションエラーを発生させる（テスト環境限定）
  - 期待結果: Sentryへエラーが送信される。`SENTRY_DSN`未設定時はSentry送信がスキップされ、Botの動作に影響しない
- [ ] **OAuth2招待リンク生成（`/invite`）**
  - 手順: 1.2節`/invite`のテストを実施する
  - 期待結果: `DISCORD_CLIENT_ID`と`INVITE_PERMISSIONS`から正しいOAuth2 URLが生成される

---

# 6. エラーハンドリング

## 6.1 共通エラーコード

- [ ] **`INVALID_INPUT`**: オプション形式不正（例: `/clean`の不正regex、`/timezone`の不正Zone）で発生することを確認する
- [ ] **`NOT_IN_GUILD`**: DMでのコマンド実行がそもそも不可であることを1.1節で確認する
- [ ] **`NOT_AUTHORIZED`**: 権限不足の一般メンバーによる実行（1.1節）で確認する
- [ ] **`BOT_PERMISSION_MISSING`**: Bot権限を外した状態での実行（1.3節`/kick`異常系）で確認する。不足権限名が日本語で列挙されることを確認する
- [ ] **`MEMBER_NOT_FOUND`** / **`USER_NOT_FOUND`**: ギルド未在籍ID・取得不能IDを対象にしたコマンドで確認する
- [ ] **`TARGET_IS_OWNER`** / **`TARGET_IS_SELF`** / **`TARGET_IS_BOT`**: それぞれGuild Owner、実行者自身、Bot自身を対象にして確認する
- [ ] **`ROLE_HIERARCHY`**: Botまたは実行者より上位ロールの対象を指定して確認する
- [ ] **`ALREADY_APPLIED`** / **`NOT_APPLIED`**: 既にBAN済みへの重複操作、未BANへのUnban等で確認する
- [ ] **`DISCORD_API_ERROR`**: Discord API呼び出し失敗時（403/404等）に発生することを確認する
- [ ] **`CONFIGURATION_MISSING`**: Mutedロール未設定状態での`/mute`で確認する（1.3節）

## 6.2 Member/User不在の挙動

- [ ] Kick/Mute/UnmuteでMember不在 → 対象失敗になることを確認する
- [ ] Ban/SilentbanでMember不在（ギルド外ユーザーID） → User IDが有効なら続行することを確認する
- [ ] SoftbanでMember不在 → BAN可能なら続行することを確認する
- [ ] UnbanでBAN不在 → `NOT_APPLIED`になることを確認する
- [ ] Strike/Pardonでギルド外ユーザー → User取得可能なら許可されることを確認する
- [ ] Voice操作でVC未接続 → 対象失敗になることを確認する

## 6.3 冪等性

- [ ] 既BANへBAN → 成功し期間が更新されることを確認する（1.3節）
- [ ] 非BANへUnban → 失敗（`NOT_APPLIED`）になることを確認する
- [ ] 既MutedへMute → 成功し期間が更新されることを確認する
- [ ] 非MutedへUnmute → 成功（no-op）になることを確認する
- [ ] ON中にRaidMode ON → 状態表示のみでケースが増えないことを確認する
- [ ] OFF中にRaidMode OFF相当の操作 → 状態表示のみでケースが増えないことを確認する
- [ ] 削除対象メッセージが既に消失している状態で`/clean`等を実行 → 「削除済み」として成功扱いになることを確認する

## 6.4 DM失敗時の制裁継続

- [ ] **DMを閉じたユーザーへの制裁**
  - 手順: DMを受信拒否設定にしたテストアカウントに対して`/kick`または`/ban`を実行する
  - 期待結果: DM送信は失敗するが、Kick/BAN自体は実行される。`metadata.dmDelivered=false`が記録され、公開チャンネルで対象をメンションしない。DM失敗を理由に再試行しない

## 6.5 modlog送信失敗時の挙動

- [ ] **ログチャンネル権限剥奪後のモデレーション実行**
  - 手順: modlogチャンネルからBotのSend Messages権限を外した状態で`/kick`等を実行する
  - 期待結果: 業務操作（Kick）自体は成功する。結果に「操作は成功しましたがログ送信に失敗しました」と表示され、ケースへ`logDeliveryFailed=true`が記録される
- [ ] **ログチャンネル削除後の挙動**
  - 手順: modlogチャンネルを削除した状態でモデレーションコマンドを実行する
  - 期待結果: 404相当としてログ設定がNULLへ自動更新される。業務操作は成功したまま

## 6.6 Interactionの二重実行・タイムアウト

- [ ] **同一Interactionの二重送信防止**
  - 手順: 二重クリック等でコマンドを短時間に連続実行しようとする（クライアント側でボタン等を素早く連打する）
  - 期待結果: 5分TTLのInteraction ID重複排除により、同じInteractionは二重実行されない
- [ ] **3秒超過処理のdefer**
  - 手順: `/clean limit:1000`等、処理に時間がかかるコマンドを実行する
  - 期待結果: Discordの3秒タイムアウト前にdeferされ、後から結果が編集表示される

## 6.7 正規表現安全性（`/clean regex`）

- [ ] 500文字を超える正規表現 → 拒否されることを確認する
- [ ] コンパイル不能な正規表現 → 拒否されることを確認する
- [ ] 未対応の後方参照・lookbehindを含む正規表現 → 拒否されることを確認する
- [ ] 空の正規表現 → 拒否されることを確認する

## 6.8 一括処理の部分成功

- [ ] **`additional_targets`で一部対象が権限不足の場合**
  - 手順: `/kick`の`additional_targets`に、成功可能な対象と`ROLE_HIERARCHY`で失敗する対象を混在させる
  - 期待結果: 成功した対象のみ処理され、失敗した対象は個別にエラー内容が表示される。一括結果Embedに成功X/失敗Y/合計Zが表示される

## 6.9 アプリケーションログの安全性

- [ ] **機微情報の非出力確認**
  - 手順: 一連のテスト実施後、アプリケーションログ（標準出力）を確認する
  - 期待結果: Discord Bot Token、`DATABASE_URL`のpassword、DM本文、通常メッセージ全文、reason全文が出力されていない。`timestamp`/`level`/`event`/`correlationId`等の必須フィールドは出力されている

---

# 要確認事項

以下はコード・仕様書からは意図が完全には確定できなかった、または実運用でのみ確認可能なため、実施者の判断・追加確認が必要な項目です。

1. **`/settings`ダッシュボードの`setup`ボタン権限プリフライト**: `src/features/configuration/dashboard.ts`にある`setupPermissionPreflight`の詳細な表示文言・失敗時UIは、実際にDiscord上で操作して確認することを推奨します（コード上はオプショナル注入ポートとしてのみ定義されています）。
2. **`guildCreate`（Bot再参加）の実地確認**: テストギルドからBotを一度Kickして再招待する操作は影響が大きいため、チェックリストでは「困難な場合はコードレビューで代替可」としています。可能であれば専用の使い捨てテストギルドで実施してください。
3. **AutoModのFatal 401伝播（`docs/30-automod.md` §6.8.1）**: Discord Token失効等の認証エラー時にBotプロセスが安全に停止するかどうかは、実運用のトークン失効を意図的に起こすテストが困難なため、コードレビューまたはステージング環境での確認を推奨します。
4. **スケーラビリティ前提（単一プロセス・単一Shard）**: 複数プロセス化時の相関キャッシュ・VoiceMoveのRedis移行は将来対応であり、本チェックリストの対象範囲外です。
5. **Sentry連携の実際の通知先・アラート設定**: `SENTRY_DSN`を設定した場合の通知ルーティング先は運用チームの設定に依存するため、Bot側の動作確認（送信されること）のみを本チェックリストの範囲としています。

---

# サマリー

- **検出コマンド数**: 47（トップレベルスラッシュコマンド。サブコマンド・サブコマンドグループを含めると約70コマンド面）
  - 一般6 / モデレーション10 / ストライク・Punishment4 / AutoMod10 / RaidMode2 / 設定・ログ8 / ツール・ボイス7
- **検出イベント数**: 17 Gatewayイベント（`interactionCreate`、`messageCreate`、`messageUpdate`、`messageDelete`、`messageDeleteBulk`、`guildMemberAdd`、`guildMemberRemove`、`guildMemberUpdate`、`userUpdate`、`voiceStateUpdate`、`guildBanAdd`、`guildBanRemove`、`channelCreate`、`channelUpdate`、`channelDelete`、`guildCreate`、`guildDelete`）＋ハウスキーピング用`roleDelete`
- **その他の機能**: 定期タスク5種（Scheduler/UNBAN・UNMUTE・RESTORE_SLOWMODE・DISABLE_RAIDMODEの4ジョブ種別、RetentionService、VoiceMove 6時間タイマー、AutoDuplicate 30秒失効）、永続的UIコンポーネント2種（`/settings`ダッシュボード、`/audit`ページネーション）、DB永続化（PostgreSQL/Prisma、14テーブル程度）、Discord Audit Log外部連携、Sentry任意連携
- **既存自動テスト**: `tests/`配下に30ファイルのVitestユニット/統合テストが存在し、Duration parser、対象parser、権限、ロール階層、Punishmentしきい値、AutoMod各ルール、Duplicate、AutoRaidスライディングウィンドウ等の主要ロジックを既にカバーしています。本チェックリストはそれらを補完する手動E2E確認を目的としています。
