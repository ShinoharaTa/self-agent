use async_trait::async_trait;
use anyhow::{Result, bail};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::provider::LlmProvider;
use crate::types::*;

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL: &str = "claude-sonnet-4-20250514";

pub struct AnthropicProvider {
    client: Client,
    api_key: String,
    default_model: String,
}

impl AnthropicProvider {
    pub fn new(api_key: String) -> Self {
        Self {
            client: Client::new(),
            api_key,
            default_model: DEFAULT_MODEL.to_string(),
        }
    }

    pub fn with_model(mut self, model: String) -> Self {
        self.default_model = model;
        self
    }
}

// Anthropic APIのリクエスト/レスポンス型
#[derive(Serialize)]
struct AnthropicRequest {
    model: String,
    max_tokens: u32,
    messages: Vec<AnthropicMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Serialize)]
struct AnthropicMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicContent>,
    model: String,
    usage: AnthropicUsage,
}

#[derive(Deserialize)]
struct AnthropicContent {
    text: String,
}

#[derive(Deserialize)]
struct AnthropicUsage {
    input_tokens: u32,
    output_tokens: u32,
}

#[derive(Deserialize)]
struct AnthropicError {
    error: AnthropicErrorDetail,
}

#[derive(Deserialize)]
struct AnthropicErrorDetail {
    message: String,
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    fn name(&self) -> &str {
        "anthropic"
    }

    async fn chat(&self, messages: &[ChatMessage], options: &ChatOptions) -> Result<ChatResponse> {
        let model = options.model.clone().unwrap_or_else(|| self.default_model.clone());
        let max_tokens = options.max_tokens.unwrap_or(4096);

        // システムプロンプトとメッセージを分離
        let system = options.system_prompt.clone().or_else(|| {
            messages.iter().find(|m| matches!(m.role, Role::System)).map(|m| m.content.clone())
        });

        let api_messages: Vec<AnthropicMessage> = messages
            .iter()
            .filter(|m| !matches!(m.role, Role::System))
            .map(|m| AnthropicMessage {
                role: match m.role {
                    Role::User => "user".to_string(),
                    Role::Assistant => "assistant".to_string(),
                    Role::System => unreachable!(),
                },
                content: m.content.clone(),
            })
            .collect();

        let request = AnthropicRequest {
            model: model.clone(),
            max_tokens,
            messages: api_messages,
            system,
            temperature: options.temperature,
        };

        debug!("Sending request to Anthropic API (model={})", model);

        let response = self.client
            .post(ANTHROPIC_API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&request)
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await?;

        if !status.is_success() {
            if let Ok(err) = serde_json::from_str::<AnthropicError>(&body) {
                bail!("Anthropic API error ({}): {}", status, err.error.message);
            }
            bail!("Anthropic API error ({}): {}", status, body);
        }

        let resp: AnthropicResponse = serde_json::from_str(&body)?;
        let content = resp.content.into_iter().map(|c| c.text).collect::<Vec<_>>().join("");

        Ok(ChatResponse {
            content,
            model: resp.model,
            usage: Usage {
                input_tokens: resp.usage.input_tokens,
                output_tokens: resp.usage.output_tokens,
            },
        })
    }
}
