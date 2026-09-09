/*
 * LogSight 全局状态管理 Store（基于 zustand）
 * 管理：服务器列表、主密码、已打开的日志标签页、搜索过滤条件
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */
import { create } from 'zustand';
import type {
  ServerConfig,
  LogTab,
  SearchFilter,
  SessionStatus,
  LogLine,
} from '@/types';
import { decryptSecret } from '@/services/tauriApi';
import { DEFAULT_SEARCH_FILTER } from '@/utils/logFilter';

/*
 * LogSight 全局状态接口
 */
interface AppState {
  /* ===== 主题（白天/黑夜） ===== */
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  setTheme: (t: 'dark' | 'light') => void;

  /* ===== 服务器列表 ===== */
  servers: ServerConfig[];
  setServers: (list: ServerConfig[]) => void;
  addOrUpdateServer: (s: ServerConfig) => void;
  removeServer: (id: string) => void;

  /* ===== 应用主密码（会话级，不持久化） ===== */
  masterPassword: string | null;
  setMasterPassword: (pw: string) => void;

  /* ===== 解密后的明文缓存（内存中，刷新清空） ===== */
  secretsCache: Record<string, { password?: string; private_key_pem?: string }>;
  setSecret: (serverId: string, pwd?: string, pem?: string) => void;
  clearSecrets: () => void;

  /* ===== 日志标签页 ===== */
  tabs: LogTab[];
  activeTabKey: string | null;
  setActiveTab: (key: string | null) => void;
  addTab: (tab: LogTab) => void;
  removeTab: (key: string) => void;
  updateTab: (key: string, patch: Partial<LogTab>) => void;
  appendLinesToTab: (session_id: string, lines: LogLine[]) => void;
  updateTabBySessionId: (session_id: string, patch: Partial<LogTab>) => void;

  /* ===== 搜索过滤条件（当前激活标签页生效） ===== */
  searchFilter: SearchFilter;
  setSearchFilter: (patch: Partial<SearchFilter>) => void;
  resetSearchFilter: () => void;

  /* ===== 连接对话框 ===== */
  connectionDialogVisible: boolean;
  connectionDialogEditingId: string | null;
  openConnectionDialog: (editingId?: string | null) => void;
  closeConnectionDialog: () => void;
}

/* 默认搜索过滤条件统一定义在 utils/logFilter，store 与各标签页共用同一份 */
const THEME_LS_KEY = 'logsight:theme';

