/*
 * LogSight 数据模型模块
 * 定义服务器配置、日志行、运行脚本等核心数据结构
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */
use chrono::{DateTime, Local, NaiveDateTime, Utc};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

/*
 * SSH 认证方式枚举
 * Password: 密码认证
 * PrivateKey: 私钥/证书认证（PEM内容或文件路径）
 * ConfigFile: 使用SSH配置文件（~/.ssh/config）
 */
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AuthType {
    Password,
    PrivateKey,
    ConfigFile,
}

impl Default for AuthType {
    fn default() -> Self {
        AuthType::Password
    }
}

/*
 * 运行脚本配置结构体
 * 支持连接后自动执行的脚本，可配置延迟毫秒数
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunScript {
    /* 脚本内容（Shell命令字符串） */
    pub content: String,
    /* 执行前延迟（毫秒），默认 500ms */
    pub delay_ms: u64,
}

impl Default for RunScript {
    fn default() -> Self {
        Self {
            content: String::new(),
            delay_ms: 500,
        }
    }
}

/*
 * 服务器连接配置结构体
 * 完全匹配截图中的字段：书签分类、标题、主机、用户名、密码/私钥/配置、端口、SSH代理、MFA、运行脚本、描述
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    /* 唯一ID，UUID v4 字符串 */
    pub id: String,
    /* 书签分类，默认 default */
    pub bookmark_category: String,
    /* 连接标题，例如 production-log-01 */
    pub title: String,
    /* 主机 IP 或域名 */
    pub host: String,
    /* SSH 端口，默认 22 */
    pub port: u16,
    /* 登录用户名，例如 www、root */
    pub username: String,
    /* 认证方式枚举 */
    pub auth_type: AuthType,
    /* 加密后的密码（Base64封装，auth_type=Password 时使用） */
    pub password_cipher: Option<String>,
    /* 加密后的私钥 PEM 内容（auth_type=PrivateKey 时使用） */
    pub private_key_cipher: Option<String>,
    /* 私钥文件路径（与 private_key_cipher 二选一） */
    pub private_key_path: Option<String>,
    /* SSH配置文件路径（auth_type=ConfigFile 时使用） */
    pub ssh_config_path: Option<String>,
    /* 是否使用 SSH Agent 代理，默认 false */
    pub use_ssh_agent: bool,
    /* 自定义 SSH Agent 套接字路径，默认空跟随系统 */
    pub ssh_agent_path: Option<String>,
    /* 是否启用 MFA/OTP 多因素认证，默认 false */
    pub use_mfa: bool,
    /* 是否允许连接成功后自动执行脚本，默认关闭 */
    #[serde(default)]
    pub run_scripts_enabled: bool,
    /* 连接成功后自动执行的脚本列表，可多个 */
    pub run_scripts: Vec<RunScript>,
    /* 连接备注描述 */
    pub description: String,
    /* 创建时间 UTC */
    pub created_at: DateTime<Utc>,
    /* 最近更新时间 UTC */
    pub updated_at: DateTime<Utc>,
    /* 最近连接时间 UTC，可选 */
    pub last_connected_at: Option<DateTime<Utc>>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            id: uuid_v4_fake(),
            bookmark_category: "default".to_string(),
            title: String::new(),
            host: String::new(),
            port: 22,
            username: String::new(),
            auth_type: AuthType::Password,
            password_cipher: None,
            private_key_cipher: None,
            private_key_path: None,
            ssh_config_path: None,
            use_ssh_agent: false,
            ssh_agent_path: None,
            use_mfa: false,
            run_scripts_enabled: false,
            run_scripts: vec![],
            description: String::new(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            last_connected_at: None,
        }
    }
}

/*
 * 日志级别枚举
 * 用于识别日志行级别并着色
 */
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
    Unknown,
}

impl Default for LogLevel {
    fn default() -> Self {
        LogLevel::Unknown
    }
}

