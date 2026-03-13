use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// エージェント識別子
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AgentId {
    Orchestrator,
    TaskManager,
    CalSync,
    ChatBot,
    SkillDev,
    Reminder,
    /// 動的スキルエージェント
    Skill(String),
}

impl std::fmt::Display for AgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentId::Orchestrator => write!(f, "orchestrator"),
            AgentId::TaskManager => write!(f, "task-manager"),
            AgentId::CalSync => write!(f, "cal-sync"),
            AgentId::ChatBot => write!(f, "chat-bot"),
            AgentId::SkillDev => write!(f, "skill-dev"),
            AgentId::Reminder => write!(f, "reminder"),
            AgentId::Skill(name) => write!(f, "skill:{}", name),
        }
    }
}

/// メッセージの優先度
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
pub enum Priority {
    Low,
    #[default]
    Normal,
    High,
    Urgent,
}

/// メッセージの種別
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MessageKind {
    /// リクエスト（応答を期待）
    Request,
    /// レスポンス（Requestへの応答）
    Response,
    /// 一方向通知
    Notification,
    /// イベント（状態変化通知）
    Event,
    /// エラー
    Error,
}

/// A2Aメッセージ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// メッセージID
    pub id: Uuid,
    /// 送信元
    pub from: AgentId,
    /// 宛先 (None = broadcast)
    pub to: Option<AgentId>,
    /// メッセージ種別
    pub kind: MessageKind,
    /// ペイロード
    pub payload: serde_json::Value,
    /// 相関ID (リクエスト-レスポンス紐付け)
    pub correlation_id: Option<Uuid>,
    /// タイムスタンプ
    pub timestamp: DateTime<Utc>,
    /// 優先度
    pub priority: Priority,
}

impl Message {
    /// 新しいリクエストメッセージを作成
    pub fn request(from: AgentId, to: AgentId, payload: serde_json::Value) -> Self {
        Self {
            id: Uuid::new_v4(),
            from,
            to: Some(to),
            kind: MessageKind::Request,
            payload,
            correlation_id: None,
            timestamp: Utc::now(),
            priority: Priority::Normal,
        }
    }

    /// リクエストに対するレスポンスを作成
    pub fn response(&self, from: AgentId, payload: serde_json::Value) -> Self {
        Self {
            id: Uuid::new_v4(),
            from,
            to: Some(self.from.clone()),
            kind: MessageKind::Response,
            payload,
            correlation_id: Some(self.id),
            timestamp: Utc::now(),
            priority: self.priority,
        }
    }

    /// 通知メッセージを作成
    pub fn notification(from: AgentId, payload: serde_json::Value) -> Self {
        Self {
            id: Uuid::new_v4(),
            from,
            to: None,
            kind: MessageKind::Notification,
            payload,
            correlation_id: None,
            timestamp: Utc::now(),
            priority: Priority::Normal,
        }
    }

    /// イベントメッセージを作成
    pub fn event(from: AgentId, payload: serde_json::Value) -> Self {
        Self {
            id: Uuid::new_v4(),
            from,
            to: None,
            kind: MessageKind::Event,
            payload,
            correlation_id: None,
            timestamp: Utc::now(),
            priority: Priority::Normal,
        }
    }

    /// 優先度を設定
    pub fn with_priority(mut self, priority: Priority) -> Self {
        self.priority = priority;
        self
    }

    /// 宛先を設定
    pub fn with_to(mut self, to: AgentId) -> Self {
        self.to = Some(to);
        self
    }
}
