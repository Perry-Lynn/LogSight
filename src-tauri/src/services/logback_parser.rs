/*
 * logback.xml 解析器
 * 从 logback 配置文件中提取 appender 路径和滚动规则，
 * 用于替代硬编码的日志源预设，适配不同项目
 * @Author: fu
 * @Date: 2026-09-07
 */
use anyhow::{anyhow, Result};
use chrono::Utc;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use std::collections::HashMap;

use crate::models::{LogbackAppender, LogbackServerConfig};

/* ==================== 公开接口 ==================== */

/**
 * 解析 logback.xml 内容，提取 appender 配置
 * @param xml_content logback.xml 文件的完整文本
 * @param server_id 绑定的服务器 ID
 */
pub fn parse_logback_xml(xml_content: &str, server_id: &str) -> Result<LogbackServerConfig> {
    let mut reader = Reader::from_str(xml_content);
    reader.config_mut().trim_text(true);

    let mut properties: HashMap<String, String> = HashMap::new();
    let mut appenders: Vec<RawAppender> = Vec::new();
    let mut loggers: Vec<RawLogger> = Vec::new();

    /* 解析状态机 */
    let mut current_appender: Option<RawAppender> = None;
    let mut current_logger: Option<RawLogger> = None;
    let mut text_buf = String::new();

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let tag = local_name_start(e);
                match tag.as_str() {
                    "appender" => {
                        current_appender = Some(RawAppender::from_attrs(e));
                    }
                    "logger" | "root" => {
                        current_logger = Some(RawLogger::from_attrs(e));
                    }
                    "filter" => {
                        if let Some(ref mut app) = current_appender {
                            let class = get_attr(e, "class").unwrap_or_default();
                            if class.contains("ThresholdFilter") {
                                app.is_threshold_filter = true;
                            }
                        }
                    }
                    _ => {
                        text_buf.clear();
                    }
                }
            }
            Ok(Event::Empty(ref e)) => {
                let tag = local_name_start(e);
                match tag.as_str() {
                    "property" => {
                        parse_property(e, &mut properties);
                    }
                    "appender-ref" => {
                        if let Some(ref mut logger) = current_logger {
                            if let Some(ref_val) = get_attr(e, "ref") {
                                logger.appender_refs.push(ref_val);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref e)) => {
                if let Ok(s) = e.unescape() {
                    text_buf.push_str(&s);
                }
            }
            Ok(Event::End(ref e)) => {
                let tag = local_name_end(e);
                match tag.as_str() {
                    "appender" => {
                        if let Some(mut app) = current_appender.take() {
                            app.finish(&mut text_buf);
                            appenders.push(app);
                        }
                    }
                    "logger" | "root" => {
                        if let Some(logger) = current_logger.take() {
                            loggers.push(logger);
                        }
                    }
                    "filter" => {
                        if let Some(ref mut app) = current_appender {
                            app.is_threshold_filter = false;
                        }
                    }
                    "file" => {
                        if let Some(ref mut app) = current_appender {
                            app.file = Some(text_buf.trim().to_string());
                        }
                    }
                    "fileNamePattern" => {
                        if let Some(ref mut app) = current_appender {
                            app.file_name_pattern = Some(text_buf.trim().to_string());
                        }
                    }
                    "level" => {
                        if let Some(ref mut app) = current_appender {
                            if app.is_threshold_filter {
                                app.filter_level = Some(text_buf.trim().to_uppercase());
                            }
                        }
                    }
                    _ => {}
                }
                text_buf.clear();
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow!("解析 logback.xml 失败: {}", e)),
            _ => {}
        }
        buf.clear();
    }

    /* 建立 appender name → logger name 映射（命名 logger 优先于 root） */
    let mut appender_to_logger: HashMap<String, String> = HashMap::new();
    for logger in &loggers {
        if logger.name == "root" {
            continue;
        }
        for ref_name in &logger.appender_refs {
            appender_to_logger
                .entry(ref_name.clone())
                .or_insert_with(|| logger.name.clone());
        }
    }
    /* root 的引用作为 fallback（仅当没有命名 logger 引用该 appender 时） */
    for logger in &loggers {
        if logger.name != "root" {
            continue;
        }
        for ref_name in &logger.appender_refs {
            appender_to_logger
                .entry(ref_name.clone())
                .or_insert_with(|| logger.name.clone());
        }
    }

    /* 提取 LOG_PATH / LOG_HOME 等常见属性 */
    let log_base_path = properties
        .get("LOG_PATH")
        .or_else(|| properties.get("LOG_HOME"))
        .or_else(|| properties.get("log.path"))
        .or_else(|| properties.get("log.home"))
        .cloned();

    /* 转换 RawAppender → LogbackAppender */
    let result_appenders: Vec<LogbackAppender> = appenders
        .into_iter()
        .filter_map(|raw| {
            if !raw.is_file_appender {
                return None;
            }
            let file = raw.file.map(|f| substitute_vars(&f, &properties));
            let pattern = raw
                .file_name_pattern
                .map(|p| substitute_vars(&p, &properties));
            let glob = pattern.as_ref().map(|p| pattern_to_glob(p));

            let error_only = raw
                .filter_level
                .as_ref()
                .map(|l| l == "ERROR" || l == "FATAL" || l == "SEVERE")
                .unwrap_or(false);

            /* 从关联 logger 推断 label 和 group */
            let logger_name = appender_to_logger.get(&raw.name).cloned();
            let (label, group) = infer_label_and_group(&raw.name, logger_name.as_deref());

            /* 至少要有 file 或 glob_pattern 之一 */
            if file.is_none() && glob.is_none() {
                return None;
            }

            Some(LogbackAppender {
                name: raw.name,
                label,
                group,
                file_path: file,
                glob_pattern: glob,
                error_only,
            })
        })
        .collect();

    if result_appenders.is_empty() {
        return Err(anyhow!("未在 logback.xml 中找到有效的文件 appender"));
    }

    Ok(LogbackServerConfig {
        server_id: server_id.to_string(),
        appenders: result_appenders,
        log_base_path,
        imported_at: Utc::now().to_rfc3339(),
    })
}

