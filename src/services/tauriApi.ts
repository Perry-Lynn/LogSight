/*
 * Tauri IPC 调用封装
 * 集中所有 invoke() 调用，统一处理 ApiResponse 错误消息
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  ServerConfig,
  ApiResponse,
  ConnectTestResult,
  LogLine,
  DirListResult,
  PathValidateResult,
  LogSourceProbeResult,
  LogbackServerConfig,
} from '@/types';

/*
 * IPC 调用基础工具：自动提取 data 或抛出 message 错误
 */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const resp = (await invoke(cmd, args)) as ApiResponse<T>;
  if (!resp || typeof resp.success === 'undefined') {
    throw new Error('后端返回格式异常');
  }
  if (!resp.success) {
    throw new Error(resp.error || '未知错误');
  }
  return resp.data as T;
}

/* ================= 主密码相关 ================= */

/** 从系统钥匙串获取或初始化应用主密码 */
export const getOrCreateMasterPassword = (): Promise<string> =>
  call<string>('get_or_create_master_password');

/** 用户确认旧钥匙串不可恢复后，重建应用主密钥；旧密文需要重新录入凭据 */
export const resetMasterPassword = (): Promise<string> =>
  call<string>('reset_master_password');

/** 解密密文为明文（密码/私钥等） */
export const decryptSecret = (cipherB64: string, masterPassword: string): Promise<string> =>
  call<string>('decrypt_secret', { cipherB64, masterPassword });

/* ================= 服务器配置 CRUD ================= */

/** 列出所有已保存服务器（敏感字段为密文） */
export const listServers = (): Promise<ServerConfig[]> =>
  call<ServerConfig[]>('list_servers');

/** 新增或更新一个服务器。passwordPlain/privateKeyPemPlain 会在 Rust 端加密存储 */
export const saveServer = (
  server: Partial<ServerConfig> & Pick<ServerConfig, 'title' | 'host' | 'username'>,
  passwordPlain: string | null,
  privateKeyPemPlain: string | null,
  masterPassword: string,
): Promise<ServerConfig> => {
  const baseDefaults: Partial<ServerConfig> = {
    id: '',
    bookmark_category: 'default',
    port: 22,
    auth_type: 'Password',
    password_cipher: null,
    private_key_cipher: null,
    private_key_path: null,
    ssh_config_path: null,
    use_ssh_agent: false,
    ssh_agent_path: null,
    use_mfa: false,
    run_scripts_enabled: false,
    run_scripts: [],
    description: '',
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    last_connected_at: null,
  };
  const payload: ServerConfig = Object.assign({}, baseDefaults, server) as ServerConfig;
  return call<ServerConfig>('save_server', {
    server: payload,
    passwordPlain,
    privateKeyPemPlain,
    masterPassword,
  });
};

/** 获取单个服务器 */
export const getServer = (id: string): Promise<ServerConfig> =>
  call<ServerConfig>('get_server', { id });

/** 删除服务器 */
export const deleteServer = (id: string): Promise<boolean> =>
  call<boolean>('delete_server', { id });

/* ================= SSH 连接测试 ================= */

/** 一次性连接测试，返回延迟和错误信息 */
export const testConnection = (
  server: ServerConfig,
  passwordPlain: string | null,
  privateKeyPemPlain: string | null,
): Promise<ConnectTestResult> =>
  call<ConnectTestResult>('test_connection', {
    server,
    passwordPlain,
    privateKeyPemPlain,
  });

/* ================= 日志流 ================= */

/** 启动 tail -F 实时日志流，返回 sessionId */
export const startTail = (
  server: ServerConfig,
  remotePath: string,
  linesBacktrack = 200,
  passwordPlain: string | null,
  privateKeyPemPlain: string | null,
): Promise<string> =>
  call<string>('start_tail', {
    server,
    remotePath,
    linesBacktrack,
    passwordPlain,
    privateKeyPemPlain,
  });

/** 停止日志流会话 */
export const stopTail = (sessionId: string): Promise<boolean> =>
  call<boolean>('stop_tail', { sessionId });

/** 分页获取历史日志 */
export const fetchHistory = (
  server: ServerConfig,
  remotePath: string,
  page = 1,
  pageSize = 500,
  passwordPlain: string | null,
  privateKeyPemPlain: string | null,
): Promise<LogLine[]> =>
  call<LogLine[]>('fetch_history', {
    server,
    remotePath,
    page,
    pageSize,
    passwordPlain,
    privateKeyPemPlain,
  });

/** 按时间范围获取历史日志（服务端 awk 按文本时间过滤） */
export const fetchHistoryByTime = (
  server: ServerConfig,
  remotePath: string,
  startMs: number,
  endMs: number,
  maxLines = 5000,
  offsetLines = 0,
  passwordPlain: string | null,
  privateKeyPemPlain: string | null,
): Promise<LogLine[]> =>
  call<LogLine[]>('fetch_history_by_time', {
    server,
    remotePath,
    startMs,
    endMs,
    maxLines,
    offsetLines,
    passwordPlain,
    privateKeyPemPlain,
  });

/** 关键字搜索日志（正则/忽略大小写），支持排除关键字 */
export const searchLogs = (
  server: ServerConfig,
  remotePath: string,
  keyword: string,
  excludeKeyword: string,
  regex = false,
  caseInsensitive = true,
  maxLines = 1000,
  passwordPlain: string | null,
  privateKeyPemPlain: string | null,
): Promise<LogLine[]> =>
  call<LogLine[]>('search_logs', {
    server,
    remotePath,
    keyword,
    excludeKeyword,
    regex,
    caseInsensitive,
    maxLines,
    passwordPlain,
    privateKeyPemPlain,
  });

