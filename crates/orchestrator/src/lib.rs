use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use self_agent_core::bus::MessageBus;
use self_agent_core::error::Result;
use self_agent_core::message::{AgentId, Message, MessageKind};
use self_agent_core::Agent;
use self_agent_llm_client::provider::LlmProvider;
use self_agent_storage::Database;

pub mod intent;

use intent::{parse_intent, IntentAction};

/// オーケストレーター: エージェント間のメッセージルーティングとインテント解析を管理
pub struct Orchestrator {
    bus: Option<MessageBus>,
    rx: Option<mpsc::Receiver<Message>>,
    llm: Option<Arc<dyn LlmProvider>>,
    db: Option<Arc<Mutex<Database>>>,
}

impl Orchestrator {
    pub fn new() -> Self {
        Self {
            bus: None,
            rx: None,
            llm: None,
            db: None,
        }
    }

    /// LLMプロバイダーを設定
    pub fn with_llm(mut self, llm: Arc<dyn LlmProvider>) -> Self {
        self.llm = Some(llm);
        self
    }

    /// データベースを設定
    pub fn with_db(mut self, db: Arc<Mutex<Database>>) -> Self {
        self.db = Some(db);
        self
    }

    /// メッセージループを実行する
    pub async fn run(&mut self) -> Result<()> {
        let bus = self.bus.clone().expect("Orchestrator not initialized");
        let mut rx = self.rx.take().expect("Orchestrator not initialized");

        info!("Orchestrator message loop started");

        while let Some(msg) = rx.recv().await {
            info!(
                "Orchestrator received: id={}, from={}, kind={:?}",
                msg.id, msg.from, msg.kind
            );

            match self.process_message(msg, &bus).await {
                Ok(()) => {}
                Err(e) => warn!("Error processing message: {}", e),
            }
        }

        info!("Orchestrator message loop ended");
        Ok(())
    }

    async fn process_message(&self, msg: Message, bus: &MessageBus) -> Result<()> {
        match (&msg.from, &msg.kind) {
            // ChatBotからのリクエスト -> LLMでインテント解析
            (AgentId::ChatBot, MessageKind::Request) => {
                let response = self.handle_chat_request(&msg).await;
                match response {
                    Ok(resp) => {
                        if let Err(e) = bus.send(resp).await {
                            warn!("Failed to send response to ChatBot: {}", e);
                        }
                    }
                    Err(e) => {
                        error!("Failed to handle chat request: {}", e);
                        // エラーレスポンスを返す
                        let error_resp = msg.response(
                            AgentId::Orchestrator,
                            serde_json::json!({
                                "type": "error",
                                "text": format!("処理中にエラーが発生しました: {}", e),
                            }),
                        );
                        if let Err(e) = bus.send(error_resp).await {
                            warn!("Failed to send error response: {}", e);
                        }
                    }
                }
            }
            // その他のメッセージはルーティング
            _ => {
                if msg.to.is_some() {
                    debug!("Routing message {} -> {:?}", msg.from, msg.to);
                    if let Err(e) = bus.send(msg).await {
                        warn!("Failed to route message: {}", e);
                    }
                } else {
                    if let Err(e) = bus.broadcast(msg).await {
                        warn!("Failed to broadcast: {}", e);
                    }
                }
            }
        }
        Ok(())
    }

    async fn handle_chat_request(&self, msg: &Message) -> anyhow::Result<Message> {
        let content = msg
            .payload
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let channel_id = msg
            .payload
            .get("channel_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        info!(
            "Processing chat request: content='{}', channel={}",
            content, channel_id
        );

        // LLMがある場合はインテント解析
        if let Some(llm) = &self.llm {
            // 会話コンテキストを取得
            let context = if let Some(db) = &self.db {
                let db = db.lock().unwrap();
                let logs = db.get_recent_context(channel_id, 10)?;
                if logs.is_empty() {
                    None
                } else {
                    let ctx = logs
                        .iter()
                        .map(|l| format!("{}: {}", l.author, l.content))
                        .collect::<Vec<_>>()
                        .join("\n");
                    Some(ctx)
                }
            } else {
                None
            };

            let intent_result = parse_intent(llm.as_ref(), content, context.as_deref()).await;

            match intent_result {
                Ok(intent) => {
                    // インテントに応じてアクション実行
                    let response_text = self
                        .execute_intent(&intent)
                        .await
                        .unwrap_or_else(|e| format!("エラー: {}", e));

                    Ok(msg.response(
                        AgentId::Orchestrator,
                        serde_json::json!({
                            "type": "chat_response",
                            "text": response_text,
                            "channel_id": channel_id,
                            "intent": serde_json::to_value(&intent.action).unwrap_or_default(),
                        }),
                    ))
                }
                Err(e) => {
                    warn!("Intent parsing failed: {}, falling back to echo", e);
                    Ok(msg.response(
                        AgentId::Orchestrator,
                        serde_json::json!({
                            "type": "chat_response",
                            "text": format!("メッセージを受け取りました: {}", content),
                            "channel_id": channel_id,
                        }),
                    ))
                }
            }
        } else {
            // LLMなしの場合はエコー
            Ok(msg.response(
                AgentId::Orchestrator,
                serde_json::json!({
                    "type": "chat_response",
                    "text": format!("メッセージを受け取りました: {}", content),
                    "channel_id": channel_id,
                }),
            ))
        }
    }

