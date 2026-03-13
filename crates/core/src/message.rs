use serde::{Deserialize, Serialize};

/// エージェント間メッセージ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// 送信元エージェント名
    pub from: String,
    /// 宛先エージェント名 (None = ブロードキャスト)
    pub to: Option<String>,
    /// メッセージ種別
    pub kind: MessageKind,
    /// ペイロード (JSON文字列)
    pub payload: String,
}

/// メッセージの種別
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MessageKind {
    /// ユーザーからのチャットメッセージ
    ChatInput,
    /// エージェントからの応答
    ChatResponse,
    /// タスク作成リクエスト
    TaskCreate,
    /// タスク更新通知
    TaskUpdate,
    /// 内部コマンド
    Command,
    /// ハートビート / 死活監視
    Ping,
}