/* ==================== 内部数据结构 ==================== */

/* 解析过程中的 appender 原始数据 */
struct RawAppender {
    name: String,
    is_file_appender: bool,
    file: Option<String>,
    file_name_pattern: Option<String>,
    is_threshold_filter: bool,
    filter_level: Option<String>,
}

impl RawAppender {
    fn from_attrs(e: &BytesStart) -> Self {
        let class = get_attr(e, "class").unwrap_or_default();
        let is_file_appender =
            class.contains("RollingFileAppender") || class.contains("FileAppender");
        Self {
            name: get_attr(e, "name").unwrap_or_default(),
            is_file_appender,
            file: None,
            file_name_pattern: None,
            is_threshold_filter: false,
            filter_level: None,
        }
    }

    fn finish(&mut self, _text_buf: &mut String) {
        /* 预留：可用于后处理 */
    }
}

/* 解析过程中的 logger 原始数据 */
struct RawLogger {
    name: String,
    appender_refs: Vec<String>,
}

impl RawLogger {
    fn from_attrs(e: &BytesStart) -> Self {
        Self {
            name: get_attr(e, "name").unwrap_or_else(|| "root".to_string()),
            appender_refs: Vec::new(),
        }
    }
}

/* ==================== 辅助函数 ==================== */

/* 提取 XML 元素的 local name（不含 namespace 前缀），支持 Start 和 End 事件 */
fn local_name_start(e: &BytesStart) -> String {
    String::from_utf8_lossy(e.name().as_ref()).to_string()
}

fn local_name_end(e: &quick_xml::events::BytesEnd) -> String {
    String::from_utf8_lossy(e.name().as_ref()).to_string()
}

