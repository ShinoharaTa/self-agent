use anyhow::Result;
use serde::{Deserialize, Serialize};
use self_agent_llm_client::provider::LlmProvider;
use self_agent_llm_client::types::{ChatMessage, ChatOptions};
use tracing::debug;

/// 解析されたユーザーインテント
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Intent {
    /// インテントの種類
    pub action: IntentAction,
    /// タスクのタイトル（タスク追加時）
    pub title: Option<String>,
    /// タスクの説明
    pub description: Option<String>,
    /// 期限
    pub due_date: Option<String>,
    /// 優先度 (low, normal, high, urgent)
    pub priority: Option<String>,
    /// LLMからのレスポンステキスト（ユーザーに返す）
    pub response_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentAction {
    /// タスクを追加
    AddTask,
    /// タスク一覧を表示
    ListTasks,
    /// タスクを検索
    SearchTasks,
    /// タスクを完了
    CompleteTask,
    /// 今日のタスクを表示
    TodayTasks,
    /// リマインドを設定
    SetReminder,
    /// カレンダーを確認
    CheckCalendar,
    /// 一般的な質問・会話
    Chat,
    /// 不明
    Unknown,
}

const SYSTEM_PROMPT: &str = r#"あなたはself-agentのオーケストレーターです。ユーザーのメッセージを解析し、意図を判定してください。

以下のJSON形式で応答してください:
```json
{
  "action": "add_task" | "list_tasks" | "search_tasks" | "complete_task" | "today_tasks" | "set_reminder" | "check_calendar" | "chat" | "unknown",
  "title": "タスクのタイトル（add_taskの場合）",
  "description": "タスクの詳細（あれば）",
  "due_date": "期限（あれば、YYYY-MM-DD形式）",
  "priority": "low" | "normal" | "high" | "urgent",
  "response_text": "ユーザーに返すメッセージ"
}
```

ルール:
- タスク追加の場合、メッセージからタイトルと期限を抽出する
- 「来週」「明日」などの相対日付は具体的な日付に変換する（今日は現在の日付として計算）
- response_textは日本語で、フレンドリーな口調で書く
- 不明な場合はaction="chat"として応答する
- JSONのみを返す。マークダウンのコードブロックは不要"#;

/// ユーザーメッセージからインテントを解析する
pub async fn parse_intent(
    llm: &dyn LlmProvider,
    user_message: &str,
    context: Option<&str>,
) -> Result<Intent> {
    let mut prompt = String::new();
    if let Some(ctx) = context {
        prompt.push_str(&format!("会話の前後のコンテキスト:\n{}\n\n", ctx));
    }
    prompt.push_str(&format!("ユーザーのメッセージ:\n{}", user_message));

    let messages = vec![ChatMessage::user(prompt)];
    let options = ChatOptions {
        system_prompt: Some(SYSTEM_PROMPT.to_string()),
        max_tokens: Some(1024),
        temperature: Some(0.1),
        ..Default::default()
    };

    let response = llm.chat(&messages, &options).await?;
    debug!("LLM response: {}", response.content);

    // JSONをパース（LLMがコードブロックで囲む場合に対応）
    let json_str = extract_json(&response.content);
    let intent: Intent = serde_json::from_str(json_str)?;
    Ok(intent)
}

/// レスポンスからJSON部分を抽出する
fn extract_json(text: &str) -> &str {
    let text = text.trim();
    // ```json ... ``` を除去
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            return &text[start..=end];
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_json() {
        assert_eq!(
            extract_json(r#"```json
{"action": "add_task"}
```"#),
            r#"{"action": "add_task"}"#
        );
        assert_eq!(
            extract_json(r#"{"action": "chat"}"#),
            r#"{"action": "chat"}"#
        );
    }
}
