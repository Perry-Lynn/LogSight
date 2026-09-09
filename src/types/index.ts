/*
 * 前端全局类型定义
 * 对应 Rust 后端 models.rs 的 TypeScript 版本
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */

/** SSH 认证方式枚举 */
export type AuthType = 'Password' | 'PrivateKey' | 'ConfigFile';

/** 连接后自动执行的运行脚本配置 */
export interface RunScript {
  content: string;
  delay_ms: number;
}

/**
 * 服务器连接配置
 * 完全匹配截图中的字段：书签分类、标题、主机、用户名、密码/私钥/配置、端口、SSH代理、MFA、脚本、描述
 */
export interface ServerConfig {
  id: string;
  bookmark_category: string;
  title: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  password_cipher?: string | null;
  private_key_cipher?: string | null;
  private_key_path?: string | null;
  ssh_config_path?: string | null;
  use_ssh_agent: boolean;
  ssh_agent_path?: string | null;
  use_mfa: boolean;
  /** 是否允许连接成功后自动执行保存的远程脚本 */
  run_scripts_enabled?: boolean;
  run_scripts: RunScript[];
  description: string;
  created_at: string;
  updated_at: string;
  last_connected_at?: string | null;
}

/** 日志级别枚举 */
export type LogLevel =
  | 'Trace'
  | 'Debug'
  | 'Info'
  | 'Warn'
  | 'Error'
  | 'Fatal'
  | 'Unknown';

/** 常见 Logback 日志来源分类 */
export type LogSourceKey = 'application' | 'platform' | 'workflow' | 'identity';

/** 单条日志行 */
export interface LogLine {
  line_no: number;
  raw: string;
  level: LogLevel;
  timestamp_ms?: number | null;
  server_id: string;
  stream_source: number;

  /* ===== 结构化字段（后端按 logback pattern 解析后下发） =====
   * %d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level [%X{traceId}] %logger{50} - %msg%n */
  /** 线程名，如 http-nio-8088-exec-1 / scheduling-1 */
  thread?: string | null;
  /** MDC 链路追踪 ID（%X{traceId}）；无 MDC 时为 null */
  trace_id?: string | null;
  /** logger 名，如 c.e.a.service.OrderService */
  logger?: string | null;
  /** 纯消息正文（已剥离时间/线程/级别/traceId/logger 前缀） */
  message?: string | null;
  /** 是否为上一条日志的续行（Java 异常堆栈等多行内容） */
  is_continuation?: boolean;
}

/** 会话状态枚举 */
export type SessionStatus =
  | 'Idle'
  | 'Connecting'
  | 'Connected'
  | 'Streaming'
  | 'Disconnecting'
  | 'Disconnected'
  | 'Error';

/** Tauri 会话状态事件 payload */
export interface SessionStatusPayload {
  session_id: string;
  server_id: string;
  status: SessionStatus;
  message?: string | null;
  timestamp_ms: number;
}

/** Tauri 日志行批量事件 payload */
export interface LogLinesPayload {
  session_id: string;
  server_id: string;
  lines: LogLine[];
}

/** Tauri IPC 统一响应 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T | null;
  error?: string | null;
}

/** 连通性测试结果 */
export interface ConnectTestResult {
  success: boolean;
  latency_ms: number;
  error_message?: string | null;
  banner?: string | null;
  remote_environment?: RemoteEnvironment | null;
}

/** 远程日志命令能力探测结果 */
export interface RemoteEnvironment {
  os: string;
  shell: string;
  available_commands: string[];
  missing_commands: string[];
  supported: boolean;
  message?: string | null;
}

/** 单个打开的日志标签页 */
export interface LogTab {
  /** 标签唯一 ID */
  key: string;
  /** 关联服务器 ID */
  server_id: string;
  /** 关联服务器配置快照（解密后的，临时态） */
  server_snapshot?: ServerConfig | null;
  /** 远端日志文件路径 */
  remote_path: string;
  /** 标签显示标题 */
  title: string;
  /** 当前 tail 会话 ID（流模式才有） */
  session_id?: string | null;
  /** 会话状态 */
  status: SessionStatus;
  /** 已加载的日志行 */
  lines: LogLine[];
  /** 已加载总行数 */
  total_lines: number;
  /** 最近一次状态消息（错误提示/连接提示） */
  last_message?: string | null;
}

/** 搜索过滤条件 */
export interface SearchFilter {
  /** 搜索关键字列表，多个词为 AND 关系（全部命中才保留） */
  keyword: string[];
  /** 排除关键字列表，任一词命中即排除该行（OR 关系） */
  keyword_exclude?: string[];
  regex: boolean;
  case_insensitive: boolean;
  levels: LogLevel[];
  /** 时间筛选起点（Unix 毫秒）；空=不限 */
  time_start_ms?: number | null;
  /** 时间筛选终点（Unix 毫秒）；空=不限 */
  time_end_ms?: number | null;