impl LogLevel {
    /*
     * 精确映射级别 token（logback %-5level 的取值，如 INFO / WARN / ERROR）
     * 只认独立 token，不做子串包含，避免消息体或类名里的 "error" 造成误判
     */
    pub fn from_token(token: &str) -> Option<Self> {
        match token.trim().to_uppercase().as_str() {
            "TRACE" => Some(LogLevel::Trace),
            "DEBUG" => Some(LogLevel::Debug),
            "INFO" => Some(LogLevel::Info),
            "WARN" | "WARNING" => Some(LogLevel::Warn),
            "ERROR" | "SEVERE" | "ERR" => Some(LogLevel::Error),
            "FATAL" | "CRITICAL" | "PANIC" => Some(LogLevel::Fatal),
            _ => None,
        }
    }

    /*
     * 从日志行文本内容中识别日志级别
     * 优先级：
     *   1) 结构化提取 logback pattern 的 level 字段（最准，不受消息内容干扰）
     *   2) 回退到关键字包含匹配（兼容非 logback 格式，如 nginx、自定义格式）
     */
    pub fn from_text(text: &str) -> Self {
        if let Some(f) = parse_log_fields(text) {
            if f.level != LogLevel::Unknown {
                return f.level;
            }
        }
        let upper = text.to_uppercase();
        if upper.contains("FATAL") || upper.contains("CRITICAL") || upper.contains("PANIC") {
            LogLevel::Fatal
        } else if upper.contains("ERROR") || upper.contains("EXCEPTION") || upper.contains("ERR ") {
            LogLevel::Error
        } else if upper.contains("WARN") || upper.contains("WARNING") {
            LogLevel::Warn
        } else if upper.contains("INFO") || upper.contains("[INF]") {
            LogLevel::Info
        } else if upper.contains("DEBUG") || upper.contains("[DBG]") {
            LogLevel::Debug
        } else if upper.contains("TRACE") || upper.contains("[TRC]") {
            LogLevel::Trace
        } else {
            LogLevel::Unknown
        }
    }

    /* 获取级别对应的CSS颜色类名（前端使用） */
    #[allow(dead_code)]
    pub fn css_class(&self) -> &'static str {
        match self {
            LogLevel::Fatal => "log-fatal",
            LogLevel::Error => "log-error",
            LogLevel::Warn => "log-warn",
            LogLevel::Info => "log-info",
            LogLevel::Debug => "log-debug",
            _ => "text-gray-400",
        }
    }
}

/*
 * 单条日志行数据结构
 */
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LogLine {
    /* 会话内的单调行号，从0开始递增 */
    pub line_no: u64,
    /* 原始日志内容 */
    pub raw: String,
    /* 自动识别的日志级别 */
    pub level: LogLevel,
    /* 解析出的时间戳（如果能识别），否则为None，毫秒级 */
    pub timestamp_ms: Option<i64>,
    /* 来源服务器ID */
    pub server_id: String,
    /* 日志流来源 stdout=0 / stderr=1 */
    pub stream_source: u8,

    /* ===== 结构化字段（logback pattern: %d [%thread] %-5level [%X{traceId}] %logger - %msg） ===== */
    /* 线程名，如 http-nio-8088-exec-1 / scheduling-1 */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    /* MDC 链路追踪 ID（%X{traceId}）；无 MDC 时为 None，不参与链路聚合 */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    /* logger 名，如 c.e.a.service.OrderService */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logger: Option<String>,
    /* 纯消息正文（去掉时间/线程/级别/traceId/logger 前缀） */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /* 是否为上一条日志的续行（Java 异常堆栈、多行消息等非标准行） */
    #[serde(default)]
    pub is_continuation: bool,
}

/*
 * 日志会话状态枚举
 */
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SessionStatus {
    Idle,
    Connecting,
    Connected,
    Streaming,
    Disconnecting,
    Disconnected,
    Error,
}

