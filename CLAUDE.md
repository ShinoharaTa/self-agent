# self-agent

## 概要

Discord 専用サーバーに常駐する個人用エージェント。Claude Agent SDK（TypeScript）で実装し、Claude Max の利用枠で動く。
Discord の 1 スレッド = 1 SDK セッション（`resume` で継続）。

- 要件: `docs/REQUIREMENTS.md`, `docs/design/`
- 旧 Rust 版の資料は `docs/archive/`（参照のみ）

## コマンド

```bash
source ~/.nvm/nvm.sh   # 非対話シェルでは毎回必要（Node 24.20.0）
npm ci                 # 依存インストール（package-lock.json どおり）
npm run check          # 型チェック（tsc --noEmit）
npm test               # テスト（node:test）
npm start              # 起動
npm run measure        # P0 実測（OAuth トークン必須。利用枠を消費する）
```

## ディレクトリ構成

```
self-agent/
├── package.json / package-lock.json
├── tsconfig.json          # 型チェック専用（noEmit）。実行は Node の型ストリッピング
├── src/
│   ├── main.ts            # エントリポイント
│   └── config.ts          # 環境変数から設定を読む
├── scripts/measure-turn.ts  # ターン時間・RSS・トークン使用量の実測
├── test/                  # node:test
└── docs/                  # REQUIREMENTS.md, design/, research/, archive/
```

## 環境変数

| 変数名 | 用途 |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` で発行。権限 600 の環境ファイルに置く。コミット禁止 |
| `CLAUDE_CONFIG_DIR` | SDK の設定・セッション保存先。既定 `~/.local/share/self-agent/claude` |
| `SELF_AGENT_WORKDIR` | エージェントの作業ディレクトリ。既定 `~/.local/share/self-agent/work` |
| `SELF_AGENT_MODEL` | 使用モデル。既定 `claude-opus-5` |

## コーディング規約

- erasable な TypeScript のみ（enum / namespace / parameter properties 禁止）。ビルドせず `node` で直接実行する
- 相対 import は `.ts` 拡張子付き
- 依存は最小限、バージョンは exact 固定
- public リポジトリなので、トークン・ID・個人情報をコードやログに書かない

## プロンプトキャッシュの規則

- システムプロンプトは静的に保つ。日時や ID などの可変値を入れない
- ツール集合は全セッション共通で固定する
- 会話履歴は追記のみ（途中を書き換えない）
- モデルと effort はセッション途中で変えない
- キャッシュ効果の計測は result の `modelUsage` の差分で行う
