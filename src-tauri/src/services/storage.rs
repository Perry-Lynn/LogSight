/*
 * LogSight 本地 KV 存储服务模块
 * 使用 sled 嵌入式数据库持久化保存服务器配置与应用设置
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */
use anyhow::{Result, Context, anyhow};
use sled::Db;
use std::path::PathBuf;
use std::sync::Arc;
use parking_lot::RwLock;
use once_cell::sync::OnceCell;
use serde::{de::DeserializeOwned, Serialize};

use crate::models::{ServerConfig, LogbackServerConfig};

/* 存储服务全局单例 */
static STORAGE_INSTANCE: OnceCell<Arc<StorageService>> = OnceCell::new();

/*
 * 存储服务结构体
 * 封装 sled KV 数据库，提供服务器配置 CRUD 与主密码保存功能
 */
pub struct StorageService {
    /* sled 数据库实例 */
    #[allow(dead_code)]
    db: Db,
    /* 服务器配置表树，key=server_id, value=ServerConfig JSON */
    servers: sled::Tree,
    /* 应用设置表树，如主密码 hash、窗口大小、UI 主题 */
    settings: sled::Tree,
    /* logback 配置表树，key=server_id, value=LogbackServerConfig JSON */
    logback_configs: sled::Tree,
    /* 读写锁，防止并发写冲突 */
    lock: RwLock<()>,
}

impl StorageService {
    /*
     * 初始化存储服务（单例）
     * 在 AppData 目录下创建 logsight-db 文件夹作为 sled 数据库目录
     */
    pub fn init(app_data_dir: PathBuf) -> Result<Arc<Self>> {
        STORAGE_INSTANCE
            .get_or_try_init(|| -> Result<Arc<Self>> {
                let db_dir = app_data_dir.join("logsight-db");
                std::fs::create_dir_all(&db_dir)
                    .with_context(|| format!("创建数据库目录失败: {:?}", db_dir))?;

                let db = sled::open(&db_dir)
                    .with_context(|| format!("打开 sled 数据库失败: {:?}", db_dir))?;
                let servers = db.open_tree("servers")?;
                let settings = db.open_tree("settings")?;
                let logback_configs = db.open_tree("logback_configs")?;

                Ok(Arc::new(Self {
                    db,
                    servers,
                    settings,
                    logback_configs,
                    lock: RwLock::new(()),
                }))
            })
            .cloned()
    }

    /* 获取已初始化的全局单例（若未初始化则返回错误） */
    #[allow(dead_code)]
    pub fn get() -> Result<Arc<Self>> {
        STORAGE_INSTANCE.get()
            .cloned()
            .ok_or_else(|| anyhow!("StorageService 尚未初始化，请先调用 init()"))
    }

    /*
     * 通用 JSON 序列化写入指定 tree
     */
    fn put_json<V: Serialize>(&self, tree: &sled::Tree, key: &[u8], value: &V) -> Result<()> {
        let _g = self.lock.write();
        let bytes = serde_json::to_vec(value).context("JSON 序列化失败")?;
        tree.insert(key, bytes)?;
        tree.flush()?;
        Ok(())
    }

    /*
     * 通用 JSON 反序列化读取指定 tree
     */
    fn get_json<V: DeserializeOwned>(&self, tree: &sled::Tree, key: &[u8]) -> Result<Option<V>> {
        let _g = self.lock.read();
        match tree.get(key)? {
            Some(ivec) => {
                let v: V = serde_json::from_slice(&ivec).context("JSON 反序列化失败")?;
                Ok(Some(v))
            }
            None => Ok(None),
        }
    }

    /* ===== 服务器配置 CRUD ===== */

    /* 新增或更新一个服务器配置 */
    pub fn save_server(&self, server: &ServerConfig) -> Result<()> {
        self.put_json(&self.servers, server.id.as_bytes(), server)
    }

    /* 根据 ID 获取单个服务器配置 */
    pub fn get_server(&self, id: &str) -> Result<Option<ServerConfig>> {
        self.get_json(&self.servers, id.as_bytes())
    }

    /* 删除指定 ID 的服务器配置 */
    pub fn delete_server(&self, id: &str) -> Result<bool> {
        let _g = self.lock.write();
        let existed = self.servers.remove(id.as_bytes())?.is_some();
        self.servers.flush()?;
        Ok(existed)
    }

    /* 列出所有已保存的服务器配置 */
    pub fn list_servers(&self) -> Result<Vec<ServerConfig>> {
        let _g = self.lock.read();
        let mut list: Vec<ServerConfig> = Vec::new();
        for item in self.servers.iter() {
            let (_k, v) = item?;
            if let Ok(s) = serde_json::from_slice::<ServerConfig>(&v) {
                list.push(s);
            }
        }
        // 按最近连接时间倒序，未连接的按创建时间倒序
        list.sort_by(|a, b| {
            let ta = a.last_connected_at.unwrap_or(a.created_at);
            let tb = b.last_connected_at.unwrap_or(b.created_at);
            tb.cmp(&ta)
        });
        Ok(list)
    }

    /* ===== 应用设置 ===== */

    /* 保存应用主密码 cipher（加密过的哨兵值，用于下次验证密码正确性） */
    pub fn set_master_sentinel(&self, cipher: &str) -> Result<()> {
        self.put_json(&self.settings, b"master_sentinel", &cipher.to_string())
    }

    /* 获取之前保存的主密码哨兵密文 */
    pub fn get_master_sentinel(&self) -> Result<Option<String>> {
        self.get_json(&self.settings, b"master_sentinel")
    }

    /* 保存通用设置 */
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.put_json(&self.settings, key.as_bytes(), &value.to_string())
    }

    /* 读取通用设置 */
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        self.get_json(&self.settings, key.as_bytes())
    }

    /* ===== logback 配置 CRUD ===== */

    /* 保存服务器的 logback 配置 */
    pub fn save_logback_config(&self, config: &LogbackServerConfig) -> Result<()> {
        self.put_json(&self.logback_configs, config.server_id.as_bytes(), config)
    }

    /* 获取服务器的 logback 配置 */
    pub fn get_logback_config(&self, server_id: &str) -> Result<Option<LogbackServerConfig>> {
        self.get_json(&self.logback_configs, server_id.as_bytes())
    }

    /* 删除服务器的 logback 配置 */
    pub fn delete_logback_config(&self, server_id: &str) -> Result<bool> {
        let _g = self.lock.write();
        let existed = self.logback_configs.remove(server_id.as_bytes())?.is_some();
        self.logback_configs.flush()?;
        Ok(existed)
    }
}