impl Default for SessionStatus {
    fn default() -> Self {
        SessionStatus::Idle
    }
}

/*
 * Tauri IPC 统一响应包
 * 成功返回 data，失败返回 error message
 */
#[derive(Debug, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}

/* 生成一个简化版 UUID v4，避免额外依赖 uuid crate */
fn uuid_v4_fake() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 16] = rng.gen();
    hex::encode(bytes)
}

/*
 * 连接测试结果结构体
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectTestResult {
    pub success: bool,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub banner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_environment: Option<RemoteEnvironment>,
}

/*
 * 远程日志能力探测结果。
 * 当前日志命令通道以 POSIX/Unix 远程环境为第一支持目标，
 * 先把“SSH 能连通”和“日志功能可用”拆开，避免把环境不兼容误报成路径错误。
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteEnvironment {
    pub os: String,
    pub shell: String,
    pub available_commands: Vec<String>,
    pub missing_commands: Vec<String>,
    pub supported: bool,
    pub message: Option<String>,
}

/*
 * 文件/目录条目类型枚举
 */
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileKind {
    Directory,
    File,
    Symlink,
    Other,
}

impl Default for FileKind {
    fn default() -> Self {
        FileKind::Other
    }
}

/*
 * 单个目录条目结构体
 * 用于前端 Tree 组件懒加载目录树
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    /* 完整绝对路径，例如 /var/log/app/application.log */
    pub abs_path: String,
    /* 仅文件/目录名（不含路径），用于 Tree 显示 */
    pub name: String,
    /* 条目类型目录/文件/软链 */
    pub kind: FileKind,
    /* 字节大小（目录通常为 0） */
    pub size: Option<u64>,
    /* 最后修改时间 UTC 毫秒时间戳 */
    pub mtime_ms: Option<i64>,
    /* 八进制权限位，例如 0o755；前端可能展示可读字符 */
    pub mode: Option<u32>,
    /* 前端 Tree 判断 isLeaf：目录为 false，其他为 true */
    pub is_leaf: bool,
    /* 远端用户是否有读取权限（前端可点击）；无权限显示 disabled */
    pub readable: bool,
}

/*
 * 目录枚举结果结构体
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirListResult {
    /* 实际枚举并标准化后的绝对路径（含 ~ 展开，/ 归一） */
    pub normalized_path: String,
    /* 当前路径下的条目（目录优先，再按名字序） */
    pub entries: Vec<DirEntry>,
    /* 软链目标（若当前路径是 symlink） */
    pub symlink_target: Option<String>,
}

/*
 * 路径校验结果结构体
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathValidateResult {
    /* 标准化后的绝对路径 */
    pub normalized_path: String,
    /* 是否存在该路径（目录或文件） */
    pub exists: bool,
    /* 是否是目录 */
    pub is_directory: bool,
    /* 当前用户是否可读 */
    pub readable: bool,
    /* 是否为安全路径（未越界、无 null 字节/控制字符），false 表示已拦截 */
    pub safe: bool,
    /* 安全校验失败原因说明 */
    pub reason: Option<String>,
}

/* ===================== 日志结构化解析 ===================== */
/*
 * 针对 logback 标准 pattern 做一次正则提取，把一行日志拆成结构化字段
 * 目标 pattern（兼容常见 Logback 配置）：
 *   %d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level [%X{traceId}] %logger{50} - %msg%n
 * 同时兼容「无 MDC traceId」「无线程名」两种常见变体
 */

/* 完整格式：ts [thread] LEVEL [traceId] logger - msg */
static RE_LOGBACK_FULL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\s+\[(?P<thread>[^\]]*)\]\s+(?P<level>[A-Za-z]+)\s+\[(?P<trace>[^\]]*)\]\s+(?P<logger>\S+)\s+-\s(?P<msg>.*)$"
).unwrap()
});