/* ============ 结构化日志能力：traceId 链路追踪 / 日志源探测 ============ */

/**
 * 按 traceId 跨文件追踪一次请求的完整链路
 * 服务端 grep 粗筛 + Rust 端精确比对 trace_id 字段，返回按时间升序的链路
 * @param remotePath 可以是具体文件，也可以是 glob（如 /app/logs/application-*.log）
 */
export const searchByTraceId = (
  server: ServerConfig,
  remotePath: string,
  traceId: string,
  maxLines = 2000,
  passwordPlain: string | null,
  privateKeyPemPlain: string | null,
): Promise<LogLine[]> =>
  call<LogLine[]>('search_by_trace_id', {
    server,
    remotePath,
    traceId,
    maxLines,
    passwordPlain,
    privateKeyPemPlain,
  });

/**
 * 探测服务器上各日志源预设的文件情况
 * @param baseDir 日志根目录，如 /var/log/app/logs
 */
export const probeLogSources = (
  server: ServerConfig,
  baseDir: string,
  passwordPlain: string | null,
  privateKeyPemPlain: string | null,
): Promise<LogSourceProbeResult[]> =>
  call<LogSourceProbeResult[]>('probe_log_sources', {
    server,
    baseDir,
    passwordPlain,
    privateKeyPemPlain,
  });

/* ============ logback.xml 配置导入 ============ */

/** 导入 logback.xml 内容，解析并绑定到指定服务器 */
export const importLogbackConfig = (
  serverId: string,
  xmlContent: string,
): Promise<LogbackServerConfig> =>
  call<LogbackServerConfig>('import_logback_config', {
    serverId,
    xmlContent,
  });

/** 获取指定服务器已导入的 logback 配置 */
export const getLogbackConfig = (
  serverId: string,
): Promise<LogbackServerConfig | null> =>
  call<LogbackServerConfig | null>('get_logback_config', { serverId });

/** 删除指定服务器的 logback 配置 */
export const deleteLogbackConfig = (
  serverId: string,
): Promise<void> =>
  call<void>('delete_logback_config', { serverId });

/* ================ V10 新增：服务器目录选择器接口 ================ */

/**
 * 前端纯字符串路径预校验（CWE-22 第一层拦截，与 Rust prevalidate_path_str 规则保持一致）
 * 注意：这只是"快速失败"的前端检查，最终安全以 Rust 后端双保险为准。
 * @returns 通过返回 null；不通过返回中文原因字符串（直接用于 Toast 提示）
 */
export function prevalidatePathClient(raw: string): string | null {
  const p = raw ?? '';
  // 1. 空路径
  if (!p || !p.trim()) return '路径不能为空';
  const s = p.trim();
  // 2. 含 null 字节
  if (s.includes('\u0000')) return '路径包含非法 null 字符';
  // 3. 含控制字符（<0x20 且非 tab 常认为非法；0x7f DEL 也非法）
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return `路径包含非法控制字符（位置 ${i}）`;
  }
  // 4. Windows UNC / 盘符（用户在 Linux 服务器场景输入这种路径必然非法）
  if (/^[A-Za-z]:[\\/]/.test(s)) return '路径不能使用 Windows 盘符（服务器为 Linux）';
  if (s.startsWith('\\\\') || s.startsWith('//')) return '不允许 UNC/网络路径';
  // 5. URL 协议样式（http:// ftp:// file:// 等任何 ://）
  if (s.includes('://')) return '路径不允许包含 URL 协议';
  // 6. CWE-22：任何路径段 == ".." 或 "...." 异常段（相对路径越权）
  const segs = s.split(/[\\/]/).filter(Boolean);
  for (const seg of segs) {
    if (seg === '..') return '路径包含越权段 ".."，已拦截';
    if (seg === '...' || /^\.{3,}$/.test(seg)) return `路径包含异常段 "${seg}"，已拦截`;
  }
  // 7. 必须以 "/" 开头（服务器为 POSIX 文件系统）
  if (!s.startsWith('/')) return '路径必须以 "/" 开头（绝对路径）';
  // 8. 不允许仅根 "/" + 0 子段 作为文件，但作为目录浏览是允许的（这里不额外拦，交后端判断）
  return null;
}

/** 递归列举目标路径的直接子项（懒加载一层，不做全量递归） */
export const listServerDir = (
  server: ServerConfig,
  remotePath: string,
  passwordPlain: string | null,
  privateKeyPemPlain: string | null,
): Promise<DirListResult> =>
  call<DirListResult>('list_server_dir', {
    server,
    remotePath,
    passwordPlain,
    privateKeyPemPlain,
  });

/** 校验目标路径的存在性/类型/权限/安全性 */
export const validateServerPath = (
  server: ServerConfig,
  remotePath: string,
  passwordPlain: string | null,
  privateKeyPemPlain: string | null,
): Promise<PathValidateResult> =>
  call<PathValidateResult>('validate_server_path', {
    server,
    remotePath,
    passwordPlain,
    privateKeyPemPlain,
  });

/** 获取远程 SSH 登录用户真实 $HOME 目录（点击"家目录"快捷跳转） */
export const resolveServerHome = (
  server: ServerConfig,
  passwordPlain: string | null,
  privateKeyPemPlain: string | null,
): Promise<string> =>
  call<string>('resolve_server_home', {
    server,
    passwordPlain,
    privateKeyPemPlain,
  });
