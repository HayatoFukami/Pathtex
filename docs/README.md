# Vortex TypeScript再実装仕様書

このディレクトリが、AIによる実装のために再編した正本である。機能担当は、まず共通仕様と基盤仕様を読み、その後に自分の機能仕様書だけを担当単位として実装する。

元の`../spec1.md`、`../spec2.md`、`../spec3.md`は分割前の照合用ソースであり、実装の読解起点にはしない。`../spec.c.md`も旧来の要約であり正本ではない。

## 読む順番

1. [共通仕様](00-common.md)
2. [プラットフォーム・データ基盤仕様](01-platform-and-data.md)
3. 担当する機能仕様書

## 機能仕様書と担当範囲

| ファイル | 主担当のコマンド／イベント | 主な依存先 |
|---|---|---|
| [10-general-commands.md](10-general-commands.md) | about, invite, ping, roleinfo, serverinfo, userinfo | 共通仕様 |
| [20-moderation.md](20-moderation.md) | kick, ban, silentban, softban, unban, mute, unmute, reason, slowmode, clean | ケース・予約・ログ |
| [21-strikes-and-punishments.md](21-strikes-and-punishments.md) | strike, pardon, check, punishment, 自動制裁 | モデレーション、AutoMod |
| [30-automod.md](30-automod.md) | AntiInvite等、maxmentions、maxlines、antiduplicate、autodehoist、ignore | ストライク、ログ |
| [31-raidmode.md](31-raidmode.md) | raidmode, autoraidmode, `guildMemberAdd` | モデレーション、予約、ログ |
| [40-configuration-and-logs.md](40-configuration-and-logs.md) | setup、4種ログ設定、timezone、modrole、settings、4種ログ | 全機能のログ出力 |
| [50-tools-and-voice.md](50-tools-and-voice.md) | voicekick, voicemove, announce, audit, dehoist, inviteprune, lookup | 共通仕様、データ基盤 |

## 実装境界

- コマンドとイベントはDiscord入力・応答だけを担当し、業務処理はServiceへ委譲する。
- Serviceは個別機能仕様の所有者であり、Repositoryを通じてのみ永続化する。
- 機能間の連携は、各仕様書で示した依存先Serviceの公開契約を使う。RepositoryやDiscord APIを横断して直接呼び出さない。
- 横断ルールを変更する場合は、先に共通仕様またはデータ基盤仕様を変更し、影響する機能仕様書へ明示的な追記を行う。

## 分割の判断

分割前の3部構成は「章の続き」であり、実装担当の境界と一致していなかった。本構成では、共有ルールを2文書へ固定し、機能ごとにコマンド・イベント・データ・連携先がまとまるようにした。これにより、例えばAutoMod担当が一般コマンドやVoiceMoveの詳細を読む必要はなく、必要な共通ルールだけを共有できる。
