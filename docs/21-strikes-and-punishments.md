# ストライク・Punishment仕様

対象は`/strike`、`/pardon`、`/check`、`/punishment`と、手動・AutoModのストライク加算に連動する自動制裁である。

## 前提

- ストライク更新、ケース番号、予約、永続モデルは`01-platform-and-data.md`に従う。
- 手動のBAN、Mute等のDiscord操作は`20-moderation.md`の操作規則を再利用する。
- `/strike`・`/pardon`の複数対象数は`00-common.md`の共通対象規則と`MAX_BULK_TARGETS`（1～20、既定20）に従う。
- AutoMod固有の違反判定・削除は`30-automod.md`に従う。

---

## 5.3.8 `/strike`

| オプション | 型 | 必須 |
|---|---|---:|
| 共通対象 | — | Yes |
| `amount` | INTEGER 1～100 | No、既定1 |
| `reason` | STRING | Yes |

認可: Kick Members、Ban Members、Manage Guildのいずれか、またはMODロール

処理:

1. Userを取得。
2. ストライクをトランザクション内で加算。
3. Strikeケースを作成。
4. 対象へDM。
5. 旧値と新値の間で到達したPunishmentを選択。
6. 自動制裁を実行。
7. Strikeケースと自動制裁ケースを別々にmodlogへ出力。

ギルド外ユーザーにもストライクを付与できる。ギルド内Memberを必要とするMute/Kick制裁は実行失敗として記録する。

## 5.3.9 `/pardon`

`/strike`と同じオプション。

処理:

- `after=max(0,before-amount)`
- 実際に減少した値を履歴へ保存
- DMで旧値、新値、理由を通知
- 過去の制裁を自動解除しない
- Punishment再評価は行わない

## 5.3.10 `/check`

| オプション | 型 | 必須 |
|---|---|---:|
| `user` | USER | Yes |

認可: Strikeと同じ。

表示:

- 現在ストライク数
- Mutedロール有無
- Mute自動解除日時
- BAN状態
- BAN自動解除日時
- 次のPunishmentしきい値・Action
- 直近5件のストライク増減

BAN状態取得に失敗した場合、他情報を表示しBAN欄を`取得失敗`とする。

---

## 5.4.2 `/punishment`

### `/punishment set`

| オプション | 型 | 必須 |
|---|---|---:|
| `threshold` | INTEGER 1～1,000,000 | Yes |
| `action` | STRING choice | Yes |
| `duration` | STRING | No |

Action choices:

- `none`
- `mute`
- `kick`
- `softban`
- `ban`

規則:

- `none`は対象しきい値の設定削除。
- Mute/Banのみduration可。Kick/Softbanでduration指定は拒否。
- Action別duration上限: Muteは28日（2,419,200秒）以下、Banは365日（31,536,000秒）以下。上限超過は拒否。
- Actionとdurationの組み合わせ妥当性は設定時に検証する。Domain schema・公開設定サービス・永続化書き込み境界のすべてが同一ポリシーを共有し、不正な組み合わせは保存せずに`INVALID_INPUT`として拒否する。暗黙のclampや既存データの再解釈は行わない。
- 同一しきい値は上書き。

### `/punishment remove`

`threshold`必須。存在しなければ`NOT_APPLIED`。

### `/punishment list`

しきい値昇順でAction、期間、設定者、更新日時を表示する。

---

## 6.9 ストライク・Punishment連携

### 6.9.1 到達判定

ストライク加算前を`before`、加算後を`after`とする。

候補条件:

```text
before < punishment.threshold <= after
```

一度に複数しきい値を超えた場合、**到達した中で最大のthresholdを持つ設定だけを実行する**。

例:

- 設定: 2=Mute、3=Kick、5=Ban
- before=1、after=5
- 実行: threshold 5のBanのみ

同じthresholdはDBのUnique制約により1件だけである。Actionの強弱比較は行わない。

最高しきい値の制裁が権限不足等で失敗しても、低いしきい値へフォールバックしない。

### 6.9.2 再到達

`before >= threshold`なら再実行しない。

Pardonによりthreshold未満へ下がった後、再び到達した場合は再実行する。

### 6.9.3 Action

| Action | 動作 |
|---|---|
| Mute | Mutedロール付与。期間ありならUNMUTE予約 |
| Kick | DM後Kick |
| Softban | BAN後即Unban。既定7日分メッセージ削除 |
| Ban | BAN。期間ありならUNBAN予約 |

自動制裁理由:

```text
<累積数>ストライクに到達: <今回の違反理由>
```

Strikeケースと自動制裁ケースは別ケースとする。

### 6.9.4 DM

ストライクDM:

```text
<guild名> で <amount> ストライクが付与されました。
理由: <reason>
現在の合計: <after>
ケース: #<caseNumber>
```

自動制裁がある場合、同じDMへ制裁内容・期間を追記する。DM失敗でも制裁を中止しない。

## 6.9.5 対象Identity

`/strike`、`/pardon`、`/check`およびPunishmentは、ギルド外を含め`00-common.md §1.7–1.8`のTargetIdentityを使用する。ケース作成前のUser取得またはIdentity解決失敗は、Identityを含むコマンド結果だけを返し、ケースとmodlogを作成しない。ケース境界を越えた後の制裁API失敗は、保存済みIdentity付きの失敗ケースとして記録する。Strikeケース、自動制裁ケース、履歴は対象IDを共有するが、各表示は保存済みケースのtarget snapshotから行う。Pardonで過去ケースの表示名を更新しない。