/* 变体：ts [thread] LEVEL logger - msg（未配置 MDC traceId） */
static RE_LOGBACK_NO_MDC: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\s+\[(?P<thread>[^\]]*)\]\s+(?P<level>[A-Za-z]+)\s+(?P<logger>\S+)\s+-\s(?P<msg>.*)$"
).unwrap()
});

/* 变体：ts LEVEL logger - msg（无线程名） */
static RE_LOGBACK_PLAIN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\s+(?P<level>[A-Za-z]+)\s+(?P<logger>\S+)\s+-\s(?P<msg>.*)$"
).unwrap()
});

/* 通用时间戳正则（非 logback 格式兜底）
 * 注意：Rust regex 不支持 (?!) 前瞻，带毫秒 pattern 优先匹配即可避免歧义 */
static TS_RE_ISO_MS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\.\d{3})").unwrap());
static TS_RE_ISO: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})").unwrap());
static TS_RE_SLASH_MS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}\.\d{3})").unwrap());
static TS_RE_SLASH: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})").unwrap());
static TS_RE_TIME_ONLY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\b").unwrap());

/**
 * 把时间戳字符串解析为毫秒时间戳
 * 日志文本中的时间视为本地时间（与服务器时区一致）
 */
fn parse_ts_token(s: &str) -> Option<i64> {
    let s = s.replace('T', " ").replace(',', ".");
    let dt = if s.contains('.') {
        NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S%.f").ok()
    } else {
        NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S").ok()
    }?;
    dt.and_local_timezone(Local)
        .earliest()
        .map(|t| t.timestamp_millis())
}

/**
 * 仅从日志行首提取时间戳（毫秒级），用于非 logback 格式兜底
 * 支持：YYYY-MM-DD HH:MM:SS[.ms]、YYYY/MM/DD HH:MM:SS[.ms]、纯时间 HH:MM:SS[.ms]
 */
pub fn parse_timestamp_from_text(text: &str) -> Option<i64> {
    if let Some(m) = TS_RE_ISO_MS.captures(text) {
        if let Some(ts) = parse_ts_token(&m[1]) {
            return Some(ts);
        }
    }
    if let Some(m) = TS_RE_ISO.captures(text) {
        if let Some(ts) = parse_ts_token(&m[1]) {
            return Some(ts);
        }
    }
    if let Some(m) = TS_RE_SLASH_MS.captures(text) {
        let s = m[1].replace('/', "-");
        if let Some(ts) = parse_ts_token(&s) {
            return Some(ts);
        }
    }
    if let Some(m) = TS_RE_SLASH.captures(text) {
        let s = m[1].replace('/', "-");
        if let Some(ts) = parse_ts_token(&s) {
            return Some(ts);
        }
    }
    // 纯时间无日期（常见于 Java/MyBatis 日志）：补今天日期
    if let Some(m) = TS_RE_TIME_ONLY.captures(text) {
        let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
        let s = format!("{} {}", today, &m[1]);
        if let Some(ts) = parse_ts_token(&s) {
            return Some(ts);
        }
    }
    None
}

/*
 * 单行日志的结构化解析结果
 */
#[derive(Debug, Clone, Default)]
pub struct LogFields {
    /* 时间戳（毫秒） */
    pub timestamp_ms: Option<i64>,
    /* 线程名 */
    pub thread: Option<String>,
    /* 日志级别（结构化提取；未识别为 Unknown） */
    pub level: LogLevel,
    /* MDC traceId（空字符串归一为 None） */
    pub trace_id: Option<String>,
    /* logger 名 */
    pub logger: Option<String>,
    /* 消息正文 */
    pub message: Option<String>,
}

/**
 * 结构化解析一行日志
 * 命中 logback pattern 时返回完整字段；否则返回 None
 * 超长行（>8KB）直接跳过正则，避免极端回溯
 */
