# 要件トレーサビリティ行列

本表は、`README.md`に列挙された各機能仕様のコマンドと、基盤仕様のGatewayイベントを実装単位へ対応付ける。入力、権限、処理順、応答内容の正本は各リンク先であり、本表では重複して定義しない。`NONE/EPHEMERAL/PUBLIC`は`00-common.md`の`deferMode`である。

## コマンド

| コマンド | 認可 | defer/可視性 | Service所有者 | テスト参照 |
|---|---|---|---|---|
| `/about`、`/invite`、`/ping`、`/roleinfo`、`/serverinfo`、`/userinfo` | PUBLIC | NONE / 公開 | GeneralService | [一般](10-general-commands.md)、共通§9.7 |
| `/kick`、`/ban`、`/silentban`、`/softban`、`/unban`、`/mute`、`/unmute` | MODERATOR（操作別Native権限） | EPHEMERAL / 非公開 | ModerationService | [モデレーション](20-moderation.md)、共通§9.7 |
| `/reason`、`/slowmode`、`/clean` | MODERATOR（操作別Native権限） | EPHEMERAL / 非公開 | ModerationService | [モデレーション](20-moderation.md)、基盤§9.7 |
| `/strike`、`/pardon`、`/check` | MODERATOR（Strike権限） | EPHEMERAL / 非公開 | StrikeService | [Strike](21-strikes-and-punishments.md)、共通§9.7 |
| `/punishment` | MANAGE_GUILD | EPHEMERAL / 非公開 | StrikeService | [Strike](21-strikes-and-punishments.md)、基盤§9.7 |
| `/raidmode` | MODERATOR（操作別Native権限） | EPHEMERAL / 非公開 | RaidService | [RaidMode](31-raidmode.md)、共通§9.7 |
| `/autoraidmode` | MANAGE_GUILD | EPHEMERAL / 非公開 | RaidService | [RaidMode](31-raidmode.md)、基盤§9.7 |
| `/setup`、`/messagelog`、`/modlog`、`/serverlog`、`/voicelog`、`/timezone`、`/modrole`、`/settings` | MANAGE_GUILD | EPHEMERAL / 非公開 | ConfigurationService | [設定・ログ](40-configuration-and-logs.md)、共通§9.7 |
| `/antiinvite`、`/antireferral`、`/antieveryone`、`/anticopypasta`、`/maxmentions`、`/maxlines`、`/antiduplicate`、`/autodehoist` | MANAGE_GUILD | EPHEMERAL / 非公開 | AutomodService | [AutoMod](30-automod.md)、共通§9.7 |
| `/ignore`、`/unignore` | MANAGE_GUILD | EPHEMERAL / 非公開 | AutomodService | [AutoMod](30-automod.md)、基盤§9.7 |
| `/voicekick`、`/voicemove` | MODERATOR（Move Members） | EPHEMERAL / 非公開 | VoiceService | [ツール・ボイス](50-tools-and-voice.md)、共通§9.7 |
| `/announce`、`/audit`、`/dehoist`、`/inviteprune` | MODERATOR（操作別Native権限） | EPHEMERAL / 非公開（announce本文は公開） | ToolsService | [ツール・ボイス](50-tools-and-voice.md)、共通§9.7 |
| `/lookup` | PUBLIC | EPHEMERAL / 非公開 | ToolsService | [ツール・ボイス](50-tools-and-voice.md)、共通§9.7 |

## Gatewayイベント

| イベント | 認可 | defer/可視性 | Service所有者 | テスト参照 |
|---|---|---|---|---|
| `interactionCreate` | コマンドごとの認可 | コマンド契約に従う | CommandRouter | 共通§3.3、§8.6 |
| `messageCreate`、`messageUpdate` | なし（対象判定） | N/A / ログ設定に従う | AutomodService、MessageLogService | [AutoMod](30-automod.md)、[設定・ログ](40-configuration-and-logs.md) |
| `messageDelete`、`messageDeleteBulk` | なし | N/A / ログ設定に従う | MessageLogService | [設定・ログ](40-configuration-and-logs.md)、基盤§3.5 |
| `guildMemberAdd`、`guildMemberRemove`、`guildMemberUpdate`、`userUpdate` | なし | N/A / ログ設定に従う | ServerLogService、MemberRoleChangeService、RaidService、ModerationService | [RaidMode](31-raidmode.md)、[設定・ログ](40-configuration-and-logs.md)§8.10、基盤§3.5・§4.8 |
| `voiceStateUpdate` | なし | N/A / ログ設定に従う | VoiceLogService、VoiceService | [設定・ログ](40-configuration-and-logs.md)、[ツール・ボイス](50-tools-and-voice.md) |
| `guildBanAdd`、`guildBanRemove` | なし | N/A / ケース・ログ設定に従う | ModerationService、AuditService | [モデレーション](20-moderation.md)、基盤§3.5 |
| `channelCreate`、`channelDelete`、`channelUpdate` | なし | N/A / サーバーログ対象外（Muted上書き・Slowmode相関・composite cleanupのみ） | SettingsService、IgnoreConfigurationService、SchedulerService | [設定・ログ](40-configuration-and-logs.md)§8.10、基盤§3.5・§4.11 |
| `guildCreate`、`guildDelete` | なし | N/A / 保持マーカー更新 | GuildLifecycleService | 基盤§3.4、§4.14 |

### 正本への参照

- 認可、defer、可視性、共通テスト方針: [`00-common.md`](00-common.md)
- イベント順、相関キャッシュ、データモデル、統合テスト: [`01-platform-and-data.md`](01-platform-and-data.md)
- 機能固有の契約と対象範囲: [`README.md`](README.md)から各機能仕様へ遷移する。
