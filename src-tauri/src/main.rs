/*
 * LogSight Tauri 应用主入口
 * 初始化 tracing 日志、注册 Tauri 命令、插件和窗口菜单
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod commands;
mod models;
mod services;

use services::LogStreamService;
use tauri::{Emitter, Manager, WindowEvent};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/*
 * Tauri 主函数
 * 构建 Tauri 应用：注册命令 -> 插件 -> setup 钩子 -> 运行
 */
fn main() {
    // 1. 初始化 tracing 日志系统（开发环境打印到终端，生产环境可配置文件）
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,warn,error")),
        )
        .with(fmt::layer())
        .init();

    // 2. 构建并运行 Tauri 应用
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            // master password
            commands::get_or_create_master_password,
            commands::reset_master_password,
            commands::decrypt_secret,
            // server CRUD
            commands::save_server,
            commands::list_servers,
            commands::get_server,
            commands::delete_server,
            // ssh connection
            commands::test_connection,
            // log stream
            commands::start_tail,
            commands::stop_tail,
            commands::fetch_history,
            commands::fetch_history_by_time,
            commands::search_logs,
            // 结构化日志能力：traceId 链路追踪 + 日志源预设探测
            commands::search_by_trace_id,
            commands::probe_log_sources,
            // logback.xml 配置导入
            commands::import_logback_config,
            commands::get_logback_config,
            commands::delete_logback_config,
            // V10 新增：服务器目录选择器
            commands::list_server_dir,
            commands::validate_server_path,
            commands::resolve_server_home,
        ])
        .setup(|app| {
            // 初始化应用数据目录
            if let Ok(dir) = app.path().app_data_dir() {
                std::fs::create_dir_all(&dir).ok();
                tracing::info!("应用数据目录: {:?}", dir);
            }
            // 获取主窗口引用，设置 Mac 风格交互
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("LogSight - 服务器日志查看器");
                #[cfg(target_os = "macos")]
                {
                    // TODO: Mac 原生磨砂玻璃效果（需要 Tauri v2 macosVisualEffect）
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 关闭窗口前由后端直接停止所有日志流，不依赖前端 tabs 状态是否最新。
                LogStreamService::stop_all();
                window.emit("app-closing", ()).ok();
                let _ = api;
            }
        })
        .run(tauri::generate_context!())
        .expect("LogSight 应用启动失败，请检查 Tauri 配置与 Rust 工具链是否安装正确");
}