pub fn parse_log_fields(text: &str) -> Option<LogFields> {
    if text.is_empty() || text.len() > 8192 {
        return None;
    }

    if let Some(c) = RE_LOGBACK_FULL.captures(text) {
        let ts = c.name("ts").map(|m| m.as_str()).and_then(parse_ts_token);
        let trace = c
            .name("trace")
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        return Some(LogFields {
            timestamp_ms: ts,
            thread: c.name("thread").map(|m| m.as_str().to_string()),
            level: c
                .name("level")
                .and_then(|m| LogLevel::from_token(m.as_str()))
                .unwrap_or(LogLevel::Unknown),
            trace_id: if trace.is_empty() { None } else { Some(trace) },
            logger: c.name("logger").map(|m| m.as_str().to_string()),
            message: c.name("msg").map(|m| m.as_str().to_string()),
        });
    }

    if let Some(c) = RE_LOGBACK_NO_MDC.captures(text) {
        let ts = c.name("ts").map(|m| m.as_str()).and_then(parse_ts_token);
        return Some(LogFields {
            timestamp_ms: ts,
            thread: c.name("thread").map(|m| m.as_str().to_string()),
            level: c
                .name("level")
                .and_then(|m| LogLevel::from_token(m.as_str()))
                .unwrap_or(LogLevel::Unknown),
            trace_id: None,
            logger: c.name("logger").map(|m| m.as_str().to_string()),
            message: c.name("msg").map(|m| m.as_str().to_string()),
        });
    }

    if let Some(c) = RE_LOGBACK_PLAIN.captures(text) {
        let ts = c.name("ts").map(|m| m.as_str()).and_then(parse_ts_token);
        return Some(LogFields {
            timestamp_ms: ts,
            thread: None,
            level: c
                .name("level")
                .and_then(|m| LogLevel::from_token(m.as_str()))
                .unwrap_or(LogLevel::Unknown),
            trace_id: None,
            logger: c.name("logger").map(|m| m.as_str().to_string()),
            message: c.name("msg").map(|m| m.as_str().to_string()),
        });
    }

    None
}

impl LogLine {
    /**
     * 从一行原始文本构造 LogLine（结构化优先）
     * 判定规则：
     *   1) 命中 logback pattern → 主行，填充 thread / trace_id / logger / message
     *   2) 未命中但能提取时间戳 → 主行，仅有时间戳
     *   3) 都没有 → 标记为续行 is_continuation=true（Java 异常堆栈等），时间戳留空，由前端归属上一条
     * @param now_ms 无时间戳时的兜底时间戳（实时流场景用当前时间）
     */
    pub fn from_raw(line_no: u64, raw: &str, server_id: &str, now_ms: i64) -> Self {
        if let Some(f) = parse_log_fields(raw) {
            let level = if f.level != LogLevel::Unknown {
                f.level
            } else {
                LogLevel::from_text(raw)
            };
            return LogLine {
                line_no,
                raw: raw.to_string(),
                level,
                timestamp_ms: f.timestamp_ms.or(Some(now_ms)),
                server_id: server_id.to_string(),
                stream_source: 0,
                thread: f.thread,
                trace_id: f.trace_id,
                logger: f.logger,
                message: f.message,
                is_continuation: false,
            };
        }

        // 兜底：非 logback 格式，尝试提取任意时间戳
        match parse_timestamp_from_text(raw) {
            Some(ts) => LogLine {
                line_no,
                raw: raw.to_string(),
                level: LogLevel::from_text(raw),
                timestamp_ms: Some(ts),
                server_id: server_id.to_string(),
                stream_source: 0,
                thread: None,
                trace_id: None,
                logger: None,
                message: None,
                is_continuation: false,
            },
            // 无时间戳：视为上一行的续行（堆栈 / 多行消息）
            None => LogLine {
                line_no,
                raw: raw.to_string(),
                level: LogLevel::Unknown,
                timestamp_ms: None,
                server_id: server_id.to_string(),
                stream_source: 0,
                thread: None,
                trace_id: None,
                logger: None,
                message: None,
                is_continuation: true,
            },
        }
    }

