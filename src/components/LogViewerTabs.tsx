/*
 * 日志多标签页组件 + 单个标签页详情面板
 * 每个标签包含：远程路径输入、启动/停止流按钮、历史加载、搜索过滤工具栏、虚拟滚动日志查看器
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-27
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Tabs,
  Input,
  Button,
  Tag,
  Tooltip,
  Dropdown,
  Modal,
  App as AntApp,
  Empty,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  PlayCircleFilled,
  StopOutlined,
  ReloadOutlined,
  HistoryOutlined,
  FileSearchOutlined,
  CloseOutlined,
  FolderOpenOutlined,
  ApartmentOutlined,
} from '@ant-design/icons';
import type { TabsProps } from 'antd';
import type {
  LogTab,
  SearchFilter,
  DirEntry,
  LogSourceProbeResult,
  LogbackServerConfig,
} from '@/types';
import {
  startTail,
  stopTail as apiStopTail,
  fetchHistory,
  fetchHistoryByTime,
  searchLogs,
  validateServerPath,
  prevalidatePathClient,
  probeLogSources,
  searchByTraceId,
  getLogbackConfig,
} from '@/services/tauriApi';
import { useAppStore, getPlainSecrets, statusLabel, ensureSecretsDecrypted } from '@/store/useAppStore';
import { resetTimestampCache } from '@/utils/logTimestamp';
import {
  applyLogFilter,
  detectNoisyLoggers,
  collectLoggerFacets,
  collectThreadFacets,
  collectSourceFacets,
  collectTraceIds,
  DEFAULT_SEARCH_FILTER,
  type FilterResult,
  type FacetStat,
} from '@/utils/logFilter';
import SearchFilterBar from './SearchFilterBar';
import LogViewer, { LOG_COLUMNS } from './LogViewer';
import LogColumnHeader from './LogColumnHeader';
import ServerDirectoryPicker from './ServerDirectoryPicker';
import { formatBytes } from '@/utils/logFormat';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

/** 路径历史记录单条结构（localStorage 存） */
interface PathHistoryItem {
  path: string;
  at: number;
}
/** localStorage key 前缀：按 serverId 分桶存储最近选择过的日志路径 */
const HISTORY_KEY_PREFIX = 'logsight:path-history:';
/** 每台服务器最多保留 10 条最近路径历史 */
const MAX_HISTORY = 10;
/** 时间查询每页原始日志行数 */
const TIME_QUERY_PAGE_SIZE = 5000;
const LOG_FONT_SIZE_KEY = 'logsight:log-font-size';
const DEFAULT_LOG_FONT_SIZE = 12.5;
const LOG_COLUMN_WIDTHS_KEY = 'logsight:log-column-widths';
const LOG_HIDDEN_COLUMNS_KEY = 'logsight:log-hidden-columns';

function loadColumnWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LOG_COLUMN_WIDTHS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}
function saveColumnWidths(widths: Record<string, number>) {
  try { localStorage.setItem(LOG_COLUMN_WIDTHS_KEY, JSON.stringify(widths)); } catch { /* ignore */ }
}
function loadHiddenColumns(): string[] {
  try {
    const raw = localStorage.getItem(LOG_HIDDEN_COLUMNS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}
function saveHiddenColumns(hidden: string[]) {
  try { localStorage.setItem(LOG_HIDDEN_COLUMNS_KEY, JSON.stringify(hidden)); } catch { /* ignore */ }
}

interface TimeQueryState {
  startMs: number;
  endMs: number;
  nextOffset: number;
  hasMore: boolean;
  loading: boolean;
}

interface TabViewState {
  filter: SearchFilter;
  autoScroll: boolean;
  pathInput: string;
  matched: number | null;
  pickerOpen: boolean;
  timeQuery: TimeQueryState | null;
}

/** 是否通配多文件路径（Logback 按小时滚动日志，如 application-2026-09-02_*.log） */
const isGlobPath = (p: string) => p.includes('*') || p.includes('?') || p.includes('[');

/**
 * 读取某服务器的路径历史记录（按选择时间倒序）
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-01-01
 */
const getPathHistory = (serverId: string): PathHistoryItem[] => {
  try {
    const raw = localStorage.getItem(`${HISTORY_KEY_PREFIX}${serverId}`);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x: any) => x && typeof x.path === 'string').slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
};

/**
 * 将某条路径写入该服务器的历史记录（去重后置顶，限 MAX_HISTORY 条）
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-01-01
 */
const pushPathHistory = (serverId: string, path: string) => {
  if (!path || !path.trim()) return;
  const clean = path.trim();
  try {
    const list = getPathHistory(serverId).filter((x) => x.path !== clean);
    list.unshift({ path: clean, at: Date.now() });
    const next = list.slice(0, MAX_HISTORY);
    localStorage.setItem(`${HISTORY_KEY_PREFIX}${serverId}`, JSON.stringify(next));
  } catch {
    /* ignore quota errors */
  }
};

/**
 * 相对时间格式化（历史记录显示「x 分钟前」等）
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-01-01
 */
const formatRelative = (ms: number) => {
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
};

interface Props {
  tabs: LogTab[];
  activeKey: string | null;
  onChange: (key: string) => void;
  onRemove: (key: string) => void;
}

/**
 * 日志多标签页容器组件类
 */
const LogViewerTabs: React.FC<Props> = ({ tabs, activeKey, onChange, onRemove }) => {
  const { message, modal } = AntApp.useApp();
  const updateTab = useAppStore((s) => s.updateTab);
  const updateTabBySessionId = useAppStore((s) => s.updateTabBySessionId);
  const appendLinesToTab = useAppStore((s) => s.appendLinesToTab);
  const servers = useAppStore((s) => s.servers);
  const secretsCache = useAppStore((s) => s.secretsCache);
  const openConnectionDialog = useAppStore((s) => s.openConnectionDialog);

  /* === 日志源探测（应用 / 平台 / 工作流 / 身份服务四类通道） === */
  const [probeOpen, setProbeOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeBase, setProbeBase] = useState('');
  const [probeTabKey, setProbeTabKey] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<LogSourceProbeResult[]>([]);
  const [logbackConfig, setLogbackConfig] = useState<LogbackServerConfig | null>(null);
  const [logFontSize, setLogFontSizeState] = useState(() => {
    const saved = Number(localStorage.getItem(LOG_FONT_SIZE_KEY));
    return Number.isFinite(saved) && saved >= 10 && saved <= 20
      ? saved
      : DEFAULT_LOG_FONT_SIZE;
  });

  const setLogFontSize = (next: number) => {
    const normalized = Math.min(20, Math.max(10, Math.round(next * 2) / 2));
    setLogFontSizeState(normalized);
    localStorage.setItem(LOG_FONT_SIZE_KEY, String(normalized));
  };

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(loadColumnWidths);
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(loadHiddenColumns);

  const handleColumnWidthChange = useCallback((id: string, width: number) => {
    setColumnWidths((prev) => {
      const next = { ...prev, [id]: width };
      saveColumnWidths(next);
      return next;
    });
  }, []);

  const handleColumnVisibilityChange = useCallback((hidden: string[]) => {
    setHiddenColumns(hidden);
    saveHiddenColumns(hidden);
  }, []);

  /* 每个标签页的独立状态：搜索过滤 + 自动滚动 + 路径输入框 + 选择器弹窗开关 */
  const [tabStates, setTabStates] = useState<Record<string, TabViewState>>({});

  const getState = (k: string) => {
    const tab = tabs.find((t) => t.key === k);
    let defPath = tabStates[k]?.pathInput ?? tab?.remote_path ?? '';
    // 首次连接：pathInput 空且 remote_path 空时，读该服务器历史记录最新一条回填；无历史则保持空
    if (!defPath && tab?.server_id) {
      const history = getPathHistory(tab.server_id);
      defPath = history[0]?.path || '';
    }
    return (
      tabStates[k] || {
        filter: { ...DEFAULT_SEARCH_FILTER },
        autoScroll: true,
        pathInput: defPath,
        matched: null,
        pickerOpen: false,
        timeQuery: null,
      }
    );
  };
  const setState = (k: string, patch: Partial<TabViewState>) =>
    setTabStates((prev) => {
      const current = prev[k] ?? getState(k);
      return { ...prev, [k]: { ...current, ...patch } };
    });

  const activeTab = useMemo(() => tabs.find((t) => t.key === activeKey) || null, [tabs, activeKey]);

  /* === 启动 tail -F === */
  const handleStartTail = async (tab: LogTab) => {
    const state = getState(tab.key);
    const path = state.pathInput?.trim() || tab.remote_path;
    if (!path) {
      message.warning('请先输入要查看的日志文件路径');
      return;
    }
    // 通配路径：仅支持按时间范围查询
    if (isGlobPath(path)) {
      message.warning('通配路径（如 application-*.log）仅支持点击时间按钮按范围查询');
      return;
    }
    const server = servers.find((s) => s.id === tab.server_id);
    if (!server) {
      message.error('关联的服务器配置已不存在');
      return;
    }
    // 前置拦截：密码模式但无密文+无明文 → 直接打开编辑框让用户填密码
    const cache = secretsCache[server.id] || {};
    if (
      server.auth_type === 'Password' &&
      !cache.password &&
      !server.password_cipher
    ) {
      const confirm = await modal.confirm({
        title: '该服务器还没设置密码',
        content: '这是示例预填服务器，密码字段留空了。请现在输入密码后再连接，是否立刻打开编辑框？',
        okText: '立刻打开编辑框',
        cancelText: '取消',
      });
      if (confirm) openConnectionDialog(server.id);
      return;
    }
    if (
      server.auth_type === 'PrivateKey' &&
      !cache.private_key_pem &&
      !server.private_key_cipher &&
      !server.private_key_path
    ) {
      message.warning('该服务器未设置私钥，请先在编辑框粘贴 PEM 内容或选择私钥文件');
      openConnectionDialog(server.id);
      return;
    }
    // 先确保解密好密码（如果用户没打开过编辑框，这里自动从 cipher 解密）
    await ensureSecretsDecrypted(server.id);
    const { password_plain, private_key_pem_plain } = getPlainSecrets(server.id);
    const tab_server = tab.server_snapshot || server;
    try {
      updateTab(tab.key, { status: 'Connecting', last_message: `正在连接 ${server.host}:${server.port}...`, total_lines: 0, lines: [] });
      const session_id = await startTail(
        tab_server,
        path,
        200,
        password_plain,
        private_key_pem_plain,
      );
      // 启动成功后：把当前路径写入该服务器的历史记录（手敲路径回车的场景也能记下来）
      pushPathHistory(tab.server_id, path);
      updateTab(tab.key, {
        session_id,
        remote_path: path,
        title: `${server.title} · ${path.split('/').pop() || path}`,
        status: 'Connecting',
      });
    } catch (e: any) {
      updateTab(tab.key, { status: 'Error', last_message: e?.message || '启动失败' });
      // 错误提示里如果是密码未传入，直接再引导开编辑框
      const msg = String(e?.message || '');
      if (msg.includes('密码未传入') || msg.includes('密码为空')) {
        modal.confirm({
          title: '密码/私钥缺失',
          content: '启动失败，可能是该服务器没有保存密码或缓存已丢失。是否立刻打开服务器编辑框补填密码？',
          okText: '去填密码',
          cancelText: '稍后再说',
          onOk: () => openConnectionDialog(server.id),
        });
      } else {
        message.error(e?.message || '启动日志流失败');
      }
    }
  };

  /* === 停止 tail === */
  const handleStopTail = async (tab: LogTab) => {
    if (!tab.session_id) return;
    try {
      await apiStopTail(tab.session_id);
      updateTab(tab.key, { status: 'Disconnecting', last_message: '已请求停止' });
    } catch (e: any) {
      message.error(e?.message || '停止失败');
    }
  };

  /* === 加载历史日志（第 N 页） === */
  const handleLoadHistory = async (tab: LogTab, page = 1) => {
    const state = getState(tab.key);
    const path = state.pathInput?.trim() || tab.remote_path;
    if (!path) return message.warning('请先输入日志路径');
    const server = servers.find((s) => s.id === tab.server_id);
    if (!server) return;
    // 通配路径：仅支持按时间范围查询
    if (isGlobPath(path)) {
      message.warning('通配路径（如 application-*.log）仅支持点击时间按钮按范围查询');
      return;
    }
    await ensureSecretsDecrypted(server.id);
    const { password_plain, private_key_pem_plain } = getPlainSecrets(server.id);
    try {
      updateTab(tab.key, { last_message: `加载第 ${page} 页历史日志中...` });
      const lines = await fetchHistory(
        tab.server_snapshot || server,
        path,
        page,
        500,
        password_plain,
        private_key_pem_plain,
      );
      updateTab(tab.key, { lines, total_lines: lines.length, last_message: `已加载 ${lines.length} 行历史` });
      resetTimestampCache();
      message.success(`加载成功 ${lines.length} 行`);
    } catch (e: any) {
      updateTab(tab.key, { status: 'Error', last_message: e?.message });
      message.error(e?.message || '加载失败');
    }
  };

  /* === 按时间范围加载历史日志（服务端 awk 过滤） === */
  const handleLoadByTime = async (
    tab: LogTab,
    startMs: number,
    endMs: number,
    append = false,
  ) => {
    const state = getState(tab.key);
    if (state.timeQuery?.loading) return;
    const path = state.pathInput?.trim() || tab.remote_path;
    if (!path) {
      message.warning('请先输入日志路径');
      return;
    }
    const server = servers.find((s) => s.id === tab.server_id);
    if (!server) return;
    await ensureSecretsDecrypted(server.id);
    const { password_plain, private_key_pem_plain } = getPlainSecrets(server.id);
    const sameRange = state.timeQuery?.startMs === startMs && state.timeQuery?.endMs === endMs;
    const offset = append && sameRange ? state.timeQuery?.nextOffset ?? 0 : 0;
    setState(tab.key, {
      timeQuery: {
        startMs,
        endMs,
        nextOffset: offset,
        hasMore: state.timeQuery?.hasMore ?? true,
        loading: true,
      },
    });
    try {
      updateTab(tab.key, {
        last_message: append ? `继续加载第 ${offset + 1} 行之后的日志...` : '按时间范围加载日志中...',
      });
      const lines = await fetchHistoryByTime(
        tab.server_snapshot || server,
        path,
        startMs,
        endMs,
        TIME_QUERY_PAGE_SIZE,
        offset,
        password_plain,
        private_key_pem_plain,
      );
      const existing = append && sameRange ? tab.lines : [];
      const merged = [...existing, ...lines];
      const hasMore = lines.length === TIME_QUERY_PAGE_SIZE;
      updateTab(tab.key, {
        lines: merged,
        total_lines: merged.length,
        last_message: hasMore
          ? `时间段内已加载 ${merged.length} 行，可继续加载`
          : `时间段内已加载全部 ${merged.length} 行`,
      });
      setState(tab.key, {
        matched: null,
        timeQuery: {
          startMs,
          endMs,
          nextOffset: offset + lines.length,
          hasMore,
          loading: false,
        },
      });
      if (lines.length === 0) {
        message.info(append ? '已经加载完该时间段的全部日志' : '该时间段内没有匹配的日志');
      } else {
        message.success(append ? `继续加载 ${lines.length} 行` : `已加载 ${lines.length} 行`);
      }
    } catch (e: any) {
      setState(tab.key, {
        timeQuery: {
          startMs,
          endMs,
          nextOffset: offset,
          hasMore: true,
          loading: false,
        },
      });
      updateTab(tab.key, { status: 'Error', last_message: e?.message });
      message.error(e?.message || '按时间加载失败');
    }
  };

  /* === 服务端 grep 搜索 === */
  const handleSearchRemote = async (tab: LogTab) => {
    const state = getState(tab.key);
    const path = state.pathInput?.trim() || tab.remote_path;
    const kw = (state.filter.keyword ?? []).filter(Boolean).join(' ');
    const excludeKw = (state.filter.keyword_exclude ?? []).filter(Boolean).join(' ');
    if (!path) return;
    const server = servers.find((s) => s.id === tab.server_id);
    if (!server) return;
    // 通配路径：仅支持按时间范围查询
    if (isGlobPath(path)) {
      if (kw || excludeKw) {
        message.warning('通配路径（如 application-*.log）仅支持按时间范围查询，不支持关键字搜索');
      }
      return;
    }
    await ensureSecretsDecrypted(server.id);
    const { password_plain, private_key_pem_plain } = getPlainSecrets(server.id);

    // 所有搜索/排除条件已清空 → 恢复原始数据
    if (!kw && !excludeKw) {
      if (state.timeQuery?.startMs && state.timeQuery?.endMs) {
        // 有时间范围查询：重新按时间加载
        await handleLoadByTime(tab, state.timeQuery.startMs, state.timeQuery.endMs, false);
      } else {
        // 无时间范围：加载历史第 1 页
        await handleLoadHistory(tab, 1);
      }
      setState(tab.key, { matched: null });
      return;
    }

    try {
      const excludeHint = excludeKw ? ` 排除: ${excludeKw}` : '';
      updateTab(tab.key, { last_message: `正在远端 grep "${kw || '*'}"${excludeHint} ...` });
      const lines = await searchLogs(
        tab.server_snapshot || server,
        path,
        kw,
        excludeKw,
        state.filter.regex,
        state.filter.case_insensitive,
        5000,
        password_plain,
        private_key_pem_plain,
      );
      updateTab(tab.key, { lines, total_lines: lines.length, last_message: `搜索命中 ${lines.length} 条` });
      setState(tab.key, { matched: lines.length });
      message.success(`命中 ${lines.length} 条`);
    } catch (e: any) {
      message.error(e?.message || '搜索失败');
    }
  };

  /* === Logback 专用模式：按 traceId 跨当前文件/滚动文件追踪 === */
  const handleTraceRemote = async (tab: LogTab, traceId: string) => {
    const state = getState(tab.key);
    const path = state.pathInput?.trim() || tab.remote_path;
    if (!path) {
      message.warning('请先选择日志文件或 Logback 日志源');
      return;
    }
    const server = servers.find((s) => s.id === tab.server_id);
    if (!server) {
      message.error('关联的服务器配置已不存在');
      return;
    }
    await ensureSecretsDecrypted(server.id);
    const { password_plain, private_key_pem_plain } = getPlainSecrets(server.id);
    try {
      updateTab(tab.key, { last_message: `正在追踪 traceId ${traceId} ...` });
      const lines = await searchByTraceId(
        tab.server_snapshot || server,
        path,
        traceId,
        5000,
        password_plain,
        private_key_pem_plain,
      );
      updateTab(tab.key, {
        lines,
        total_lines: lines.length,
        last_message: `traceId ${traceId} 命中 ${lines.length} 行`,
      });
      setState(tab.key, {
        matched: lines.length,
        filter: { ...state.filter, trace_id: traceId },
      });
      if (lines.length) message.success(`链路追踪命中 ${lines.length} 行`);
      else message.info('没有找到该 traceId 的结构化日志');
    } catch (e: any) {
      message.error(e?.message || '链路追踪失败');
    }
  };

  /** 从当前日志路径推导 logback.xml 的 LOG_PATH 父目录（不含 /logs） */
  const inferLogRoot = (path: string) => {
    const clean = path.trim();
    const marker = '/logs/';
    const idx = clean.indexOf(marker);
    if (idx >= 0) return clean.slice(0, idx); // 返回日志根目录，让后端拼接 logs/xxx.log
    if (clean.endsWith('/logs')) return clean.slice(0, -5); // 去掉末尾 /logs
    return '/var/log/app';
  };

  const runLogbackProbe = async (tab: LogTab, baseDir: string) => {
    const server = servers.find((s) => s.id === tab.server_id);
    if (!server) return message.error('关联的服务器配置已不存在');
    setProbing(true);
    try {
      await ensureSecretsDecrypted(server.id);
      const { password_plain, private_key_pem_plain } = getPlainSecrets(server.id);
      const results = await probeLogSources(
        tab.server_snapshot || server,
        baseDir.trim(),
        password_plain,
        private_key_pem_plain,
      );
      setProbeResults(results);
    } catch (e: any) {
      setProbeResults([]);
      message.error(e?.message || 'Logback 日志源探测失败');
    } finally {
      setProbing(false);
    }
  };

  const openLogbackMode = (tab: LogTab) => {
    const currentPath = getState(tab.key).pathInput || tab.remote_path || '';
    const inferredRoot = inferLogRoot(currentPath);
    
    setProbeTabKey(tab.key);
    setProbeResults([]);
    setLogbackConfig(null);

    if (tab.server_id) {
      getLogbackConfig(tab.server_id)
        .then((cfg) => {
          if (cfg) {
            setLogbackConfig(cfg);
            // log_base_path 只有是绝对路径时才用作探测基础目录；
            // 相对路径（如 "logs"）会与 glob_pattern 中的 "logs/" 前缀重复拼接
            const useLogbasePath = cfg.log_base_path && cfg.log_base_path.startsWith('/');
            const probeBase = useLogbasePath ? cfg.log_base_path! : inferredRoot;
            setProbeBase(probeBase);
            setProbeOpen(true);
            void runLogbackProbe(tab, probeBase);
          } else {
            setProbeBase(inferredRoot);
            setProbeOpen(true);
            void runLogbackProbe(tab, inferredRoot);
          }
        })
        .catch(() => {
          setProbeBase(inferredRoot);
          setProbeOpen(true);
          void runLogbackProbe(tab, inferredRoot);
        });
    } else {
      setProbeBase(inferredRoot);
      setProbeOpen(true);
      void runLogbackProbe(tab, inferredRoot);
    }
  };

  const selectLogbackSource = (result: LogSourceProbeResult, latestOnly: boolean) => {
    if (!probeTabKey) return;
    const tab = tabs.find((x) => x.key === probeTabKey);
    if (!tab) return;
    const path = latestOnly && result.latest_file
      ? result.latest_file
      : result.glob_path;
    setState(tab.key, { pathInput: path });
    updateTab(tab.key, {
      remote_path: path,
      title: `${servers.find((s) => s.id === tab.server_id)?.title || tab.server_id} · ${result.group}/${result.label}`,
      last_message: latestOnly
        ? '已进入 Logback 实时模式，可启动 Tail -F'
        : '已进入 Logback 滚动日志模式，请用时间范围或 traceId 查询',
    });
    pushPathHistory(tab.server_id, path);
    setProbeOpen(false);
  };

  /* === V10 新增：路径输入框 blur（失焦）时客户端+服务端双重校验 === */
  const handlePathBlur = async (tab: LogTab) => {
    const state = getState(tab.key);
    const raw = state.pathInput?.trim();
    if (!raw) return;
    // 通配路径：跳过服务端存在性校验（glob 本身不是真实文件）
    if (isGlobPath(raw)) return;
    const preErr = prevalidatePathClient(raw);
    if (preErr) {
      message.warning(`路径校验失败：${preErr}`);
      return;
    }
    const server = servers.find((s) => s.id === tab.server_id);
    if (!server) return;
    try {
      await ensureSecretsDecrypted(server.id);
      const { password_plain, private_key_pem_plain } = getPlainSecrets(server.id);
      const v = await validateServerPath(
        tab.server_snapshot || server,
        raw,
        password_plain,
        private_key_pem_plain,
      );
      if (!v.safe) {
        message.error(`路径不安全：${v.reason || '已拦截'}`);
        return;
      }
      if (!v.exists) {
        message.warning(`路径不存在：${v.normalized_path}（可继续输入正确路径）`);
        return;
      }
      if (!v.readable) {
        message.warning(`当前 SSH 用户（${server.username}）无权读取：${v.normalized_path}`);
        return;
      }
      // 合法：把输入框归一化为真实路径
      setState(tab.key, { pathInput: v.normalized_path });
    } catch (e: any) {
      // 校验失败不要打断用户继续输入
      message.info(`路径校验出错：${e?.message || '未知'}，仍可继续输入`);
    }
  };

  /* === V10 新增：目录选择器确定回调 → 填充 pathInput 并更新 tab.remote_path === */
  const handlePickerConfirm = (tab: LogTab, absPath: string, _isFile: boolean, entry: DirEntry | null) => {
    setState(tab.key, { pathInput: absPath, pickerOpen: false });
    // 选择路径后写入该服务器的历史记录（去重+置顶，限 10 条）
    pushPathHistory(tab.server_id, absPath);
    // 如果选的是可读文件，直接把 tab.remote_path 同步更新过去（用户点 Tail -F 时直接生效）
    if (entry && entry.readable) {
      updateTab(tab.key, {
        remote_path: absPath,
        title: `${servers.find((s) => s.id === tab.server_id)?.title || tab.server_id} · ${absPath.split('/').pop() || absPath}`,
      });
      message.success(`已选择：${absPath}`);
    } else {
      message.success(`已填入路径：${absPath}`);
    }
  };

  /* === 导出当前显示的日志 === */
  const handleExport = (tab: LogTab) => {
    if (!tab.lines.length) return message.warning('暂无日志可导出');
    const content = tab.lines.map((l) => l.raw).join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tab.title.replace(/[^\w\u4e00-\u9fa5.-]/g, '_')}_${Date.now()}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message.success('已导出为 .log 文件');
  };

  /* ===== 过滤与分面统计缓存 =====
   * 单标签日志量可达 20 万行，过滤与分面统计都是 O(n)，必须按签名缓存；
   * 否则父组件每次重渲染（状态消息更新、tab 切换等）都会全量重算导致卡顿 */
  const filterCacheRef = useRef<
    Map<string, { lines: LogTab['lines']; filterSig: string; result: FilterResult }>
  >(new Map());
  const facetCacheRef = useRef<
    Map<string, { lines: LogTab['lines']; loggers: FacetStat[]; threads: FacetStat[]; sources: ReturnType<typeof collectSourceFacets>; traceIds: string[] }>
  >(new Map());

  /** 过滤条件签名（决定是否需要重算过滤结果） */
  const filterSig = (f: SearchFilter) =>
    JSON.stringify([
      f.keyword, f.regex, f.case_insensitive, f.levels,
      f.time_start_ms, f.time_end_ms,
      f.loggers, f.logger_exclude, f.threads, f.sources, f.trace_id,
      f.collapse_noisy, f.collapse_stacktrace,
    ]);

  /**
   * 按当前标签页的过滤条件计算渲染行
   * 一次完成：续行归并 + 结构化字段过滤 + 刷屏 logger 折叠
   */
  const computeRows = (tab: LogTab): FilterResult => {
    const f = getState(tab.key).filter;
    const currentFilterSig = filterSig(f);
    const cached = filterCacheRef.current.get(tab.key);
    if (
      cached &&
      cached.lines === tab.lines &&
      cached.filterSig === currentFilterSig
    ) return cached.result;
    // 刷屏 logger 自动识别（如每 N 秒一次的定时轮询，实测可占 81%）
    const noisy = detectNoisyLoggers(tab.lines);
    const result = applyLogFilter(tab.lines, f, noisy);
    filterCacheRef.current.set(tab.key, {
      lines: tab.lines,
      filterSig: currentFilterSig,
      result,
    });
    return result;
  };

  /** 分面统计：logger / 线程 / traceId 下拉候选（只依赖 lines，不依赖过滤条件） */
  const computeFacets = (tab: LogTab) => {
    const cached = facetCacheRef.current.get(tab.key);
    if (cached && cached.lines === tab.lines) return cached;
    const value = {
      lines: tab.lines,
      loggers: collectLoggerFacets(tab.lines),
      threads: collectThreadFacets(tab.lines),
      sources: collectSourceFacets(tab.lines),
      traceIds: collectTraceIds(tab.lines),
    };
    facetCacheRef.current.set(tab.key, value);
    return value;
  };

  /* === 渲染单个 Tab 的内容 === */
  const renderTabContent = (tab: LogTab) => {
    const state = getState(tab.key);
    const server = servers.find((s) => s.id === tab.server_id);
    const filtered = computeRows(tab);
    const facets = computeFacets(tab);
    const statusColor =
      tab.status === 'Streaming' || tab.status === 'Connected'
        ? 'green'
        : tab.status === 'Error'
        ? 'red'
        : tab.status === 'Connecting' || tab.status === 'Disconnecting'
        ? 'gold'
        : 'default';

    const historyItems = getPathHistory(tab.server_id);
    const quickMenu: MenuProps = {
      items: historyItems.length
        ? historyItems.map((h) => ({
            key: h.path + '|' + h.at,
            label: (
              <div className="flex items-center justify-between gap-3 min-w-[380px] py-1">
                <code className="text-[11.5px] truncate" style={{ color: 'var(--ls-text-primary)' }}>
                  {h.path}
                </code>
                <span className="text-[10px] shrink-0" style={{ color: 'var(--ls-text-tertiary)' }}>
                  {formatRelative(h.at)}
                </span>
              </div>
            ),
            onClick: () => setState(tab.key, { pathInput: h.path }),
          }))
        : [
            {
              key: 'empty',
              disabled: true,
              label: (
                <span className="text-xs italic" style={{ color: 'var(--ls-text-tertiary)' }}>
                  暂无历史，先点击右侧「浏览」选择日志路径吧
                </span>
              ),
            },
          ],
    };

    return (
      <div
        className="h-full flex flex-col min-h-0"
        style={{ backgroundColor: 'var(--ls-bg-base)' }}
      >
        {/* 工具栏：路径+操作按钮+状态 */}
        <div
          className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b"
          style={{
            borderColor: 'var(--ls-border-l1)',
            backgroundColor: 'var(--ls-bg-surface)',
          }}
        >
          <div
            className="text-[11px] shrink-0 flex items-center gap-1.5"
            style={{ color: 'var(--ls-text-secondary)' }}
          >
            <span>服务器</span>
            <span
              className="font-medium"
              style={{ color: 'var(--ls-text-primary)' }}
            >
              {server?.title || tab.server_id}
            </span>
            <span style={{ color: 'var(--ls-border-l2)' }}>|</span>
            <Tag color={statusColor} className="!m-0 !text-[10.5px] !py-0 !px-1.5 rounded-full">
              {statusLabel[tab.status]}
            </Tag>
            {tab.last_message && (
              <span
                className="ml-1.5 text-[10.5px] truncate max-w-[320px] align-middle inline-block"
                style={{ color: 'var(--ls-text-tertiary)' }}
              >
                {tab.last_message}
              </span>
            )}
          </div>
          <div className="flex-1" />
          <Tooltip title="探测服务器上的日志源：优先使用已导入的 logback.xml 配置，无配置时使用内置预设">
            <Button
              size="small"
              icon={<ApartmentOutlined />}
              onClick={() => openLogbackMode(tab)}
              className="mac-titlebar-nd !text-[11.5px] rounded-lg"
            >
              日志源探测
            </Button>
          </Tooltip>
          <Dropdown menu={quickMenu} trigger={['click']} placement="bottomLeft">
            <Button
              size="small"
              icon={<HistoryOutlined />}
              className="!px-2 !text-[11.5px] mac-titlebar-nd rounded-lg"
            >
              历史记录
            </Button>
          </Dropdown>
          <div className="flex items-center gap-0.5">
            <Input
              size="small"
              style={{ width: 460, minWidth: 260 }}
              placeholder="日志文件路径（通配如 application-*.log 支持按时间查询）"
              prefix={<FileSearchOutlined style={{ color: 'var(--ls-text-tertiary)' }} />}
              addonAfter={
                <Tooltip title="浏览服务器目录">
                  <span
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer px-1 hover:text-blue-500 !text-[11.5px]"
                    style={{ color: 'var(--ls-brand-cyan)' }}
                    onClick={() => setState(tab.key, { pickerOpen: true })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        setState(tab.key, { pickerOpen: true });
                      }
                    }}
                  >
                    <FolderOpenOutlined /> 浏览
                  </span>
                </Tooltip>
              }
              value={state.pathInput}
              onChange={(e) => setState(tab.key, { pathInput: e.target.value })}
              onBlur={() => handlePathBlur(tab)}
              onPressEnter={() => handleStartTail(tab)}
              className="mac-titlebar-nd rounded-lg"
            />
          </div>
          {tab.status === 'Streaming' || tab.status === 'Connecting' ? (
            <Tooltip title="停止实时日志流">
              <Button
                danger
                size="small"
                icon={<StopOutlined />}
                onClick={() => handleStopTail(tab)}
                className="mac-titlebar-nd !text-[11.5px] rounded-lg"
              >
                停止
              </Button>
            </Tooltip>
          ) : (
            <Tooltip title="启动 tail -F 实时日志流">
              <Button
                type="primary"
                size="small"
                icon={<PlayCircleFilled />}
                onClick={() => handleStartTail(tab)}
                className="mac-titlebar-nd !text-[11.5px] rounded-lg ls-btn-primary-glow"
              >
                Tail -F
              </Button>
            </Tooltip>
          )}
          <Tooltip title="加载最近 500 行历史日志">
            <Button
              size="small"
              icon={<HistoryOutlined />}
              onClick={() => handleLoadHistory(tab, 1)}
              className="mac-titlebar-nd !text-[11.5px] rounded-lg"
            >
              历史
            </Button>
          </Tooltip>
          <Tooltip title="重新加载">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() =>
                tab.status === 'Streaming'
                  ? handleStartTail(tab)
                  : handleLoadHistory(tab, 1)
              }
              className="mac-titlebar-nd rounded-lg"
            />
          </Tooltip>
        </div>

        {/* 搜索过滤栏 */}
        <SearchFilterBar
          filter={state.filter}
          onChange={(patch) => setState(tab.key, { filter: { ...state.filter, ...patch } })}
          onReset={async () => {
            setState(tab.key, {
              filter: { ...DEFAULT_SEARCH_FILTER },
              matched: null,
            });
            // 恢复原始数据
            const state = getState(tab.key);
            if (state.timeQuery?.startMs && state.timeQuery?.endMs) {
              await handleLoadByTime(tab, state.timeQuery.startMs, state.timeQuery.endMs, false);
            } else {
              await handleLoadHistory(tab, 1);
            }
          }}
          onSearchRemote={async (kw, excludeKw, regex, case_i) => {
            setState(tab.key, {
              filter: {
                ...state.filter,
                keyword: kw ? kw.split(/\s+/).filter(Boolean) : [],
                keyword_exclude: excludeKw ? excludeKw.split(/\s+/).filter(Boolean) : [],
                regex,
                case_insensitive: case_i,
              },
            });
            handleSearchRemote(tab);
          }}
          onApplyTimeRange={(start, end) => {
            // 非实时流状态：点击时间按钮时自动从服务器按时间段拉取日志
            const busy = tab.status === 'Streaming' || tab.status === 'Connecting';
            if (busy) return;
            if (start !== null && end !== null) {
              handleLoadByTime(tab, start, end);
            } else {
              // 清除时间筛选：重新加载最近历史
              setState(tab.key, { timeQuery: null });
              handleLoadHistory(tab, 1);
            }
          }}
          onExport={() => handleExport(tab)}
          onReloadHistory={() => handleLoadHistory(tab, 1)}
          totalCount={tab.total_lines}
          matchedCount={state.matched ?? filtered.rows.length}
          autoScroll={state.autoScroll}
          onAutoScrollChange={(v) => setState(tab.key, { autoScroll: v })}
          logFontSize={logFontSize}
          onLogFontSizeChange={setLogFontSize}
          /* 结构化过滤：下拉候选 + 折叠状态 + 链路追踪 */
          loggerFacets={facets.loggers}
          threadFacets={facets.threads}
          sourceFacets={facets.sources}
          traceIds={facets.traceIds}
          collapsedNoisy={filtered.collapsedNoisy}
          onTraceRemote={(tid) => handleTraceRemote(tab, tid)}
        />

        {state.timeQuery && tab.lines.length > 0 && (
          <div
            className="flex items-center justify-center gap-2 border-b py-1.5"
            style={{ borderColor: 'var(--ls-border-l1)', backgroundColor: 'var(--ls-bg-surface)' }}
          >
            <span className="text-[11px]" style={{ color: 'var(--ls-text-tertiary)' }}>
              已加载 {tab.lines.length.toLocaleString()} 行，最新日志在上
            </span>
            <Button
              size="small"
              loading={state.timeQuery.loading}
              disabled={!state.timeQuery.hasMore}
              onClick={() => handleLoadByTime(
                tab,
                state.timeQuery!.startMs,
                state.timeQuery!.endMs,
                true,
              )}
              className="rounded-lg !text-[11px]"
            >
              {state.timeQuery.hasMore ? '加载更多 5,000 行' : '已加载全部'}
            </Button>
          </div>
        )}

        {/* 日志查看器（占满剩余空间） */}
        <div className="flex-1 min-h-0 flex flex-col">
          <LogColumnHeader
            columnWidths={columnWidths}
            hiddenColumns={hiddenColumns}
            onColumnWidthChange={handleColumnWidthChange}
            onColumnVisibilityChange={handleColumnVisibilityChange}
          />
          <div className="flex-1 min-h-0">
            <LogViewer
              rows={filtered.rows}
              filter={state.filter}
              autoScroll={state.autoScroll && tab.status === 'Streaming'}
              fontSize={logFontSize}
              columnWidths={columnWidths}
              hiddenColumns={hiddenColumns}
            onCopy={async (text) => {
              try {
                await writeText(text);
                message.success('已复制日志消息');
              } catch {
                message.error('复制失败，请手动选中后 Cmd+C');
              }
            }}
            />
          </div>
        </div>
      </div>
    );
  };

  /* === Tabs 渲染 === */
  const tabItems: TabsProps['items'] = tabs.map((t) => ({
    key: t.key,
    label: (
      <span className="inline-flex items-center gap-1.5 text-[12.5px]">
        <span className="truncate max-w-[220px]">{t.title}</span>
        {t.status === 'Streaming' && (
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
        )}
        {t.status === 'Error' && (
          <Tag color="red" className="!m-0 !text-[9px] !py-0 !px-1 rounded-full">ERR</Tag>
        )}
      </span>
    ),
    children: renderTabContent(t),
    closeIcon: <CloseOutlined className="text-xs hover:text-red-400" />,
  }));

  if (tabs.length === 0) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center">
        <Empty
          description={
            <div className="text-center space-y-2">
              <div className="text-sm" style={{ color: 'var(--ls-text-secondary)' }}>
                还没有打开的日志标签页
              </div>
              <div className="text-[11.5px]" style={{ color: 'var(--ls-text-tertiary)' }}>
                在左侧服务器列表双击服务器卡片，或点击"打开日志"即可创建
              </div>
            </div>
          }
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </div>
    );
  }

  return (
    <>
      <Tabs
        className="h-full flex flex-col min-h-0 logsight-tab-bar"
        size="small"
        type="editable-card"
        hideAdd
        activeKey={activeKey ?? undefined}
        onChange={(k) => onChange(k)}
        onEdit={(k, act) => {
          if (act === 'remove' && typeof k === 'string') {
            const tab = tabs.find((t) => t.key === k);
            if (tab && (tab.status === 'Streaming' || tab.status === 'Connecting')) {
              modal.confirm({
                title: '该标签页正在进行实时流，确认关闭？',
                content: '关闭后将自动停止对应的日志流会话。',
                okText: '关闭',
                cancelText: '取消',
                onOk: async () => {
                  if (tab.session_id) await apiStopTail(tab.session_id).catch(() => {});
                  onRemove(k);
                },
              });
            } else {
              onRemove(k);
            }
          }
        }}
        items={tabItems}
      />
      {/* V10 新增：activeTab 对应的目录选择器弹窗（单例，因为同一时间只有一个 active tab） */}
      {activeTab && (() => {
        const tab = activeTab;
        const st = getState(tab.key);
        const server = servers.find((s) => s.id === tab.server_id);
        if (!server || !st.pickerOpen) return null;
        const secrets = getPlainSecrets(server.id);
        const snapshot = tab.server_snapshot || server;
        return (
          <ServerDirectoryPicker
            open={st.pickerOpen}
            onCancel={() => setState(tab.key, { pickerOpen: false })}
            onOk={(absPath, isFile, entry) => handlePickerConfirm(tab, absPath, isFile, entry ?? null)}
            server={snapshot}
            passwordPlain={secrets.password_plain}
            privateKeyPemPlain={secrets.private_key_pem_plain}
            initialValue={st.pathInput || tab.remote_path}
          />
        );
      })()}
      <Modal
        open={probeOpen}
        title="日志源探测"
        width={900}
        footer={null}
        onCancel={() => setProbeOpen(false)}
        style={{ maxWidth: '95vw' }}
      >
        <div className="flex gap-2 mb-3">
          <Input
            value={probeBase}
            onChange={(e) => setProbeBase(e.target.value)}
            placeholder="日志根目录，如 /var/log/app/logs"
            onPressEnter={() => {
              const tab = tabs.find((x) => x.key === probeTabKey);
              if (tab) void runLogbackProbe(tab, probeBase);
            }}
          />
          <Button
            type="primary"
            loading={probing}
            onClick={() => {
              const tab = tabs.find((x) => x.key === probeTabKey);
              if (tab) void runLogbackProbe(tab, probeBase);
            }}
          >
            探测
          </Button>
        </div>
        <div className="text-xs mb-3" style={{ color: 'var(--ls-text-secondary)' }}>
          探测服务器上的日志文件分布。若该服务器已导入 logback.xml 配置，将按配置中的路径模式探测；否则使用内置预设。
          {logbackConfig && (
            <span className="ml-2" style={{ color: 'var(--ls-text-tertiary)' }}>
              · 已加载 {logbackConfig.appenders.length} 个 appender 配置
            </span>
          )}
        </div>
        <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
          {/* 诊断信息：当所有结果都未发现文件时，显示服务器目录内容 */}
          {probeResults.length > 0 &&
            probeResults.every((r) => !r.exists) &&
            probeResults[0].diagnostic_listing && (
              <div
                className="rounded-lg border px-3 py-2 text-[11px]"
                style={{
                  borderColor: 'var(--ls-border-l1)',
                  backgroundColor: 'var(--ls-bg-secondary)',
                }}
              >
                <div className="font-medium mb-1" style={{ color: 'var(--ls-text-secondary)' }}>
                  📁 服务器目录内容（{probeBase}/logs/）：
                </div>
                <code
                  className="block break-all font-mono"
                  style={{ color: 'var(--ls-text-tertiary)', maxHeight: '120px', overflow: 'auto' }}
                >
                  {probeResults[0].diagnostic_listing || '（空目录或无法访问）'}
                </code>
              </div>
            )}
          {probeResults.map((r) => (
            <div
              key={r.preset_key}
              className="flex items-center gap-2 rounded-lg border px-3 py-2"
              style={{ borderColor: 'var(--ls-border-l1)' }}
            >
              <div className="w-[140px] flex-shrink-0">
                <div className="font-medium text-sm">{r.group} · {r.label}</div>
                <div className="text-[11px]" style={{ color: 'var(--ls-text-tertiary)' }}>
                  {r.exists ? `${r.file_count} 个文件` : '未发现文件'}
                </div>
              </div>
              <code
                className="flex-1 truncate text-[11px] font-mono"
                title={r.glob_path}
                style={{ minWidth: 0 }}
              >
                {r.glob_path}
              </code>
              <Button
                size="small"
                onClick={() => selectLogbackSource(r, false)}
                className="flex-shrink-0"
              >
                查滚动日志
              </Button>
              <Button
                size="small"
                type="primary"
                onClick={() => selectLogbackSource(r, true)}
                className="flex-shrink-0"
              >
                实时最新
              </Button>
            </div>
          ))}
          {!probing && probeResults.length === 0 && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入日志根目录后点击探测" />
          )}
        </div>
      </Modal>
    </>
  );
};

export default LogViewerTabs;