const loadInitialTheme = (): 'dark' | 'light' => {
  if (typeof window === 'undefined') return 'dark';
  try {
    const saved = localStorage.getItem(THEME_LS_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch (_) {}
  return 'dark';
};

export const useAppStore = create<AppState>((set, get) => ({
  /* ===== 主题（白天/黑夜，localStorage 持久化） ===== */
  theme: loadInitialTheme(),
  setTheme: (t) => {
    set({ theme: t });
    try {
      localStorage.setItem(THEME_LS_KEY, t);
      if (typeof document !== 'undefined') {
        const root = document.documentElement;
        const body = document.body;
        if (t === 'dark') {
          root.classList.add('dark');
          root.classList.remove('light');
          body && body.classList.add('dark');
          body && body.classList.remove('light');
        } else {
          root.classList.remove('dark');
          root.classList.add('light');
          body && body.classList.remove('dark');
          body && body.classList.add('light');
        }
      }
    } catch (_) {}
  },
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    get().setTheme(next);
  },
  /* ===== 服务器列表 ===== */
  servers: [],
  setServers: (list) => set({ servers: list }),
  addOrUpdateServer: (s) =>
    set((state) => {
      const idx = state.servers.findIndex((x) => x.id === s.id);
      const arr = [...state.servers];
      if (idx >= 0) arr[idx] = s;
      else arr.unshift(s);
      return { servers: arr };
    }),
  removeServer: (id) =>
    set((state) => ({ servers: state.servers.filter((x) => x.id !== id) })),

  /* ===== 应用主密码 ===== */
  masterPassword: null,
  setMasterPassword: (pw) => set({ masterPassword: pw }),

  /* ===== 解密缓存 ===== */
  secretsCache: {},
  setSecret: (serverId, pwd, pem) =>
    set((state) => {
      const next = { ...state.secretsCache };
      const prev = next[serverId] || {};
      const merged: typeof prev = { ...prev };
      if (typeof pwd !== 'undefined') merged.password = pwd;
      if (typeof pem !== 'undefined') merged.private_key_pem = pem;
      next[serverId] = merged;
      return { secretsCache: next };
    }),
  clearSecrets: () => set({ secretsCache: {} }),

  /* ===== 日志标签页 ===== */
  tabs: [],
  activeTabKey: null,
  setActiveTab: (key) => set({ activeTabKey: key }),
  addTab: (tab) =>
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabKey: tab.key,
    })),
  removeTab: (key) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.key !== key);
      let nextActive = state.activeTabKey;
      if (state.activeTabKey === key) {
        nextActive = tabs.length ? tabs[tabs.length - 1].key : null;
      }
      return { tabs, activeTabKey: nextActive };
    }),
  updateTab: (key, patch) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)),
    })),
  appendLinesToTab: (session_id, lines) =>
    set((state) => ({
      tabs: state.tabs.map((t) => {
        if (t.session_id !== session_id) return t;
        const merged = [...t.lines, ...lines];
        // 限制单标签最大行数，避免极端情况内存爆炸
        const MAX = 200000;
        const trimmed = merged.length > MAX ? merged.slice(merged.length - MAX) : merged;
        return {
          ...t,
          lines: trimmed,
          total_lines: trimmed.length,
        };
      }),
    })),
  updateTabBySessionId: (session_id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.session_id === session_id ? { ...t, ...patch } : t,
      ),
    })),

  /* ===== 搜索过滤 ===== */
  searchFilter: { ...DEFAULT_SEARCH_FILTER },
  setSearchFilter: (patch) =>
    set((state) => ({ searchFilter: { ...state.searchFilter, ...patch } })),
  resetSearchFilter: () => set({ searchFilter: { ...DEFAULT_SEARCH_FILTER } }),

  /* ===== 连接对话框 ===== */
  connectionDialogVisible: false,
  connectionDialogEditingId: null,
  openConnectionDialog: (editingId = null) =>
    set({ connectionDialogVisible: true, connectionDialogEditingId: editingId }),
  closeConnectionDialog: () =>
    set({ connectionDialogVisible: false, connectionDialogEditingId: null }),
}));

/* 工具函数：从 store 中根据服务器 ID 获取解密后的明文凭证 */
export function getPlainSecrets(serverId: string): {
  password_plain: string | null;
  private_key_pem_plain: string | null;
} {
  const cache = useAppStore.getState().secretsCache[serverId] || {};
  return {
    password_plain: cache.password ?? null,
    private_key_pem_plain: cache.private_key_pem ?? null,
  };
}

/**
 * 确保某台服务器的明文凭证已解密并写入缓存（按需解密 cipher）
 * 用于：开 Tab 执行 Tail-F / 历史加载 / 搜索之前，如果用户没打开过编辑框，
 * secretsCache 里没值但 ServerConfig 有 password_cipher / private_key_cipher，
 * 这里自动调用后端解密并写入缓存，避免连接时因密码 null 直接失败。
 */
export async function ensureSecretsDecrypted(serverId: string): Promise<void> {
  const state = useAppStore.getState();
  const server = state.servers.find((s) => s.id === serverId);
  if (!server) return;
  const masterPwd = state.masterPassword;
  if (!masterPwd) return;
  const cache = state.secretsCache[serverId] || {};

  let pwd: string | undefined = cache.password;
  let pem: string | undefined = cache.private_key_pem;

  // 解密密码（cache 空但有 cipher 时）
  if (typeof pwd === 'undefined' && server.password_cipher) {
    try {
      pwd = await decryptSecret(server.password_cipher, masterPwd);
    } catch {
      /* ignore decryption error，保持 undefined 后续由后端抛错 */
    }
  }
  // 解密私钥（cache 空但有 cipher 时）
  if (typeof pem === 'undefined' && server.private_key_cipher) {
    try {
      pem = await decryptSecret(server.private_key_cipher, masterPwd);
    } catch {
      /* ignore */
    }
  }
  // 如果有任一解密出了新值，写回 cache
  if (typeof pwd !== 'undefined' || typeof pem !== 'undefined') {
    state.setSecret(serverId, pwd, pem);
  }
}

/* 会话状态 -> 中文描述 */
export const statusLabel: Record<SessionStatus, string> = {
  Idle: '空闲',
  Connecting: '正在连接...',
  Connected: '已连接',
  Streaming: '实时流中',
  Disconnecting: '断开中...',
  Disconnected: '已断开',
  Error: '错误',
};
