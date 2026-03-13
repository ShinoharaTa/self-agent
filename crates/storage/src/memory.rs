use anyhow::Result;
use std::path::{Path, PathBuf};
use tracing::info;

/// 階層型MEMORY.md管理
pub struct MemoryStore {
    base_path: PathBuf,
}

impl MemoryStore {
    pub fn new(base_path: impl AsRef<Path>) -> Result<Self> {
        let base = base_path.as_ref().to_path_buf();
        // ディレクトリ構造を作成
        std::fs::create_dir_all(base.join("agents"))?;
        std::fs::create_dir_all(base.join("context"))?;
        info!("MemoryStore initialized at {}", base.display());
        Ok(Self { base_path: base })
    }

    /// グローバル記憶を読み込む
    pub fn load_global(&self) -> Result<String> {
        self.load_file("global.md")
    }

    /// グローバル記憶を保存する
    pub fn save_global(&self, content: &str) -> Result<()> {
        self.save_file("global.md", content)
    }

    /// エージェント固有の記憶を読み込む
    pub fn load_agent(&self, agent_name: &str) -> Result<String> {
        self.load_file(&format!("agents/{}.md", agent_name))
    }

    /// エージェント固有の記憶を保存する
    pub fn save_agent(&self, agent_name: &str, content: &str) -> Result<()> {
        self.save_file(&format!("agents/{}.md", agent_name), content)
    }

    /// コンテキスト記憶を読み込む
    pub fn load_context(&self, name: &str) -> Result<String> {
        self.load_file(&format!("context/{}.md", name))
    }

    /// コンテキスト記憶を保存する
    pub fn save_context(&self, name: &str, content: &str) -> Result<()> {
        self.save_file(&format!("context/{}.md", name), content)
    }

    /// ファイルを読み込む（存在しない場合は空文字列）
    fn load_file(&self, relative: &str) -> Result<String> {
        let path = self.base_path.join(relative);
        if path.exists() {
            Ok(std::fs::read_to_string(path)?)
        } else {
            Ok(String::new())
        }
    }

    /// ファイルを保存する
    fn save_file(&self, relative: &str, content: &str) -> Result<()> {
        let path = self.base_path.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, content)?;
        Ok(())
    }

    /// 全エージェントの記憶ファイル一覧
    pub fn list_agent_memories(&self) -> Result<Vec<String>> {
        let agents_dir = self.base_path.join("agents");
        let mut names = Vec::new();
        if agents_dir.exists() {
            for entry in std::fs::read_dir(agents_dir)? {
                let entry = entry?;
                if let Some(name) = entry.path().file_stem() {
                    names.push(name.to_string_lossy().to_string());
                }
            }
        }
        Ok(names)
    }
}