/* 获取 XML 属性值 */
fn get_attr(e: &BytesStart, attr_name: &str) -> Option<String> {
    for attr_result in e.attributes() {
        if let Ok(attr) = attr_result {
            if attr.key.as_ref() == attr_name.as_bytes() {
                return Some(String::from_utf8_lossy(&attr.value).to_string());
            }
        }
    }
    None
}

/* 解析 <property name="X" value="Y"/> 到 properties map */
fn parse_property(e: &BytesStart, properties: &mut HashMap<String, String>) {
    if let (Some(name), Some(value)) = (get_attr(e, "name"), get_attr(e, "value")) {
        properties.insert(name, value);
    }
}

/*
 * ${VAR} 变量替换
 * 支持 ${VAR} 和 ${VAR:-default} 两种格式
 */
fn substitute_vars(template: &str, properties: &HashMap<String, String>) -> String {
    let mut result = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '$' && chars.peek() == Some(&'{') {
            chars.next(); /* consume '{' */
            let mut var_name = String::new();
            let mut default_val: Option<String> = None;
            let mut found_close = false;

            while let Some(&c) = chars.peek() {
                if c == '}' {
                    chars.next();
                    found_close = true;
                    break;
                }
                if c == ':' && default_val.is_none() {
                    /* 检查 :- 默认值语法 */
                    chars.next();
                    if chars.peek() == Some(&'-') {
                        chars.next();
                        default_val = Some(String::new());
                        continue;
                    } else {
                        var_name.push(':');
                        continue;
                    }
                }
                if let Some(ref mut def) = default_val {
                    def.push(c);
                } else {
                    var_name.push(c);
                }
                chars.next();
            }

            if found_close {
                if let Some(val) = properties.get(&var_name) {
                    result.push_str(val);
                } else if let Some(def) = default_val {
                    result.push_str(&def);
                } else {
                    /* 未找到变量，保留原样 */
                    result.push_str(&format!("${{{}}}", var_name));
                }
            } else {
                result.push_str("${");
                result.push_str(&var_name);
                if let Some(def) = default_val {
                    result.push_str(":-");
                    result.push_str(&def);
                }
            }
        } else {
            result.push(ch);
        }
    }
    result
}

/*
 * 将 logback fileNamePattern 转换为 glob 模式
 * %d{...} → *
 * %i → *
 * 其他 % 转换保留
 */
fn pattern_to_glob(pattern: &str) -> String {
    let mut result = String::with_capacity(pattern.len());
    let mut chars = pattern.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '%' {
            match chars.peek() {
                Some(&'d') => {
                    chars.next();
                    if chars.peek() == Some(&'{') {
                        /* 跳过 %d{...} */
                        chars.next();
                        let mut depth = 1;
                        while let Some(&c) = chars.peek() {
                            chars.next();
                            if c == '{' {
                                depth += 1;
                            }
                            if c == '}' {
                                depth -= 1;
                                if depth == 0 {
                                    break;
                                }
                            }
                        }
                    }
                    result.push('*');
                }
                Some(&'i') => {
                    chars.next();
                    result.push('*');
                }
                _ => {
                    result.push('%');
                }
            }
        } else {
            result.push(ch);
        }
    }
    result
}

/*
 * 从 logger 名称推断展示标签和分组
 * 例如：
 *   "com.example.platform" → ("platform", "example.platform")
 *   "APP_FILE" → ("APP_FILE", "默认")
 */
fn infer_label_and_group(appender_name: &str, logger_name: Option<&str>) -> (String, String) {
    if let Some(logger) = logger_name {
        let parts: Vec<&str> = logger.split('.').collect();
        /* 取最后一段作为 label */
        let label = parts
            .last()
            .map(|s| s.to_string())
            .unwrap_or_else(|| appender_name.to_string());

        /* 取最后 2-3 段作为 group 的提示 */
        let group = if parts.len() >= 3 {
            parts[parts.len() - 2..].join(".")
        } else {
            label.clone()
        };

        (label, group)
    } else {
        /* 无关联 logger，使用 appender name */
        let label = appender_name.to_string();
        (label.clone(), "默认".to_string())
    }
}

