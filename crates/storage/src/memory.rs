use anyhow::Result;
use std::path::Path;

/// MEMORY.md ベースのエージェント記憶管理
pub struct MemoryStore {
    path: String,
}

impl MemoryStore {
    /// MEMORY.mdファイルのパスを指定して初期化
    pub fn new(path: &str) -> Self {
        Self {
            path: path.to_string(),
        }
    }

    /// 記憶ファイルが存在するか確認
    pub fn exists(&self) -> bool {
        Path::new(&self.path).exists()
    }

    /// 記憶内容を読み込む
    pub fn load(&self) -> Result<String> {
        let content = std::fs::read_to_string(&self.path)?;
        Ok(content)
    }

    /// 記憶内容を保存する
    pub fn save(&self, content: &str) -> Result<()> {
        std::fs::write(&self.path, content)?;
        Ok(())
    }
}
