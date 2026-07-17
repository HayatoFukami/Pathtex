# RaidMode仕様

対象は`/raidmode`、`/autoraidmode`、参加急増の検知、ロックダウン中の参加者処理、AutoRaidModeの自動解除である。

## 前提

- 状態、参加履歴、予約ジョブ、ケースは`01-platform-and-data.md`に従う。
- 認可・ロール階層・Kick実行の共通規則は`00-common.md`および`20-moderation.md`に従う。

---

## 5.3.12 `/raidmode`

### `/raidmode status`

オプションなし。認可はModerator。

表示:

- ON/OFF
- MANUAL/AUTO
- 発動日時
- 理由
- 発動前Verification Level
- AutoRaid設定

### `/raidmode on`

| オプション | 型 | 必須 |
|---|---|---:|
| `reason` | STRING | No |

認可: Manage Guild、Kick Members、またはMODロール  
Bot権限: Manage Guild、Kick Members

処理:

1. 現在Verification Levelを保存。
2. HIGH未満ならHIGHへ上げる。
3. RaidModeをMANUALとして有効化。
4. 既存Auto解除ジョブを取消。
5. ケースとmodlogを作成。

既にONなら状態変更・ケース作成を行わず、現在状態を返す。

### `/raidmode off`

`reason`任意。発動前Verification Levelを復元する。ただし、BotがHIGHへ変更しており、現在値もHIGHのままである場合に限る。管理者が発動中に値を変更していた場合は上書きしない。

---

## 5.5.6 `/autoraidmode`

- `/autoraidmode on`: 10 joins / 10 seconds
- `/autoraidmode set joins:<3～100> seconds:<2～300>`
- `/autoraidmode off`
- `/autoraidmode status`

offは自動検知のみ無効化し、現在ONのRaidModeを解除しない。

---

## 6.10 AutoRaidMode

### 6.10.1 参加イベント記録

`guildMemberAdd`で対象がBotでない場合:

1. 現在時刻を`raid_join_events`へ保存。
2. 現在時刻から`windowSeconds`より古い行を判定対象外にする。
3. 対象期間内の件数を数える。
4. `count >= joinCount`なら自動発動。

スライディングウィンドウを使用する。固定時間バケットは使用しない。

例: 10人/10秒の場合、最新参加時刻を終端とする直近10秒に10件以上あれば発動。

### 6.10.2 自動発動

発動時:

1. 既にRaidMode ONなら新たに発動しない。
2. Verification LevelがHIGH未満ならHIGHへ変更。
3. 発動前レベルと変更有無を保存。
4. `raid_mode_source=AUTO`
5. `raid_mode_reason=AutoRaid: X joins in Y seconds`
6. ケースを作成。
7. modlogへ警告Embed。
8. `DISABLE_RAIDMODE`を最後の非Bot参加時刻＋120秒で予約。

### 6.10.3 RaidMode中の新規参加

非Botの新規参加者に対して:

1. DMを送信。
2. 最大2秒待機。
3. 即座にKick。
4. 対象ごとにKickケースを作成。
5. modlogへ記録。
6. AutoRaid由来の場合は自動解除時刻を現在＋120秒へ延長。

DM:

```text
<guild名> は現在ロックダウン中です。
安全確保のため新規参加を一時的に停止しています。
時間を置いて再度参加してください。
```

Botアカウントは発動判定、Kick、解除時刻延長のすべてから除外する。旧VortexのAnti Raid仕様もBot参加を対象外としている。[Anti Raid Mode](https://github.com/jagrosh/Vortex/wiki/Anti-Raid-Mode)

### 6.10.4 自動解除

次をすべて満たす場合に解除する。

- RaidModeがON
- sourceがAUTO
- 最後の非Bot参加試行から120秒以上
- 予約ジョブ実行時点でも新しい参加がない

新しい参加がある場合、解除せず`lastJoin+120秒`へ再予約する。

MANUAL RaidModeはAutoRaidの無参加判定では解除しない。

---
