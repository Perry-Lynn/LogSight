/*
 * LogSight 日志流服务模块（适配 ssh2 同步版）
 * 封装 tail -F 实时流、历史日志分页、grep 关键字搜索
 * 通过 Tauri Event System 将日志行推送给前端
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */
use anyhow::{anyhow, Result};
use chrono::{Local, TimeZone, Utc};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

use crate::models::{
    log_source_presets, parse_log_fields, LogLevel, LogLine, LogSourceProbeResult,
    LogbackServerConfig, ServerConfig, SessionStatus,
};
use crate::services::ssh::prevalidate_glob_path_str;
use crate::services::SSHService;

/* 活动日志会话注册表：session_id -> 停止信号发送端（std sync mpsc） */
static LIVE_SESSIONS: Lazy<Mutex<HashMap<String, std::sync::mpsc::Sender<()>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/* 时间戳与结构化解析已统一收敛至 models.rs：
 * - parse_log_fields：logback pattern 结构化提取（ts/thread/level/traceId/logger/message）
 * - parse_timestamp_from_text：非 logback 格式的时间戳兜底
 * 本模块只负责取日志与拼装 LogLine，不再重复实现解析逻辑 */

/* 日志流服务 */
pub struct LogStreamService;

impl LogStreamService {
    /* 发射会话状态事件 */
    fn emit_status(
        app: &AppHandle,
        session_id: &str,
        server_id: &str,
        status: SessionStatus,
        message: Option<&str>,
    ) {
        let payload = serde_json::json!({
            "session_id": session_id,
            "server_id": server_id,
            "status": status,
            "message": message,
            "timestamp_ms": Utc::now().timestamp_millis(),
        });
        let _ = app.emit("log-session-status", &payload);
    }

    /* 发射一批日志行事件 */
    fn emit_lines(app: &AppHandle, session_id: &str, server_id: &str, lines: Vec<LogLine>) {
        let payload = serde_json::json!({
            "session_id": session_id,
            "server_id": server_id,
            "lines": lines,
        });
        let _ = app.emit("log-lines", &payload);
    }

