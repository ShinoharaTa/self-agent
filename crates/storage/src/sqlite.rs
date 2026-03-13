use anyhow::Result;
use rusqlite::Connection;
use tracing::info;

/// SQLiteデータベースラッパー
pub struct Database {
    conn: Connection,
}

impl Database {
    /// データベースを開く (ファイルが存在しなければ作成)
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        info!("Database opened at {}", path);
        let db = Self { conn };
        db.initialize()?;
        Ok(db)
    }

    /// インメモリデータベースを作成する (テスト用)
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn };
        db.initialize()?;
        Ok(db)
    }

    /// 初期テーブルを作成する
    fn initialize(&self) -> Result<()> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL DEFAULT 'todo',
                priority INTEGER DEFAULT 0,
                due_date TEXT,
                source_context TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            ",
        )?;
        info!("Database tables initialized");
        Ok(())
    }

    /// データベース接続への参照を取得する
    pub fn conn(&self) -> &Connection {
        &self.conn
    }
}
