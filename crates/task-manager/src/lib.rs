use anyhow::Result;
use self_agent_storage::{Database, CreateTask, UpdateTask, Task, TaskFilter, TaskStatus};
use tracing::info;

/// タスク管理エージェントのコア実装
pub struct TaskManager {
    db: Database,
}

impl TaskManager {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// タスクを作成
    pub fn create_task(&self, task: CreateTask) -> Result<Task> {
        let id = self.db.create_task(&task)?;
        info!("Task created: id={}, title={}", id, task.title);
        self.db.get_task(id)?.ok_or_else(|| anyhow::anyhow!("Failed to retrieve created task"))
    }

    /// タスクを取得
    pub fn get_task(&self, id: i64) -> Result<Option<Task>> {
        self.db.get_task(id)
    }

    /// タスク一覧を取得
    pub fn list_tasks(&self, filter: TaskFilter) -> Result<Vec<Task>> {
        self.db.list_tasks(&filter)
    }

    /// 今日のタスク一覧（未完了タスク）
    pub fn today_tasks(&self) -> Result<Vec<Task>> {
        let filter = TaskFilter {
            status: Some(TaskStatus::Todo),
            ..Default::default()
        };
        let mut tasks = self.db.list_tasks(&filter)?;

        // 進行中のタスクも含める
        let in_progress_filter = TaskFilter {
            status: Some(TaskStatus::InProgress),
            ..Default::default()
        };
        tasks.extend(self.db.list_tasks(&in_progress_filter)?);

        // 優先度でソート
        tasks.sort_by(|a, b| b.priority.cmp(&a.priority));
        Ok(tasks)
    }

    /// タスクを更新
    pub fn update_task(&self, id: i64, update: UpdateTask) -> Result<Option<Task>> {
        self.db.update_task(id, &update)?;
        self.db.get_task(id)
    }

    /// タスクを完了にする
    pub fn complete_task(&self, id: i64) -> Result<Option<Task>> {
        self.update_task(id, UpdateTask {
            status: Some(TaskStatus::Done),
            ..Default::default()
        })
    }

    /// タスクを削除
    pub fn delete_task(&self, id: i64) -> Result<bool> {
        self.db.delete_task(id)
    }

    /// テキストでタスクを検索
    pub fn search_tasks(&self, query: &str) -> Result<Vec<Task>> {
        let filter = TaskFilter {
            search: Some(query.to_string()),
            ..Default::default()
        };
        self.db.list_tasks(&filter)
    }

    /// タスクのサマリーを生成（LLMに渡すための文字列）
    pub fn task_summary(&self) -> Result<String> {
        let tasks = self.today_tasks()?;
        if tasks.is_empty() {
            return Ok("現在アクティブなタスクはありません。".to_string());
        }

        let mut summary = format!("## アクティブタスク ({} 件)\n\n", tasks.len());
        for task in &tasks {
            let priority_mark = match task.priority {
                self_agent_storage::TaskPriority::Urgent => "\u{1f534}",
                self_agent_storage::TaskPriority::High => "\u{1f7e0}",
                self_agent_storage::TaskPriority::Normal => "\u{1f7e1}",
                self_agent_storage::TaskPriority::Low => "\u{26aa}",
            };
            let due = task.due_date.as_deref().unwrap_or("期限なし");
            summary.push_str(&format!(
                "- {} [{}] {} ({})\n",
                priority_mark, task.status.as_str(), task.title, due
            ));
        }
        Ok(summary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> TaskManager {
        let db = Database::in_memory().unwrap();
        TaskManager::new(db)
    }

    #[test]
    fn test_create_and_get_task() {
        let tm = setup();
        let task = tm.create_task(CreateTask {
            title: "テストタスク".to_string(),
            description: Some("テスト用".to_string()),
            priority: None,
            due_date: None,
            source_context: None,
            source_channel: None,
            source_server: None,
        }).unwrap();

        assert_eq!(task.title, "テストタスク");
        assert_eq!(task.status, TaskStatus::Todo);

        let fetched = tm.get_task(task.id).unwrap().unwrap();
        assert_eq!(fetched.title, "テストタスク");
    }

    #[test]
    fn test_complete_task() {
        let tm = setup();
        let task = tm.create_task(CreateTask {
            title: "完了テスト".to_string(),
            description: None,
            priority: None,
            due_date: None,
            source_context: None,
            source_channel: None,
            source_server: None,
        }).unwrap();

        let updated = tm.complete_task(task.id).unwrap().unwrap();
        assert_eq!(updated.status, TaskStatus::Done);
    }

    #[test]
    fn test_today_tasks() {
        let tm = setup();
        tm.create_task(CreateTask {
            title: "タスク1".to_string(),
            description: None,
            priority: Some(self_agent_storage::TaskPriority::High),
            due_date: None,
            source_context: None,
            source_channel: None,
            source_server: None,
        }).unwrap();

        tm.create_task(CreateTask {
            title: "タスク2".to_string(),
            description: None,
            priority: Some(self_agent_storage::TaskPriority::Low),
            due_date: None,
            source_context: None,
            source_channel: None,
            source_server: None,
        }).unwrap();

        let tasks = tm.today_tasks().unwrap();
        assert_eq!(tasks.len(), 2);
        // 優先度順
        assert_eq!(tasks[0].title, "タスク1");
    }

    #[test]
    fn test_search_tasks() {
        let tm = setup();
        tm.create_task(CreateTask {
            title: "API設計をまとめる".to_string(),
            description: None,
            priority: None,
            due_date: None,
            source_context: None,
            source_channel: None,
            source_server: None,
        }).unwrap();

        tm.create_task(CreateTask {
            title: "ミーティング準備".to_string(),
            description: None,
            priority: None,
            due_date: None,
            source_context: None,
            source_channel: None,
            source_server: None,
        }).unwrap();

        let results = tm.search_tasks("API").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "API設計をまとめる");
    }

    #[test]
    fn test_task_summary() {
        let tm = setup();
        tm.create_task(CreateTask {
            title: "テストタスク".to_string(),
            description: None,
            priority: Some(self_agent_storage::TaskPriority::High),
            due_date: None,
            source_context: None,
            source_channel: None,
            source_server: None,
        }).unwrap();

        let summary = tm.task_summary().unwrap();
        assert!(summary.contains("テストタスク"));
        assert!(summary.contains("1 件"));
    }
}