  /* ===== 结构化过滤维度（对应 logback pattern 字段） ===== */
  /** logger 白名单；空数组=不过滤 */
  loggers?: string[];
  /** logger 黑名单；命中的行直接折叠（用于压制刷屏的定时任务日志） */
  logger_exclude?: string[];
  /** 线程名白名单；空数组=不过滤 */
  threads?: string[];
  /** 日志来源；空数组=不过滤，支持混合 output.log 直接分类 */
  sources?: LogSourceKey[];
  /** traceId 精确追踪；非空时只保留同一调用链 */
  trace_id?: string | null;
  /** 是否折叠刷屏 logger（自动统计占比最高的 logger 并折叠） */
  collapse_noisy?: boolean;
  /** 是否折叠异常堆栈续行（默认折叠，点击展开） */
  collapse_stacktrace?: boolean;
}

/* ============ 日志源预设（对应 logback appender 分目录） ============ */

/** 日志源预设：一个通道（如开放平台）对应一组按小时滚动的文件 */
export interface LogSourcePreset {
  /** 唯一标识，如 application / platform / workflow / identity */
  key: string;
  /** 中文展示名 */
  label: string;
  /** 分组名，用于归类展示 */
  group: string;
  /** 相对于日志根目录的通配路径，如 platform/open-*.log */
  rel_pattern: string;
  /** 是否仅收集 ERROR（对应 *-error-*.log 专属 appender） */
  error_only: boolean;
}

/** 日志源探测结果：某通道在服务器上的实际文件情况 */
export interface LogSourceProbeResult {
  preset_key: string;
  label: string;
  group: string;
  /** 可直接用于打开/查询的完整 glob 绝对路径 */
  glob_path: string;
  /** 该通道是否存在日志文件 */
  exists: boolean;
  /** 匹配到的文件数（按小时滚动会有多个） */
  file_count: number;
  /** 总字节数 */
  total_bytes: number;
  /** 最新（最后修改）的文件完整路径 */
  latest_file?: string | null;
  /** 最新文件修改时间（毫秒） */
  latest_mtime_ms?: number | null;
  /** 诊断：base_dir/logs/ 目录下的文件列表（仅首条结果携带） */
  diagnostic_listing?: string | null;
}

/* ============ logback.xml 导入配置 ============ */

/** logback.xml 解析后的单个 appender 配置 */
export interface LogbackAppender {
  name: string;
  label: string;
  group: string;
  file_path?: string | null;
  glob_pattern?: string | null;
  error_only: boolean;
}

/** 服务器级别的 logback 配置 */
export interface LogbackServerConfig {
  server_id: string;
  appenders: LogbackAppender[];
  log_base_path?: string | null;
  imported_at: string;
}

/* ============ 服务器目录选择器 V10 ============ */

/** 文件类型枚举（对应 Rust FileKind） */
export type FileKind = 'Directory' | 'File' | 'Symlink' | 'Other';

/** 单个目录条目（对应 Rust DirEntry） */
export interface DirEntry {
  /** 绝对路径（服务器端） */
  abs_path: string;
  /** 文件名（不含路径） */
  name: string;
  /** 条目类型 */
  kind: FileKind;
  /** 文件大小（字节），目录通常为 4096 或 0 */
  size: number;
  /** 修改时间（Unix 毫秒时间戳） */
  mtime_ms?: number | null;
  /** Unix 权限位（十进制） */
  mode?: number | null;
  /** 是否为叶子节点（目录=false，文件=true） */
  is_leaf: boolean;
  /** 当前登录用户是否具有读取权限（经过 sftp opendir/open 实测） */
  readable: boolean;
}

/** 服务器目录列表返回结果（对应 Rust DirListResult） */
export interface DirListResult {
  /** 归一化后的绝对路径 */
  normalized_path: string;
  /** 本层目录条目列表（已按“目录优先+名字不区分大小写升序”排序） */
  entries: DirEntry[];
  /** 如果请求路径是符号链接，此字段给出它指向的真实路径；否则为 null */
  symlink_target?: string | null;
}

/** 服务器路径合法性校验结果（对应 Rust PathValidateResult） */
export interface PathValidateResult {
  /** 归一化后的绝对路径 */
  normalized_path: string;
  /** 服务器上是否存在 */
  exists: boolean;
  /** 是否为目录 */
  is_directory: boolean;
  /** 当前登录用户是否可读（目录=opendir成功，文件=open READ成功） */
  readable: boolean;
  /** 是否通过客户端+服务端的安全校验（无 .. 越权、控制字符、URL、UNC、盘符等） */
  safe: boolean;
  /** 校验失败时的中文原因说明 */
  reason?: string | null;
}