    async fn execute_intent(&self, intent: &intent::Intent) -> anyhow::Result<String> {
        let db = match &self.db {
            Some(db) => db,
            None => return Ok(intent.response_text.clone()),
        };

        match &intent.action {
            IntentAction::AddTask => {
                let title = intent.title.as_deref().unwrap_or("無題のタスク");
                let priority = match intent.priority.as_deref() {
                    Some("urgent") => self_agent_storage::TaskPriority::Urgent,
                    Some("high") => self_agent_storage::TaskPriority::High,
                    Some("low") => self_agent_storage::TaskPriority::Low,
                    _ => self_agent_storage::TaskPriority::Normal,
                };

                let task_id = db.lock().unwrap().create_task(&self_agent_storage::CreateTask {
                    title: title.to_string(),
                    description: intent.description.clone(),
                    priority: Some(priority),
                    due_date: intent.due_date.clone(),
                    source_context: None,
                    source_channel: None,
                    source_server: None,
                })?;

                Ok(format!(
                    "{}\n(タスクID: #{})",
                    intent.response_text, task_id
                ))
            }
            IntentAction::TodayTasks | IntentAction::ListTasks => {
                let (mut tasks, in_progress_tasks) = {
                    let db = db.lock().unwrap();
                    let filter = self_agent_storage::TaskFilter {
                        status: Some(self_agent_storage::TaskStatus::Todo),
                        ..Default::default()
                    };
                    let tasks = db.list_tasks(&filter)?;

                    let in_progress_filter = self_agent_storage::TaskFilter {
                        status: Some(self_agent_storage::TaskStatus::InProgress),
                        ..Default::default()
                    };
                    let in_progress = db.list_tasks(&in_progress_filter)?;
                    (tasks, in_progress)
                };
                tasks.extend(in_progress_tasks);

                if tasks.is_empty() {
                    let text = if intent.response_text.is_empty() {
                        "現在アクティブなタスクはありません。".to_string()
                    } else {
                        format!(
                            "{}\n\n現在アクティブなタスクはありません。",
                            intent.response_text
                        )
                    };
                    return Ok(text);
                }

                // 優先度でソート
                tasks.sort_by(|a, b| b.priority.cmp(&a.priority));

                let mut summary = format!("アクティブタスク ({} 件)\n", tasks.len());
                for task in &tasks {
                    let due = task.due_date.as_deref().unwrap_or("期限なし");
                    summary.push_str(&format!(
                        "- #{}: {} [{}] ({})\n",
                        task.id,
                        task.title,
                        task.status.as_str(),
                        due
                    ));
                }

                if intent.response_text.is_empty() {
                    Ok(summary)
                } else {
                    Ok(format!("{}\n\n{}", intent.response_text, summary))
                }
            }
            IntentAction::SearchTasks => {
                let query = intent.title.as_deref().unwrap_or("");
                let filter = self_agent_storage::TaskFilter {
                    search: Some(query.to_string()),
                    ..Default::default()
                };
                let tasks = db.lock().unwrap().list_tasks(&filter)?;
                if tasks.is_empty() {
                    Ok(format!(
                        "「{}」に該当するタスクは見つかりませんでした。",
                        query
                    ))
                } else {
                    let list = tasks
                        .iter()
                        .map(|t| format!("- #{}: {} [{}]", t.id, t.title, t.status.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n");
                    Ok(format!("検索結果:\n{}", list))
                }
            }
            IntentAction::CompleteTask => {
                if let Some(title) = &intent.title {
                    if let Ok(id) = title.trim_start_matches('#').parse::<i64>() {
                        let update = self_agent_storage::UpdateTask {
                            status: Some(self_agent_storage::TaskStatus::Done),
                            ..Default::default()
                        };
                        db.lock().unwrap().update_task(id, &update)?;
                        return Ok(intent.response_text.clone());
                    }
                }
                Ok("タスクIDを特定できませんでした。".to_string())
            }
            _ => Ok(intent.response_text.clone()),
        }
    }
}

impl Default for Orchestrator {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Agent for Orchestrator {
    fn id(&self) -> AgentId {
        AgentId::Orchestrator
    }

    async fn init(&mut self, bus: MessageBus) -> Result<()> {
        let rx = bus.register(AgentId::Orchestrator).await;
        self.bus = Some(bus);
        self.rx = Some(rx);
        info!("Orchestrator initialized");
        Ok(())
    }

    async fn handle_message(&mut self, _message: Message) -> Result<Option<Message>> {
        // run()ループ内で直接処理するため、ここは使わない
        Ok(None)
    }

    fn tick_interval(&self) -> Option<Duration> {
        Some(Duration::from_secs(60))
    }

    async fn tick(&mut self) -> Result<()> {
        debug!("Orchestrator health check: OK");
        Ok(())
    }

    async fn shutdown(&mut self) -> Result<()> {
        info!("Orchestrator shutting down");
        if let Some(bus) = &self.bus {
            bus.unregister(&AgentId::Orchestrator).await;
        }
        Ok(())
    }
}