    /**
     * 批量构造并校正续行归属
     * 若首行即续行（tail 从文件中间开始），降级为主行，避免出现无处归属的孤儿续行
     */
    pub fn from_raw_batch(raws: &[String], server_id: &str, now_ms: i64) -> Vec<LogLine> {
        let mut out: Vec<LogLine> = Vec::with_capacity(raws.len());
        for (i, raw) in raws.iter().enumerate() {
            let mut line = LogLine::from_raw(i as u64, raw, server_id, now_ms);
            if line.is_continuation && out.is_empty() {
                // 没有可归属的主行：降级为普通行
                line.is_continuation = false;
                line.level = LogLevel::from_text(raw);
                line.timestamp_ms = Some(now_ms);
            }
            out.push(line);
        }
        out
    }
}

/* ===================== 日志源预设 ===================== */
/*
 * 与 logback.xml 中各 appender 的输出路径一一对应：
 *   APP_FILE            -> logs/application-yyyy-MM-dd_HH.log
 *   PLATFORM_FILE       -> logs/platform/open-yyyy-MM-dd_HH.log
 *   WORKFLOW_FILE       -> logs/workflow/workflow-yyyy-MM-dd_HH.log
 *   IDENTITY_FILE       -> logs/identity/identity-yyyy-MM-dd_HH.log
 * 每个通道另有 *-error-* 专属文件，单独作为一个预设
 */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogSourcePreset {
    /* 唯一标识，如 application / platform / workflow / identity */
    pub key: String,
    /* 中文展示名 */
    pub label: String,
    /* 分组名，前端用于归类展示 */
    pub group: String,
    /* 相对于日志根目录的通配路径，如 platform/open-*.log */
    pub rel_pattern: String,
    /* 是否仅收集 ERROR（对应 *-error-*.log 专属 appender） */
    pub error_only: bool,
}

/**
 * 返回内置的日志源预设列表
 * 覆盖常见 Logback 的四条输出通道：应用 / 平台 / 工作流 / 身份服务
 */
