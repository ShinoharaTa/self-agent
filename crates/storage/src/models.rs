use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// タスクのステータス
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    Done,
    OnHold,
}

impl TaskStatus {
    pub fn as_str(&self) -> &str {
        match self {
            TaskStatus::Todo => "todo",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Done => "done",
            TaskStatus::OnHold => "on_hold",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "in_progress" => TaskStatus::InProgress,
            "done" => TaskStatus::Done,
            "on_hold" => TaskStatus::OnHold,
            _ => TaskStatus::Todo,
        }
    }
}

/// タスクの優先度
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum TaskPriority {
    Low = 0,
    Normal = 1,
    High = 2,
    Urgent = 3,
}

impl TaskPriority {
    pub fn from_i32(v: i32) -> Self {
        match v {
            0 => TaskPriority::Low,
            2 => TaskPriority::High,
            3 => TaskPriority::Urgent,
            _ => TaskPriority::Normal,
        }
    }

    pub fn as_i32(&self) -> i32 {
        match self {
            TaskPriority::Low => 0,
            TaskPriority::Normal => 1,
            TaskPriority::High => 2,
            TaskPriority::Urgent => 3,
        }
    }
}

/// タスク
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub description: Option<String>,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub due_date: Option<String>,
    pub source_context: Option<String>,
    pub source_channel: Option<String>,
    pub source_server: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// タスク作成リクエスト
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTask {
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<TaskPriority>,
    pub due_date: Option<String>,
    pub source_context: Option<String>,
    pub source_channel: Option<String>,
    pub source_server: Option<String>,
}

/// タスク更新リクエスト
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateTask {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<TaskStatus>,
    pub priority: Option<TaskPriority>,
    pub due_date: Option<String>,
}

/// タスク検索フィルター
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskFilter {
    pub status: Option<TaskStatus>,
    pub priority: Option<TaskPriority>,
    pub search: Option<String>,
}

/// リマインダー
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reminder {
    pub id: i64,
    pub task_id: Option<i64>,
    pub message: String,
    pub remind_at: DateTime<Utc>,
    pub is_fired: bool,
    pub created_at: DateTime<Utc>,
}

/// リマインダー作成リクエスト
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateReminder {
    pub task_id: Option<i64>,
    pub message: String,
    pub remind_at: DateTime<Utc>,
}

/// 会話ログ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationLog {
    pub id: i64,
    pub platform: String,
    pub server_id: String,
    pub channel_id: String,
    pub author: String,
    pub content: String,
    pub timestamp: DateTime<Utc>,
}