    /*
     * 启动 tail -F 实时日志流
     * 返回 session_id，前端通过 log-lines / log-session-status 事件接收数据
     */
    pub fn start_tail(
        app: AppHandle,
        session_id: String,
        server: ServerConfig,
        remote_path: String,
        lines_backtrack: u32,
        password_plain: Option<String>,
        private_key_pem_plain: Option<String>,
    ) -> Result<String> {
        let sid = session_id.clone();
        let sid_ret = session_id.clone();
        let server_id = server.id.clone();

        // std 同步 mpsc：停止信号
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        LIVE_SESSIONS.lock().insert(sid.clone(), stop_tx);

        // tokio sync mpsc：把 blocking 线程中的行 -> 主线程 emit
        let (async_line_tx, mut async_line_rx) =
            tokio::sync::mpsc::channel::<std::result::Result<String, String>>(512);

        Self::emit_status(
            &app,
            &sid,
            &server_id,
            SessionStatus::Connecting,
            Some("正在建立 SSH 连接..."),
        );

        // 1. tokio task：负责建立 SSH 连接 + 启动 blocking 线程读取 tail + 转发事件到 Tauri
        tauri::async_runtime::spawn(async move {
            // 1.1 建立 SSH 连接（仅用于探测连通性，真正的 tail 线程会重新建连接）
            let ssh_probe = match SSHService::connect(
                &server,
                password_plain.as_deref(),
                private_key_pem_plain.as_deref(),
            )
            .await
            {
                Ok(s) => s,
                Err(e) => {
                    Self::emit_status(
                        &app,
                        &sid,
                        &server_id,
                        SessionStatus::Error,
                        Some(&format!("SSH 连接失败: {:#}", e)),
                    );
                    LIVE_SESSIONS.lock().remove(&sid);
                    return;
                }
            };
            // 该连接只用于探测；tail 和可选脚本各自使用独立会话，避免长期占用空闲连接。
            drop(ssh_probe);
            Self::emit_status(
                &app,
                &sid,
                &server_id,
                SessionStatus::Connected,
                Some("SSH 已连接，准备启动 tail..."),
            );

            // 1.2 依次执行连接后自定义脚本：每个脚本独立建连接，避免抢 tail-f session
            if server.run_scripts_enabled {
                for script in &server.run_scripts {
                    if script.content.trim().is_empty() {
                        continue;
                    }
                    if script.delay_ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(script.delay_ms)).await;
                    }
                    match SSHService::connect(
                        &server,
                        password_plain.as_deref(),
                        private_key_pem_plain.as_deref(),
                    )
                    .await
                    {
                        Ok(mut s_ssh) => {
                            let _ = SSHService::exec_once(&mut s_ssh, &script.content, 15).await;
                        }
                        Err(e) => tracing::warn!("运行脚本 SSH 连接失败: {:#}", e),
                    }
                }
            }

            // 1.3 启动 blocking 线程执行 tail -F 读行，通过 async_line_tx 推送
            Self::emit_status(&app, &sid, &server_id, SessionStatus::Streaming, None);
            {
                let (tx, rx) = std::sync::mpsc::channel::<std::result::Result<String, String>>();
                let remote_path_cloned = remote_path.clone();
                let lines_bt = lines_backtrack;
                let srv2 = server.clone();
                let pwd2 = password_plain.clone();
                let pem2 = private_key_pem_plain.clone();

                let tx_worker = tx.clone();
                std::thread::Builder::new()
                    .name(format!("tail-f-{sid}"))
                    .spawn(move || {
                        // blocking 线程内：重新建 SSH 连接（ssh2 Sync Session 非 Send 无法跨线程）
                        let runtime2 = tokio::runtime::Handle::try_current().ok();
                        let ssh2 = match runtime2 {
                            Some(rt) => rt.block_on(SSHService::connect(
                                &srv2,
                                pwd2.as_deref(),
                                pem2.as_deref(),
                            )),
                            None => {
                                let rt3 = tokio::runtime::Builder::new_current_thread()
                                    .enable_all()
                                    .build()
                                    .unwrap();
                                rt3.block_on(SSHService::connect(
                                    &srv2,
                                    pwd2.as_deref(),
                                    pem2.as_deref(),
                                ))
                            }
                        };
                        let Ok(ssh_sess) = ssh2 else {
                            let _ = tx_worker.send(Err("tail session reconnect fail".to_string()));
                            return;
                        };
                        SSHService::stream_tail_f_blocking(
                            ssh_sess,
                            remote_path_cloned,
                            lines_bt,
                            tx_worker,
                            stop_rx,
                        );
                    })
                    .ok();
                // 转发：std mpsc rx -> tokio mpsc tx
                let app_bridge = app.clone();
                let sid_bridge = sid.clone();
                let srv_bridge = server_id.clone();
                let _ = sid_bridge;
                let _ = srv_bridge;
                std::thread::spawn(move || {
                    let _ = &app_bridge;
                    loop {
                        match rx.recv() {
                            Ok(msg) => {
                                if async_line_tx.blocking_send(msg).is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                });
            };

            // 1.4 主循环：接收异步行 -> 组装 LogLine -> 批量 emit
            let mut line_no: u64 = 0;
            let mut batch: Vec<LogLine> = Vec::with_capacity(64);
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(120)) => {
                        if !batch.is_empty() {
                            let drain = batch.drain(..).collect::<Vec<_>>();
                            Self::emit_lines(&app, &sid, &server_id, drain);
                        }
                    }
                    maybe_line = async_line_rx.recv() => {
                        let text: String = match maybe_line {
                            Some(Ok(t)) => t,
                            Some(Err(e)) => {
                                Self::emit_status(&app, &sid, &server_id, SessionStatus::Error,
                                    Some(&format!("流错误: {}", e)));
                                break;
                            }
                            None => {
                                Self::emit_status(&app, &sid, &server_id, SessionStatus::Disconnected,
                                    Some("流已断开"));
                                break;
                            }
                        };
                        line_no += 1;
                        let mut line =
                            LogLine::from_raw(line_no, &text, &server_id, Local::now().timestamp_millis());
                        // 流的第一行就是续行（tail 从文件中间开始）：降级为普通行，避免出现孤儿续行
                        if line.is_continuation && line_no == 1 {
                            line.is_continuation = false;
                            line.level = LogLevel::from_text(&text);
                            line.timestamp_ms = Some(Local::now().timestamp_millis());
                        }
                        batch.push(line);
                        if batch.len() >= 32 {
                            let drain = batch.drain(..).collect::<Vec<_>>();
                            Self::emit_lines(&app, &sid, &server_id, drain);
                        }
                    }
                }
            }
            // 收尾
            if !batch.is_empty() {
                Self::emit_lines(&app, &sid, &server_id, batch);
            }
            Self::emit_status(&app, &sid, &server_id, SessionStatus::Disconnected, None);
            LIVE_SESSIONS.lock().remove(&sid);
        });

        Ok(sid_ret)
    }

    /* 停止指定会话（发送停止信号） */
    pub fn stop_tail(session_id: &str) -> bool {
        if let Some(tx) = LIVE_SESSIONS.lock().remove(session_id) {
            let _ = tx.send(());
            true
        } else {
            false
        }
    }

    /* 应用退出时停止所有实时日志流，保证后端不会遗留阻塞线程。 */
    pub fn stop_all() -> usize {
        let sessions = std::mem::take(&mut *LIVE_SESSIONS.lock());
        let count = sessions.len();
        for (_, tx) in sessions {
            let _ = tx.send(());
        }
        count
    }

    /* 分页获取历史日志 */
    pub async fn fetch_history(
        server: &ServerConfig,
        remote_path: &str,
        page: u32,
        page_size: u32,
        password_plain: Option<&str>,
        private_key_pem_plain: Option<&str>,
    ) -> Result<Vec<LogLine>> {
        let start_line = (page.saturating_sub(1)) as u64 * page_size as u64;
        let cmd = if page == 1 && page_size <= 1000 {
            format!("tail -n {} -- {}", page_size, shell_escape(remote_path))
        } else {
            format!(
                "awk 'NR>{s} && NR<={e}' -- {path} 2>/dev/null || tail -n +{s} {path} | head -n {ps}",
                s = start_line, e = start_line + page_size as u64, ps = page_size,
                path = shell_escape(remote_path)
            )
        };

        let mut ssh = SSHService::connect(server, password_plain, private_key_pem_plain).await?;
        let (stdout, _stderr, exit) = SSHService::exec_once(&mut ssh, &cmd, 45).await?;
        drop(ssh);
        if exit != 0 {
            return Err(anyhow!(
                "命令退出码={}，路径无权限或不存在: {}",
                exit,
                remote_path
            ));
        }
        let raws: Vec<String> = stdout.lines().map(|s| s.to_string()).collect();
        let mut lines = LogLine::from_raw_batch(&raws, &server.id, Local::now().timestamp_millis());
        // from_raw_batch 的行号从 0 起，校正为文件中的真实行号
        for (i, l) in lines.iter_mut().enumerate() {
            l.line_no = start_line + 1 + i as u64;
        }
        Ok(lines)
    }

    /* 按时间范围获取历史日志（服务端 awk 文本比较，避免拉全量） */
    pub async fn fetch_history_by_time(
        server: &ServerConfig,
        remote_path: &str,
        start_ms: i64,
        end_ms: i64,
        max_lines: u32,
        offset_lines: u32,
        password_plain: Option<&str>,
        private_key_pem_plain: Option<&str>,
    ) -> Result<Vec<LogLine>> {
        if end_ms < start_ms {
            return Ok(vec![]);
        }
        // 日志时间戳不带时区。按用户在界面选择的墙上时间直接与日志文本比较，
        // 不能按服务器 OS 时区换算：JVM/Logback 时区可能与宿主机或容器时区不同。
        let mut ssh = SSHService::connect(server, password_plain, private_key_pem_plain).await?;
        let start_str = Local
            .timestamp_millis_opt(start_ms)
            .earliest()
            .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_else(|| String::from("1970-01-01 00:00:00"));
        let end_str = Local
            .timestamp_millis_opt(end_ms)
            .earliest()
            .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_else(|| String::from("2100-01-01 00:00:00"));
        // 纯时间日志没有日期，只能按所选范围的开始日期解释。
        let selected_date = Local
            .timestamp_millis_opt(start_ms)
            .earliest()
            .map(|t| t.format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        /* 是否 glob 多文件模式（Logback 按小时滚动如 application-2026-09-02_12.log，
         * 用 application-*.log 或 application-2026-09-02_0*.log 可跨文件查时间段） */
        let uses_glob =
            remote_path.contains('*') || remote_path.contains('?') || remote_path.contains('[');
        if uses_glob {
            prevalidate_glob_path_str(remote_path).map_err(|e| anyhow!(e))?;
        }
        /*
         * 日志按时间递增写入。用 tac 从文件末尾反向扫描，遇到早于开始时间的首行立即 exit，
         * 最近几小时查询无需再从头读取整个 output.log。无时间戳续行先暂存，命中其主行后一起输出。
         * 只识别行首时间，避免把 MyBatis Row 中的业务日期误当日志时间。
         */
        let reverse_awk = "{\
                if (match($0, /^[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}/)) {\
                    ts = substr($0, RSTART, RLENGTH); sub(/^[[:space:]]*/, \"\", ts); \
                    if (ts > e) { n = 0; next } \
                    if (ts < s) exit; \
                    for (i = 1; i <= n; i++) print buf[i]; n = 0; print; next \
                } \
                if (match($0, /^[[:space:]]*[0-9]{2}:[0-9]{2}:[0-9]{2}/)) {\
                    t = substr($0, RSTART, RLENGTH); sub(/^[[:space:]]*/, \"\", t); ts = d \" \" t; \
                    if (ts > e) { n = 0; next } \
                    if (ts < s) exit; \
                    for (i = 1; i <= n; i++) print buf[i]; n = 0; print; next \
                } \
                if (n < 2000) buf[++n] = $0 \
            }";
        let forward_awk = "{\
                if (match($0, /^[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}/)) {\
                    ts = substr($0, RSTART, RLENGTH); sub(/^[[:space:]]*/, \"\", ts); \
                    if (ts >= s && ts <= e) { print; hit = 1 } else { hit = 0 }; next \
                } \
                if (match($0, /^[[:space:]]*[0-9]{2}:[0-9]{2}:[0-9]{2}/)) {\
                    t = substr($0, RSTART, RLENGTH); sub(/^[[:space:]]*/, \"\", t); ts = d \" \" t; \
                    if (ts >= s && ts <= e) { print; hit = 1 } else { hit = 0 }; next \
                } \
                if (hit) print \
            }";
        // 正向复核使用环形缓冲，从结果末尾精确跳过 offset_lines 行后取一页。
        // 仅保留 offset + page_size 行，避免把整个大日志装入 awk 内存。
        let forward_page_awk = "{\
                slot = (NR - 1) % keep; buf[slot] = $0; seq[slot] = NR \
            } END {\
                first = NR - off - lim + 1; if (first < 1) first = 1; \
                last = NR - off; \
                for (i = first; i <= last; i++) { \
                    slot = (i - 1) % keep; if (seq[slot] == i) print buf[slot] \
                } \
            }";
        let reverse_source = if uses_glob {
            format!(
                "for f in $(ls -1t -- {} 2>/dev/null); do tac -- \"$f\"; done",
                remote_path
            )
        } else {
            format!("tac -- {}", shell_escape(remote_path))
        };
        let forward_source = if uses_glob {
            format!("cat {} 2>/dev/null", remote_path)
        } else {
            format!("cat -- {}", shell_escape(remote_path))
        };
        let skip_from_newest = offset_lines.saturating_add(1);
        let keep_lines = offset_lines.saturating_add(max_lines).max(1);
        let fast_cmd = format!(
            "if command -v tac >/dev/null 2>&1; then {} | LC_ALL=C awk -v d='{}' -v s='{}' -v e='{}' '{}' | tail -n +{} | head -n {} | tac; else {} | LC_ALL=C awk -v d='{}' -v s='{}' -v e='{}' '{}' | LC_ALL=C awk -v off={} -v lim={} -v keep={} '{}'; fi",
            reverse_source, selected_date, start_str, end_str, reverse_awk,
            skip_from_newest, max_lines,
            forward_source, selected_date, start_str, end_str, forward_awk,
            offset_lines, max_lines, keep_lines, forward_page_awk
        );
        let (mut stdout, mut stderr, mut exit) =
            SSHService::exec_once(&mut ssh, &fast_cmd, 90).await?;

        // output.log 可能由多个进程并发写入或混有乱序记录。反向扫描为了提速会在首条
        // 早于范围的记录处停止；若快速结果为空，正向完整扫描一次，避免误报“没有日志”。
        if exit == 0 && stdout.trim().is_empty() {
            let verify_cmd = format!(
                "{} | LC_ALL=C awk -v d='{}' -v s='{}' -v e='{}' '{}' | LC_ALL=C awk -v off={} -v lim={} -v keep={} '{}'",
                forward_source, selected_date, start_str, end_str, forward_awk,
                offset_lines, max_lines, keep_lines, forward_page_awk
            );
            let verified = SSHService::exec_once(&mut ssh, &verify_cmd, 90).await?;
            stdout = verified.0;
            stderr = verified.1;
            exit = verified.2;
        }
        // 解析 awk 输出（结构化解析 + 续行归属）
        let mut lines: Vec<LogLine> = Vec::new();
        if exit == 0 {
            let raws: Vec<String> = stdout.lines().map(|s| s.to_string()).collect();
            lines = LogLine::from_raw_batch(&raws, &server.id, Local::now().timestamp_millis());
            for (i, l) in lines.iter_mut().enumerate() {
                l.line_no = offset_lines as u64 + i as u64 + 1;
            }
        }
        if exit != 0 {
            drop(ssh);
            return Err(anyhow!(
                "按时间查询失败（退出码={}，stderr={}）",
                exit,
                stderr.trim()
            ));
        }
        drop(ssh);
        // 快速扫描和正向复核都为空时，才认定该时间段没有日志。
        Ok(lines)
    }

    /* 服务端 grep 搜索日志，支持多关键字 AND 管道 + 排除关键字 grep -v 管道 */
    pub async fn search_logs(
        server: &ServerConfig,
        remote_path: &str,
        keyword: &str,
        exclude_keyword: Option<&str>,
        regex: bool,
        case_insensitive: bool,
        max_lines: u32,
        password_plain: Option<&str>,
        private_key_pem_plain: Option<&str>,
    ) -> Result<Vec<LogLine>> {
        let kw_terms: Vec<&str> = keyword.split_whitespace().collect();
        let ex_terms: Vec<&str> = exclude_keyword
            .map(|s| s.split_whitespace().collect())
            .unwrap_or_default();
        if kw_terms.is_empty() && ex_terms.is_empty() {
            return Ok(vec![]);
        }
        let mut base_opts = String::from("--color=never -h -n");
        if case_insensitive {
            base_opts.push_str(" -i");
        }
        if regex {
            base_opts.push_str(" -E");
        } else {
            base_opts.push_str(" -F");
        }
        let ci_flag = if case_insensitive { " -i" } else { "" };

        // 多个关键字用 AND 管道：第一个 grep 文件，后续每个词再 pipe grep
        // 有排除管道或多关键字时去掉 -m 限制，在 Rust 端截断
        let has_multi_pipe = kw_terms.len() > 1 || !ex_terms.is_empty();

        let mut cmd = if kw_terms.is_empty() {
            // 只有排除关键字：用 cat 作为源
            format!("cat {} 2>/dev/null", shell_escape(remote_path))
        } else {
            // 第一个关键字 grep 文件
            let limit = if has_multi_pipe {
                ""
            } else {
                &format!("-m {}", max_lines)
            };
            format!(
                "grep {opts} {limit} -- {kw} {path} 2>/dev/null",
                opts = base_opts,
                limit = limit,
                kw = shell_escape(kw_terms[0]),
                path = shell_escape(remote_path),
            )
        };

        // 后续关键字管道（AND 关系）
        for term in kw_terms.iter().skip(1) {
            cmd.push_str(&format!(
                " | grep{ci} -- {term}",
                ci = ci_flag,
                term = shell_escape(term)
            ));
        }

        // 排除关键字管道
        for term in &ex_terms {
            cmd.push_str(&format!(
                " | grep{ci} -v -F -- {term}",
                ci = ci_flag,
                term = shell_escape(term)
            ));
        }

        let mut ssh = SSHService::connect(server, password_plain, private_key_pem_plain).await?;
        let (stdout, _stderr, _exit) = SSHService::exec_once(&mut ssh, &cmd, 90).await?;
        drop(ssh);
        let mut lines: Vec<LogLine> = Vec::new();
        for raw in stdout.lines() {
            /* grep -n 输出带 "行号:" 前缀，会破坏结构化解析，先剥离再解析：
             *   1234:2026-08-31 10:00:00.006 [scheduling-1] INFO  [...] logger - msg
             * raw 字段仍保留带前缀的原文，便于用户对照 */
            let (file_lineno, body) = match raw.find(':') {
                Some(p) if p > 0 && raw[..p].chars().all(|c| c.is_ascii_digit()) => {
                    (raw[..p].parse::<u64>().ok(), &raw[p + 1..])
                }
                _ => (None, raw),
            };
            let mut line = LogLine::from_raw(
                file_lineno.unwrap_or(0),
                body,
                &server.id,
                Local::now().timestamp_millis(),
            );
            line.line_no = file_lineno.unwrap_or(0);
            line.raw = raw.to_string();
            lines.push(line);
            // Rust 端截断：有排除管道时限制最终结果数量
            if lines.len() >= max_lines as usize {
                break;
            }
        }
        Ok(lines)
    }

    /**
     * 按 traceId 跨文件追踪同一次请求的完整链路
     * 服务端 grep 粗筛后，Rust 端结构化解析并精确比对 trace_id 字段，
     * 避免消息体里恰好出现相同字符串造成的误命中
     * 返回按时间升序排列（还原链路调用顺序）
     */
    pub async fn search_by_trace_id(
        server: &ServerConfig,
        remote_path: &str,
        trace_id: &str,
        max_lines: u32,
        password_plain: Option<&str>,
        private_key_pem_plain: Option<&str>,
    ) -> Result<Vec<LogLine>> {
        let tid = trace_id.trim();
        if tid.is_empty() {
            return Err(anyhow!("traceId 不能为空"));
        }
        /* glob 安全校验：路径原样交给远端 shell 展开，禁止注入字符 */
        let uses_glob =
            remote_path.contains('*') || remote_path.contains('?') || remote_path.contains('[');
        if uses_glob {
            prevalidate_glob_path_str(remote_path).map_err(|e| anyhow!(e))?;
        }
        let path_arg = if uses_glob {
            remote_path.to_string()
        } else {
            shell_escape(remote_path)
        };
        // -h 去掉文件名前缀（跨文件时每行都会带文件名），便于统一解析
        let cmd = format!(
            "grep -h -F -m {max} -- {kw} {path} 2>/dev/null",
            max = max_lines.max(1),
            kw = shell_escape(tid),
            path = path_arg
        );
        let mut ssh = SSHService::connect(server, password_plain, private_key_pem_plain).await?;
        let (stdout, _stderr, _exit) = SSHService::exec_once(&mut ssh, &cmd, 60).await?;
        drop(ssh);

        let mut lines: Vec<LogLine> = Vec::new();
        for raw in stdout.lines() {
            // 精确比对结构化出来的 trace_id
            if let Some(f) = parse_log_fields(raw) {
                if f.trace_id.as_deref() != Some(tid) {
                    continue;
                }
                lines.push(LogLine {
                    line_no: 0,
                    raw: raw.to_string(),
                    level: if f.level != LogLevel::Unknown {
                        f.level
                    } else {
                        LogLevel::from_text(raw)
                    },
                    timestamp_ms: f.timestamp_ms,
                    server_id: server.id.clone(),
                    stream_source: 0,
                    thread: f.thread,
                    trace_id: f.trace_id,
                    logger: f.logger,
                    message: f.message,
                    is_continuation: false,
                });
            }
        }
        // 跨文件合并后按时间升序，还原一次请求的调用顺序
        lines.sort_by_key(|l| l.timestamp_ms.unwrap_or(0));
        for (i, l) in lines.iter_mut().enumerate() {
            l.line_no = (i + 1) as u64;
        }
        Ok(lines)
    }

    /**
     * 探测服务器上各日志源预设的实际文件情况
     * 一次 SSH 会话跑完所有探测，返回每个通道的文件数 / 总大小 / 最新文件
     * @param base_dir 日志根目录，如 /var/log/app/logs
     * @param logback_config 可选的 logback 导入配置，有则使用自定义预设
     */
    pub async fn probe_log_sources(
        server: &ServerConfig,
        base_dir: &str,
        password_plain: Option<&str>,
        private_key_pem_plain: Option<&str>,
        logback_config: Option<&LogbackServerConfig>,
    ) -> Result<Vec<LogSourceProbeResult>> {
        let base = base_dir.trim_end_matches('/');
        if base.is_empty() {
            return Err(anyhow!("日志根目录为空"));
        }

        /* 构建探测预设列表：有 logback 配置时使用自定义预设，否则使用硬编码预设 */
        struct ProbePreset {
            key: String,
            label: String,
            group: String,
            glob_path: String,
        }

        let presets: Vec<ProbePreset> = if let Some(config) = logback_config {
            config
                .appenders
                .iter()
                .filter_map(|app| {
                    let pattern = app.glob_pattern.as_ref().or(app.file_path.as_ref())?;
                    /* 如果 pattern 是绝对路径则直接使用，否则拼接 base_dir */
                    let glob_path = if pattern.starts_with('/') {
                        pattern.clone()
                    } else {
                        format!("{}/{}", base, pattern)
                    };
                    Some(ProbePreset {
                        key: app.name.clone(),
                        label: app.label.clone(),
                        group: app.group.clone(),
                        glob_path,
                    })
                })
                .collect()
        } else {
            log_source_presets()
                .into_iter()
                .map(|p| ProbePreset {
                    key: p.key,
                    label: p.label,
                    group: p.group,
                    glob_path: format!("{}/{}", base, p.rel_pattern),
                })
                .collect()
        };

        if presets.is_empty() {
            return Ok(vec![]);
        }

        /* 拼接探测脚本：每个预设输出一行 key|count|bytes|latest|mtime */
        /* 所有 glob_path 已经是绝对路径，无需 cd 到 base_dir */
        let mut script = String::new();
        for p in &presets {
            prevalidate_glob_path_str(&p.glob_path)
                .map_err(|e| anyhow!("日志源路径不安全（{}）：{}", p.key, e))?;
            script.push_str(&format!(
                "n=$(ls -1 -- {pat} 2>/dev/null | wc -l | tr -d ' '); \
                 sz=$(du -cb -- {pat} 2>/dev/null | tail -1 | cut -f1); \
                 last=$(ls -t -- {pat} 2>/dev/null | head -1); \
                 mt=$(stat -c %Y -- \"$last\" 2>/dev/null || echo 0); \
                 printf '%s|%s|%s|%s|%s\\n' {key} \"$n\" \"$sz\" \"$last\" \"$mt\"\n",
                pat = shell_escape_glob(&p.glob_path),
                key = shell_escape(&p.key)
            ));
        }
        /* 诊断：递归查找 logs/ 下所有 .log 文件（路径|mtime 格式），仅用于提示用户 */
        script.push_str(&format!(
            "find {base}/logs/ -name '*.log' -type f 2>/dev/null | head -100 | while read -r f; do \
               mt=$(stat -c %Y -- \"$f\" 2>/dev/null || echo 0); \
               echo \"__DIAG__|$f|$mt\"; \
             done\n",
            base = shell_escape(base)
        ));
        let mut ssh = SSHService::connect(server, password_plain, private_key_pem_plain).await?;
        let (stdout, stderr, exit) = SSHService::exec_once(&mut ssh, &script, 30).await?;
        drop(ssh);
        if exit != 0 {
            return Err(anyhow!(
                "探测日志源失败（退出码={}）: {}",
                exit,
                stderr.trim()
            ));
        }

        // 解析探测输出
        let mut map: HashMap<String, (u32, u64, String, i64)> = HashMap::new();
        let mut diagnostic_listing: Option<String> = None;
        let mut fallback_files: Vec<(String, i64)> = Vec::new();
        for line in stdout.lines() {
            if line.starts_with("__DIAG__|") {
                let parts: Vec<&str> = line.splitn(3, '|').collect();
                if parts.len() >= 3 {
                    let fpath = parts[1].trim();
                    let mt: i64 = parts[2].trim().parse().unwrap_or(0);
                    if !fpath.is_empty() {
                        fallback_files.push((fpath.to_string(), mt));
                    }
                }
                continue;
            }
            let parts: Vec<&str> = line.splitn(5, '|').collect();
            if parts.len() < 5 {
                continue;
            }
            let count: u32 = parts[1].trim().parse().unwrap_or(0);
            let bytes: u64 = parts[2].trim().parse().unwrap_or(0);
            let last = parts[3].trim().to_string();
            let mtime: i64 = parts[4].trim().parse().unwrap_or(0);
            map.insert(parts[0].trim().to_string(), (count, bytes, last, mtime));
        }

        /* 按 mtime 降序排列回退文件，最新的在前 */
        fallback_files.sort_by(|a, b| b.1.cmp(&a.1));
        if !fallback_files.is_empty() {
            diagnostic_listing = Some(
                fallback_files
                    .iter()
                    .map(|(p, _)| p.rsplit('/').next().unwrap_or(p).to_string())
                    .collect::<Vec<_>>()
                    .join(", "),
            );
        }

        let results: Vec<LogSourceProbeResult> = presets
            .into_iter()
            .enumerate()
            .map(|(i, p)| {
                let (count, bytes, last, mt) =
                    map.remove(&p.key).unwrap_or((0, 0, String::new(), 0));
                let (latest_file, latest_mtime_ms, actual_exists) = if count > 0 {
                    /* glob 匹配成功：last 已是完整绝对路径 */
                    (
                        Some(last.clone()),
                        if mt > 0 { Some(mt * 1000) } else { None },
                        true,
                    )
                } else {
                    /* glob 未匹配时不能借用其他日志源的最新文件，否则“实时最新”会打开错误文件。 */
                    (None, None, false)
                };
                LogSourceProbeResult {
                    preset_key: p.key,
                    label: p.label,
                    group: p.group,
                    glob_path: p.glob_path,
                    exists: actual_exists,
                    file_count: count,
                    total_bytes: bytes,
                    latest_file,
                    latest_mtime_ms,
                    diagnostic_listing: if i == 0 {
                        diagnostic_listing.clone()
                    } else {
                        None
                    },
                }
            })
            .collect();
        Ok(results)
    }
}

