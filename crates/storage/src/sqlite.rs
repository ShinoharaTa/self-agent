use anyhow::Result;
use rusqlite::{params, Connection};
use tracing::info;

use crate::models::*;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn open(path: &str) -> Result<Self> {
        // ディレクトリが存在しない場合は作成
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        info!("Database opened at {}", path);
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch("
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL DEFAULT 'todo',
                priority INTEGER NOT NULL DEFAULT 1,
                due_date TEXT,
                source_context TEXT,
                source_channel TEXT,
                source_server TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER REFERENCES tasks(id),
                message TEXT NOT NULL,
                remind_at TEXT NOT NULL,
                is_fired INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS conversation_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                server_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                author TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
            CREATE INDEX IF NOT EXISTS idx_reminders_remind_at ON reminders(remind_at);
            CREATE INDEX IF NOT EXISTS idx_reminders_is_fired ON reminders(is_fired);
            CREATE INDEX IF NOT EXISTS idx_conversation_logs_timestamp ON conversation_logs(timestamp);

            CREATE TABLE IF NOT EXISTS system_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        ")?;
        info!("Database migration complete");
        Ok(())
    }

    // --- タスク CRUD ---

    pub fn create_task(&self, task: &CreateTask) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO tasks (title, description, priority, due_date, source_context, source_channel, source_server) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                task.title,
                task.description,
                task.priority.as_ref().map(|p| p.as_i32()).unwrap_or(1),
                task.due_date,
                task.source_context,
                task.source_channel,
                task.source_server,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_task(&self, id: i64) -> Result<Option<Task>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, description, status, priority, due_date, source_context, source_channel, source_server, created_at, updated_at FROM tasks WHERE id = ?1"
        )?;
        let mut rows = stmt.query_map(params![id], |row| {
            Ok(Task {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                status: TaskStatus::from_str(&row.get::<_, String>(3)?),
                priority: TaskPriority::from_i32(row.get(4)?),
                due_date: row.get(5)?,
                source_context: row.get(6)?,
                source_channel: row.get(7)?,
                source_server: row.get(8)?,
                created_at: row.get::<_, String>(9)?.parse().unwrap_or_default(),
                updated_at: row.get::<_, String>(10)?.parse().unwrap_or_default(),
            })
        })?;
        match rows.next() {
            Some(Ok(task)) => Ok(Some(task)),
            Some(Err(e)) => Err(e.into()),
            None => Ok(None),
        }
    }

    pub fn list_tasks(&self, filter: &TaskFilter) -> Result<Vec<Task>> {
        let mut sql = "SELECT id, title, description, status, priority, due_date, source_context, source_channel, source_server, created_at, updated_at FROM tasks WHERE 1=1".to_string();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];

        if let Some(ref status) = filter.status {
            sql.push_str(" AND status = ?");
            values.push(Box::new(status.as_str().to_string()));
        }
        if let Some(ref priority) = filter.priority {
            sql.push_str(" AND priority = ?");
            values.push(Box::new(priority.as_i32()));
        }
        if let Some(ref search) = filter.search {
            sql.push_str(" AND (title LIKE ? OR description LIKE ?)");
            let pattern = format!("%{}%", search);
            values.push(Box::new(pattern.clone()));
            values.push(Box::new(pattern));
        }

        sql.push_str(" ORDER BY priority DESC, created_at DESC");

        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            Ok(Task {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                status: TaskStatus::from_str(&row.get::<_, String>(3)?),
                priority: TaskPriority::from_i32(row.get(4)?),
                due_date: row.get(5)?,
                source_context: row.get(6)?,
                source_channel: row.get(7)?,
                source_server: row.get(8)?,
                created_at: row.get::<_, String>(9)?.parse().unwrap_or_default(),
                updated_at: row.get::<_, String>(10)?.parse().unwrap_or_default(),
            })
        })?;

        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row?);
        }
        Ok(tasks)
    }

    pub fn update_task(&self, id: i64, update: &UpdateTask) -> Result<bool> {
        let mut sets = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref title) = update.title {
            sets.push("title = ?");
            values.push(Box::new(title.clone()));
        }
        if let Some(ref desc) = update.description {
            sets.push("description = ?");
            values.push(Box::new(desc.clone()));
        }
        if let Some(ref status) = update.status {
            sets.push("status = ?");
            values.push(Box::new(status.as_str().to_string()));
        }
        if let Some(ref priority) = update.priority {
            sets.push("priority = ?");
            values.push(Box::new(priority.as_i32()));
        }
        if let Some(ref due) = update.due_date {
            sets.push("due_date = ?");
            values.push(Box::new(due.clone()));
        }

        if sets.is_empty() {
            return Ok(false);
        }

        sets.push("updated_at = datetime('now')");
        values.push(Box::new(id));

        let sql = format!("UPDATE tasks SET {} WHERE id = ?", sets.join(", "));
        let params_refs: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        let affected = self.conn.execute(&sql, params_refs.as_slice())?;
        Ok(affected > 0)
    }

    pub fn delete_task(&self, id: i64) -> Result<bool> {
        let affected = self.conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    // --- リマインダー ---

    pub fn create_reminder(&self, reminder: &CreateReminder) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO reminders (task_id, message, remind_at) VALUES (?1, ?2, ?3)",
            params![reminder.task_id, reminder.message, reminder.remind_at.to_rfc3339()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_pending_reminders(&self) -> Result<Vec<Reminder>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, message, remind_at, is_fired, created_at FROM reminders WHERE is_fired = 0 AND remind_at <= datetime('now') ORDER BY remind_at ASC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Reminder {
                id: row.get(0)?,
                task_id: row.get(1)?,
                message: row.get(2)?,
                remind_at: row.get::<_, String>(3)?.parse().unwrap_or_default(),
                is_fired: row.get::<_, i32>(4)? != 0,
                created_at: row.get::<_, String>(5)?.parse().unwrap_or_default(),
            })
        })?;
        let mut reminders = Vec::new();
        for row in rows {
            reminders.push(row?);
        }
        Ok(reminders)
    }

    pub fn mark_reminder_fired(&self, id: i64) -> Result<()> {
        self.conn.execute("UPDATE reminders SET is_fired = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- 会話ログ ---

    pub fn log_conversation(&self, platform: &str, server_id: &str, channel_id: &str, author: &str, content: &str) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO conversation_logs (platform, server_id, channel_id, author, content) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![platform, server_id, channel_id, author, content],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_recent_context(&self, channel_id: &str, limit: usize) -> Result<Vec<ConversationLog>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, platform, server_id, channel_id, author, content, timestamp FROM conversation_logs WHERE channel_id = ?1 ORDER BY timestamp DESC LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![channel_id, limit as i64], |row| {
            Ok(ConversationLog {
                id: row.get(0)?,
                platform: row.get(1)?,
                server_id: row.get(2)?,
                channel_id: row.get(3)?,
                author: row.get(4)?,
                content: row.get(5)?,
                timestamp: row.get::<_, String>(6)?.parse().unwrap_or_default(),
            })
        })?;
        let mut logs = Vec::new();
        for row in rows {
            logs.push(row?);
        }
        logs.reverse(); // 古い順に
        Ok(logs)
    }

    // --- システム設定 (key-value) ---

    pub fn set_config(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO system_config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_config(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT value FROM system_config WHERE key = ?1",
        )?;
        let mut rows = stmt.query_map(params![key], |row| row.get(0))?;
        match rows.next() {
            Some(Ok(val)) => Ok(Some(val)),
            Some(Err(e)) => Err(e.into()),
            None => Ok(None),
        }
    }

    pub fn delete_config(&self, key: &str) -> Result<bool> {
        let affected = self.conn.execute(
            "DELETE FROM system_config WHERE key = ?1",
            params![key],
        )?;
        Ok(affected > 0)
    }

    pub fn list_config(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT key, value FROM system_config ORDER BY key",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut configs = Vec::new();
        for row in rows {
            configs.push(row?);
        }
        Ok(configs)
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }
}
