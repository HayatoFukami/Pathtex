# 一般コマンド仕様

対象は`/about`、`/invite`、`/ping`、`/roleinfo`、`/serverinfo`、`/userinfo`である。

## 前提

- 共通のコマンド入力・応答・認可規則は`00-common.md`に従う。
- この機能群はギルド内の全メンバーが実行できる。

---

## 5.2 一般コマンド

一般コマンドはギルド内の全員が実行できる。

### 5.2.1 `/about`

オプションなし。

表示:

- Bot名とAvatar
- `BOT_VERSION`
- Node.jsバージョン
- discord.jsバージョン
- 稼働時間
- 接続ギルド数
- キャッシュ済みユーザー数
- DB上の総ケース数・総ストライク数
- GitHub URL
- Footer: `Vortex TypeScript Reimplementation`

DB統計取得に失敗した場合、他項目を表示し、統計欄を`取得失敗`とする。

### 5.2.2 `/invite`

オプションなし。

`DISCORD_CLIENT_ID`、scope `bot applications.commands`、`INVITE_PERMISSIONS`からOAuth2 URLを生成し、リンクボタン付きEmbedを表示する。

### 5.2.3 `/ping`

オプションなし。

表示:

- Interaction応答遅延: 受信時刻から初期応答時刻
- Gateway ping: `client.ws.ping`
- DB ping: `SELECT 1`の往復時間

DB失敗時もコマンド全体は成功とし、DB欄のみ`失敗`とする。

### 5.2.4 `/roleinfo`

| オプション | 型 | 必須 |
|---|---|---:|
| `role` | ROLE | Yes |

表示:

- 名前、ID
- 色
- 作成日時
- ギルド内順位
- メンバー数
- mentionable、hoist、managed
- Unicode/画像アイコン
- 権限一覧
- Botの最高ロールとの比較

権限が多い場合はカンマ区切りで複数フィールドへ分割する。

### 5.2.5 `/serverinfo`

オプションなし。

表示:

- 名前、ID、アイコン
- Owner
- 作成日時
- 総メンバー、ユーザー、Bot
- テキスト、ボイス、カテゴリ、スレッド数
- ロール数
- Boost数・Tier
- Verification Level
- Explicit Content Filter
- Preferred Locale
- Guild Features
- Vanity URL

一部Member情報を取得できない場合、キャッシュ値を使用し、Footerへ`一部は概算値`と記載する。

### 5.2.6 `/userinfo`

| オプション | 型 | 必須 |
|---|---|---:|
| `user` | USER | No |

省略時は実行者。

表示:

- username、global display name、ID
- Bot/Systemフラグ
- アカウント作成日時
- ギルド参加日時
- Nickname
- 最高ロール
- 全ロール。表示上限は先頭30件
- Avatar、guild-specific avatar
- Banner・accent colorを取得できる場合は表示
- Timeout終了日時

---