pub fn log_source_presets() -> Vec<LogSourcePreset> {
    vec![
        LogSourcePreset {
            key: "application".into(),
            label: "应用".into(),
            group: "应用日志".into(),
            rel_pattern: "application-*.log".into(),
            error_only: false,
        },
        LogSourcePreset {
            key: "platform".into(),
            label: "平台".into(),
            group: "平台日志".into(),
            rel_pattern: "platform/open-[0-9]*.log".into(),
            error_only: false,
        },
        LogSourcePreset {
            key: "platform_error".into(),
            label: "仅错误".into(),
            group: "平台日志".into(),
            rel_pattern: "platform/open-error-*.log".into(),
            error_only: true,
        },
        LogSourcePreset {
            key: "workflow".into(),
            label: "工作流".into(),
            group: "工作流".into(),
            rel_pattern: "workflow/workflow-[0-9]*.log".into(),
            error_only: false,
        },
        LogSourcePreset {
            key: "workflow_error".into(),
            label: "仅错误".into(),
            group: "工作流".into(),
            rel_pattern: "workflow/workflow-error-*.log".into(),
            error_only: true,
        },
        LogSourcePreset {
            key: "identity".into(),
            label: "身份服务".into(),
            group: "身份服务".into(),
            rel_pattern: "identity/identity-[0-9]*.log".into(),
            error_only: false,
        },
        LogSourcePreset {
            key: "identity_error".into(),
            label: "仅错误".into(),
            group: "身份服务".into(),
            rel_pattern: "identity/identity-error-*.log".into(),
            error_only: true,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_logback_pattern_with_trace_id() {
        let raw = "2026-09-02 12:34:56.789 [http-nio-8088-exec-1] ERROR [trace-123] com.example.application.Service - request failed";
        let fields = parse_log_fields(raw).expect("should parse a Logback line");
        assert_eq!(fields.thread.as_deref(), Some("http-nio-8088-exec-1"));
        assert_eq!(fields.level, LogLevel::Error);
        assert_eq!(fields.trace_id.as_deref(), Some("trace-123"));
        assert_eq!(
            fields.logger.as_deref(),
            Some("com.example.application.Service")
        );
        assert_eq!(fields.message.as_deref(), Some("request failed"));
        assert!(fields.timestamp_ms.is_some());
    }

    #[test]
    fn treats_empty_mdc_as_no_trace_id() {
        let raw = "2026-09-02 12:34:56.789 [scheduling-1] INFO  [] com.example.application.Scheduler - tick";
        let fields = parse_log_fields(raw).expect("should parse empty MDC field");
        assert_eq!(fields.trace_id, None);
        assert_eq!(fields.level, LogLevel::Info);
    }

    #[test]
    fn primary_presets_do_not_overlap_error_files() {
        let presets = log_source_presets();
        assert_eq!(presets.len(), 7);
        for preset in presets
            .iter()
            .filter(|p| !p.error_only && p.key != "application")
        {
            assert!(preset.rel_pattern.contains("[0-9]*"));
        }
    }

    #[test]
    fn does_not_treat_database_field_as_log_timestamp() {
        let raw = "<== Row: 978, payload, 2026-06-17 18:43:59, 0";
        assert_eq!(parse_timestamp_from_text(raw), None);
        let line = LogLine::from_raw(1, raw, "server", 123);
        assert!(line.is_continuation);
        assert_eq!(line.timestamp_ms, None);
    }
}

/*
 * 日志源探测结果：某个预设在服务器上实际存在多少文件、多大、最新是哪个
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogSourceProbeResult {
    pub preset_key: String,
    pub label: String,
    pub group: String,
    /* 可直接用于打开/查询的完整 glob 绝对路径 */
    pub glob_path: String,
    /* 该通道是否存在日志文件 */
    pub exists: bool,
    /* 匹配到的文件数（按小时滚动会有很多个） */
    pub file_count: u32,
    /* 这些文件的总字节数 */
    pub total_bytes: u64,
    /* 最新（最后修改）的文件完整绝对路径 */
    pub latest_file: Option<String>,
    /* 最新文件的修改时间（毫秒） */
    pub latest_mtime_ms: Option<i64>,
    /* 诊断：base_dir/logs/ 目录下的文件列表（仅首条结果携带） */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_listing: Option<String>,
}

/* ===================== logback.xml 导入配置 ===================== */

/*
 * logback.xml 解析后的单个 appender 配置
 * 对应 <appender class="...RollingFileAppender"> 或 FileAppender
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogbackAppender {
    /* appender 名称，如 "APP_FILE" */
    pub name: String,
    /* 展示名（优先取 logger name 的最后一段，否则用 appender name） */
    pub label: String,
    /* 分组（根据 logger 层级推断，如 "com.example.platform" → "platform"） */
    pub group: String,
    /* <file> 直接路径（变量替换后） */
    pub file_path: Option<String>,
    /* <fileNamePattern> 滚动模式转 glob（%d{...} → *，变量替换后） */
    pub glob_pattern: Option<String>,
    /* 是否有 ThresholdFilter ERROR（仅收集错误日志） */
    pub error_only: bool,
}

/*
 * 服务器级别的 logback 配置（从导入的 logback.xml 解析而来）
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogbackServerConfig {
    pub server_id: String,
    pub appenders: Vec<LogbackAppender>,
    /* 从 <property name="LOG_PATH"> 或 <property name="LOG_HOME"> 提取的日志根路径 */
    pub log_base_path: Option<String>,
    /* 导入时间 ISO 8601 */
    pub imported_at: String,
}