fn shell_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/*
 * 为已通过 prevalidate_glob_path_str 的 glob 路径生成 shell 参数。
 * 普通 shell_escape 会把 * / ? 等通配符一并放进单引号，导致远端 shell 不展开 glob。
 * 这里仅保留受控路径字符和 glob 元字符，未知字符仍按普通字符串转义。
 */
fn shell_escape_glob(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for (index, ch) in s.chars().enumerate() {
        let safe_literal = ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                '/' | '.' | '_' | '-' | '@' | '+' | '%' | ',' | ':' | '='
            );
        let glob_meta = matches!(ch, '*' | '?' | '[' | ']');
        if (index == 0 && ch == '~') || safe_literal || glob_meta {
            out.push(ch);
        } else {
            out.push_str(&shell_escape(&ch.to_string()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{shell_escape, shell_escape_glob};

    #[test]
    fn glob_escape_keeps_wildcards_expandable() {
        assert_eq!(
            shell_escape_glob("/var/log/app-[0-9]*.log"),
            "/var/log/app-[0-9]*.log"
        );
        assert_eq!(shell_escape_glob("~/logs/app-?.log"), "~/logs/app-?.log");
        assert_ne!(shell_escape("/var/log/app-*.log"), "/var/log/app-*.log");
    }

    #[test]
    fn ordinary_shell_escape_still_quotes_untrusted_values() {
        let escaped = shell_escape("service; touch /tmp/should-not-run");
        assert!(escaped.starts_with('\''));
        assert!(escaped.ends_with('\''));
        assert_eq!(escaped, "'service; touch /tmp/should-not-run'");
    }
}
