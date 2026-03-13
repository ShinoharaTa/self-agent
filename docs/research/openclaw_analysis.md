# OpenClaw / Claude Code 調査分析

> 調査日: 2026-03-14
> 調査者: Agent-2 (Requirements Analyst)
> 注: WebSearch/WebFetchが制限されていたため、既知の情報に基づく分析

## 1. OpenClawとは

OpenClawは、Claude Codeの内部コードネーム/オープンソース化プロジェクトとして参照される自律型コーディングエージェント。AnthropicのClaude APIを活用し、ターミナル上で動作するCLIエージェントとして設計されている。

### 1.1 コア特徴
- **自律的なコード生成・編集**: ファイルの読み書き、検索、実行を自律的に行う
- **セッション間の記憶持続**: CLAUDE.md (旧MEMORY.md) によるプロジェクト知識の永続化
- **ツールシステム**: Bash、ファイル操作、Web検索等のツールを組み合わせてタスクを遂行
- **拡張可能なコマンドシステム**: カスタムコマンド（スラッシュコマンド）による機能拡張

## 2. 記憶システム（CLAUDE.md / MEMORY.md）

### 2.1 設計思想
- **マークダウンベース**: 人間可読かつLLMが理解しやすいフォーマット
- **階層的記憶**: プロジェクトルート、サブディレクトリ、ユーザーホームの3層
- **Git管理**: バージョン管理され、変更履歴を追跡可能
- **エージェント自身が書き換え可能**: 学習した内容を自分で記録

### 2.2 記憶の階層構造

```
~/.claude/CLAUDE.md          # ユーザーグローバル設定（全プロジェクト共通）
project/CLAUDE.md             # プロジェクトルートの記憶（Git管理）
project/src/CLAUDE.md         # サブディレクトリの記憶（スコープ限定）
```

### 2.3 記憶の内容カテゴリ
1. **プロジェクト構造**: ディレクトリ構成、主要ファイルの役割
2. **コーディング規約**: スタイル、命名規則、パターン
3. **ユーザーの好み**: 対話スタイル、技術選好
4. **学習した知識**: 過去のセッションで得た知見
5. **エージェント設定**: 振る舞いの制御パラメータ

### 2.4 self-agentへの適用ポイント
- MEMORY.md をエージェントごとに分離（例: `memory/task_manager.md`, `memory/cal_sync.md`）
- グローバル記憶（ユーザープロファイル）とローカル記憶（エージェント固有）の分離
- Git管理で記憶の変更履歴を追跡
- 構造化データ（SQLite）と非構造化記憶（Markdown）のハイブリッド

## 3. エージェント構成

### 3.1 Claude Codeのツール構成
Claude Codeは単一エージェントだが、内部的に複数のツールを持つ:

| ツール | 役割 |
|---|---|
| Bash | シェルコマンド実行 |
| Read | ファイル読み取り |
| Write | ファイル書き込み |
| Edit | ファイル部分編集 |
| Glob | ファイル検索 |
| Grep | コンテンツ検索 |
| WebSearch | Web検索 |
| WebFetch | Webページ取得 |
| Skill | スキル呼び出し |

### 3.2 self-agentとの違い
- Claude Codeは**単一エージェント + 多ツール**
- self-agentは**複数エージェント + A2A協調**
- Claude Codeのツール設計を参考に、各エージェントの「能力」を定義できる

## 4. スキルシステム

### 4.1 Claude Codeのスキル/コマンドシステム
- `.claude/commands/` ディレクトリにカスタムコマンドを配置
- マークダウンファイルでプロンプトテンプレートを定義
- `$ARGUMENTS` プレースホルダで引数を受け取り
- `/command-name` でスラッシュコマンドとして呼び出し

### 4.2 スキルのライフサイクル
1. **定義**: マークダウンまたはコードファイルとしてスキルを記述
2. **登録**: ディレクトリに配置するだけで自動認識
3. **呼び出し**: スラッシュコマンドまたはエージェント判断で呼び出し
4. **実行**: コンテキストに展開されてLLMが解釈・実行

### 4.3 self-agentへの適用設計案

```
skills/
├── manifest.json              # スキル一覧・メタデータ
├── task-extract/
│   ├── skill.toml             # スキル定義（名前、トリガー、依存）
│   ├── index.ts               # TypeScript実装
│   └── test.ts                # テストコード
├── calendar-check/
│   ├── skill.toml
│   ├── index.ts
│   └── test.ts
└── remind/
    ├── skill.toml
    ├── index.ts
    └── test.ts
```

**スキル定義 (skill.toml) の例:**
```toml
[skill]
name = "task-extract"
version = "0.1.0"
description = "会話からタスクを抽出する"
author = "SkillDev"

[trigger]
type = "message"  # "message" | "schedule" | "event" | "manual"
pattern = "タスク|TODO|やること"

[dependencies]
agents = ["TaskManager"]
permissions = ["db:write", "memory:read"]

[runtime]
timeout_ms = 30000
max_memory_mb = 64
```

## 5. 追加の設計知見

### 5.1 コンテキストウィンドウ管理
- Claude Codeはコンテキストが長くなるとサマリを作成して圧縮
- self-agentでも会話コンテキストのサマリ化が必要
- MEMORY.mdに重要な情報を書き出すことで、コンテキスト外の記憶を保持

### 5.2 エラーハンドリングとリトライ
- ツール実行失敗時の自動リトライ
- LLM応答の検証（JSON parseなど）
- タイムアウト管理

### 5.3 安全性設計
- ファイル操作のサンドボックス
- 危険なコマンドの確認プロンプト
- self-agentでは：Googleカレンダー書き込みの承認制がこれに相当

## 6. まとめ

| 要素 | Claude Code方式 | self-agent適用案 |
|---|---|---|
| 記憶 | CLAUDE.md (階層的) | MEMORY.md (エージェント別) + SQLite |
| スキル | .claude/commands/ (Markdown) | skills/ (TypeScript + TOML定義) |
| ツール | 組み込みツール群 | エージェント能力として定義 |
| 拡張 | カスタムコマンド追加 | SkillDevエージェントが自動生成 |
| 安全 | 確認プロンプト | 承認制 + パーミッションモデル |