/* ==================== 单元测试 ==================== */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_substitute_vars() {
        let mut props = HashMap::new();
        props.insert("LOG_PATH".to_string(), "/var/log/app".to_string());
        props.insert("APP_NAME".to_string(), "application".to_string());

        assert_eq!(
            substitute_vars("${LOG_PATH}/application.log", &props),
            "/var/log/app/application.log"
        );
        assert_eq!(
            substitute_vars("${MISSING:-default}/file.log", &props),
            "default/file.log"
        );
        assert_eq!(
            substitute_vars("${MISSING}/file.log", &props),
            "${MISSING}/file.log"
        );
    }

    #[test]
    fn test_pattern_to_glob() {
        assert_eq!(
            pattern_to_glob("/var/log/application-%d{yyyy-MM-dd_HH}.log"),
            "/var/log/application-*.log"
        );
        assert_eq!(
            pattern_to_glob("/var/log/app-%d{yyyy-MM-dd}.%i.log"),
            "/var/log/app-*.*.log"
        );
    }

    #[test]
    fn test_infer_label_and_group() {
        let (label, group) = infer_label_and_group("APP_FILE", Some("com.example.platform"));
        assert_eq!(label, "platform");
        assert_eq!(group, "example.platform");

        let (label, group) = infer_label_and_group("APP_FILE", None);
        assert_eq!(label, "APP_FILE");
        assert_eq!(group, "默认");
    }

    #[test]
    fn test_parse_simple_logback() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <property name="LOG_PATH" value="/var/log/app"/>

    <appender name="APP_FILE" class="ch.qos.logback.core.rolling.RollingFileAppender">
        <file>${LOG_PATH}/application.log</file>
        <rollingPolicy class="ch.qos.logback.core.rolling.TimeBasedRollingPolicy">
            <fileNamePattern>${LOG_PATH}/application-%d{yyyy-MM-dd_HH}.log</fileNamePattern>
            <maxHistory>168</maxHistory>
        </rollingPolicy>
        <encoder>
            <pattern>%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level %logger{50} - %msg%n</pattern>
        </encoder>
    </appender>

    <appender name="APP_ERROR" class="ch.qos.logback.core.rolling.RollingFileAppender">
        <file>${LOG_PATH}/application-error.log</file>
        <filter class="ch.qos.logback.classic.filter.ThresholdFilter">
            <level>ERROR</level>
        </filter>
        <rollingPolicy class="ch.qos.logback.core.rolling.TimeBasedRollingPolicy">
            <fileNamePattern>${LOG_PATH}/application-error-%d{yyyy-MM-dd_HH}.log</fileNamePattern>
        </rollingPolicy>
    </appender>

    <logger name="com.example.application" level="INFO" additivity="false">
        <appender-ref ref="APP_FILE"/>
        <appender-ref ref="APP_ERROR"/>
    </logger>

    <root level="INFO">
        <appender-ref ref="APP_FILE"/>
    </root>
</configuration>"#;

        let config = parse_logback_xml(xml, "test-server").unwrap();
        assert_eq!(config.server_id, "test-server");
        assert_eq!(config.log_base_path, Some("/var/log/app".to_string()));
        assert_eq!(config.appenders.len(), 2);

        let app = &config.appenders[0];
        assert_eq!(app.name, "APP_FILE");
        assert_eq!(app.label, "application");
        assert_eq!(
            app.file_path,
            Some("/var/log/app/application.log".to_string())
        );
        assert_eq!(
            app.glob_pattern,
            Some("/var/log/app/application-*.log".to_string())
        );
        assert!(!app.error_only);

        let err = &config.appenders[1];
        assert_eq!(err.name, "APP_ERROR");
        assert!(err.error_only);
    }
}
