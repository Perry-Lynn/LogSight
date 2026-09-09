/*
 * LogSight 应用主布局
 * 左侧服务器列表 + 右侧多标签日志查看器 + 顶部标题栏
 * 负责：初始化 master 密码、Tauri 事件监听（日志流推送/会话状态）、主题动态切换
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-27
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layout, Button, Tag, Tooltip, Dropdown, App as AntApp, Modal, ConfigProvider, theme as AntTheme, Switch } from 'antd';
import type { MenuProps } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {
  SettingOutlined,
  ImportOutlined,
  ExportOutlined,
  ReloadOutlined,
  DatabaseOutlined,
  SunOutlined,
  MoonOutlined,
  MenuFoldOutlined,
} from '@ant-design/icons';
import { listen } from '@tauri-apps/api/event';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import ServerListPanel from '@/components/ServerListPanel';
import ServerConnectionDialog from '@/components/ServerConnectionDialog';
import LogViewerTabs from '@/components/LogViewerTabs';
import type { ServerConfig, LogTab } from '@/types';
import {
  getOrCreateMasterPassword,
  listServers,
  decryptSecret,
  saveServer,
} from '@/services/tauriApi';
import { useAppStore } from '@/store/useAppStore';

dayjs.extend(relativeTime);

const { Header, Content } = Layout;

/**
 * LogSight 应用主布局组件类
 */
const AppInner: React.FC = () => {
  const { message } = AntApp.useApp();
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const servers = useAppStore((s) => s.servers);
  const setServers = useAppStore((s) => s.setServers);
  const addOrUpdateServer = useAppStore((s) => s.addOrUpdateServer);
  const setMasterPassword = useAppStore((s) => s.setMasterPassword);
  const setSecret = useAppStore((s) => s.setSecret);
  const secretsCache = useAppStore((s) => s.secretsCache);

  const dialogVisible = useAppStore((s) => s.connectionDialogVisible);
  const dialogEditingId = useAppStore((s) => s.connectionDialogEditingId);
  const openConnectionDialog = useAppStore((s) => s.openConnectionDialog);
  const closeConnectionDialog = useAppStore((s) => s.closeConnectionDialog);

  const tabs = useAppStore((s) => s.tabs);
  const activeTabKey = useAppStore((s) => s.activeTabKey);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const addTab = useAppStore((s) => s.addTab);
  const removeTab = useAppStore((s) => s.removeTab);
  const updateTab = useAppStore((s) => s.updateTab);
  const appendLinesToTab = useAppStore((s) => s.appendLinesToTab);
  const updateTabBySessionId = useAppStore((s) => s.updateTabBySessionId);

  const [siderCollapsed, setSiderCollapsed] = useState(() => {
    return localStorage.getItem('logsight:sider-collapsed') === '1';
  });
  const toggleSider = useCallback(() => {
    setSiderCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('logsight:sider-collapsed', next ? '1' : '0');
      return next;
    });
  }, []);

  const appMasterPwdRef = useRef<string | null>(null);
  const initializationStartedRef = useRef(false);

  /* 首次挂载：同步 document 的 dark/light class，避免刷新闪烁 */
  useEffect(() => {
    setTheme(theme);
  }, [setTheme, theme]);

  /** 初始化：获取 master + 拉取服务器列表 + 解密每个服务器的密码/私钥 */
  useEffect(() => {
    // React StrictMode 在开发环境会重复执行 effect，避免并发初始化同一个 sled 数据库。
    if (initializationStartedRef.current) return;
    initializationStartedRef.current = true;

    (async () => {
      try {
        const master = await getOrCreateMasterPassword();
        // 如果只是初始化过，返回"master-initialized"，需要重新 peek 真实值（MVP 模式）
        let real = master;
        if (master === 'master-initialized') {
          try {
            real = await (await import('@/services/tauriApi')).peekMasterPassword();
          } catch (_) { real = master; }
        }
        appMasterPwdRef.current = real;
        setMasterPassword(real);
        const list = await listServers();
        setServers(list);
        // 解密各服务器的密码/私钥缓存到内存
        for (const s of list) {
          try {
            if (s.password_cipher) {
              const pwd = await decryptSecret(s.password_cipher, real);
              setSecret(s.id, pwd);
            }
            if (s.private_key_cipher) {
              const pem = await decryptSecret(s.private_key_cipher, real);
              setSecret(s.id, undefined, pem);
            }
          } catch (_) { /* 解密失败不阻塞 */ }
        }
      } catch (e: any) {
        message.error(`初始化失败：${e?.message || '请检查 Rust 后端是否正常编译运行'}`);
      }
    })();
  }, [setMasterPassword, setServers, setSecret, message]);

  /** 注册 Tauri 事件：后端会话状态变化 + 日志行批量推送 */
  useEffect(() => {
    const unlistens: Array<() => void> = [];
    (async () => {
      const u1 = await listen('log-session-status', (e) => {
        const payload = e.payload as any;
        const { session_id, status, message: msg } = payload ?? {};
        if (!session_id) return;
        updateTabBySessionId(session_id, {
          status,
          last_message: msg ?? undefined,
        });
      });
      unlistens.push(() => u1());

      const u2 = await listen('log-lines', (e) => {
        const payload = e.payload as any;
        const { session_id, lines } = payload ?? {};
        if (!session_id || !Array.isArray(lines)) return;
        appendLinesToTab(session_id, lines);
      });
      unlistens.push(() => u2());

      const u3 = await listen('app-closing', () => {
        // 窗口关闭前：主动请求停止所有流式会话
        tabs.forEach(async (t) => {
          if (t.session_id) {
            try { await (await import('@/services/tauriApi')).stopTail(t.session_id); } catch (_) {}
          }
        });
      });
      unlistens.push(() => u3());
    })();
    return () => unlistens.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendLinesToTab, updateTabBySessionId]);

  /** 从服务器列表双击/菜单点击 "打开日志" -> 创建新标签页 */
  const handleOpenLog = useCallback(
    (server: ServerConfig) => {
      // 首次连接空白：remote_path = "", 路径输入框留空
      // 后续有历史记录时，LogViewerTabs.getState() 会从该服务器历史里取最新一条回填
      const tabKey = `tab_${server.id}_${Date.now()}`;
      const tab: LogTab = {
        key: tabKey,
        server_id: server.id,
        server_snapshot: server,
        remote_path: '',
        title: server.title,
        session_id: null,
        status: 'Idle',
        lines: [],
        total_lines: 0,
        last_message: '请输入或选择日志文件路径，然后点击 Tail -F 或 历史',
      };
      addTab(tab);
    },
    [addTab],
  );

  /** 连接对话框保存成功回调 */
  const handleServerSaved = useCallback(
    (s: ServerConfig) => {
      addOrUpdateServer(s);
      closeConnectionDialog();
    },
    [addOrUpdateServer, closeConnectionDialog],
  );

  /** 导出全部服务器配置（JSON，敏感字段保持密文） */
  const handleExportServers = () => {
    if (!servers.length) return message.warning('暂无服务器可导出');
    const blob = new Blob([JSON.stringify(servers, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logsight-servers_${dayjs().format('YYYYMMDD-HHmmss')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message.success(`已导出 ${servers.length} 台服务器配置（密文）`);
  };

  /** 导入服务器配置 JSON */
  const handleImportServers = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f || !appMasterPwdRef.current) return;
      try {
        const text = await f.text();
        const arr = JSON.parse(text) as ServerConfig[];
        if (!Array.isArray(arr)) throw new Error('文件格式错误');
        let ok = 0;
        for (const s of arr) {
          if (!s.id || !s.host) continue;
          addOrUpdateServer(s);
          // 尝试解密入缓存
          try {
            if (s.password_cipher) {
              const pwd = await decryptSecret(s.password_cipher, appMasterPwdRef.current);
              setSecret(s.id, pwd);
            }
            if (s.private_key_cipher) {
              const pem = await decryptSecret(s.private_key_cipher, appMasterPwdRef.current);
              setSecret(s.id, undefined, pem);
            }
          } catch (_) { /* ignore */ }
          ok++;
        }
        message.success(`成功导入 ${ok} 台服务器`);
      } catch (e: any) {
        message.error(e?.message || '导入失败');
      }
    };
    input.click();
  };

  /* 顶部工具栏菜单 */
  const toolsMenu: MenuProps = {
    items: [
      {
        key: 'import',
        icon: <ImportOutlined />,
        label: '导入服务器配置 (.json)',
        onClick: handleImportServers,
      },
      {
        key: 'export',
        icon: <ExportOutlined />,
        label: '导出全部服务器配置',
        onClick: handleExportServers,
      },
      { type: 'divider' },
      {
        key: 'reload',
        icon: <ReloadOutlined />,
        label: '重新加载服务器列表',
        onClick: async () => {
          try {
            const list = await listServers();
            setServers(list);
            message.success(`已加载 ${list.length} 台`);
          } catch (e: any) {
            message.error(e?.message);
          }
        },
      },
    ],
  };

  const totalRunningTabs = useMemo(
    () => tabs.filter((t) => t.status === 'Streaming' || t.status === 'Connected').length,
    [tabs],
  );

  return (
    <Layout className="logsight-root-layout h-screen w-screen overflow-hidden" style={{ backgroundColor: 'var(--ls-bg-base)', color: 'var(--ls-text-primary)' }}>
      {/* 顶部标题栏（Mac 风格：左部可拖拽，右部按钮） */}
      <Header
        className="mac-titlebar-drag flex items-center px-3 h-12 flex-shrink-0 border-b"
        style={{
          backgroundColor: 'var(--ls-bg-surface)',
          borderColor: 'var(--ls-border-l1)',
        }}
      >
        <div className="flex items-center gap-2.5">
          <div className="ls-logo-badge w-7 h-7 rounded-lg flex items-center justify-center text-white text-[12px] font-bold shadow-ls-glow-brand">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <line x1="7" y1="9" x2="17" y2="9" />
              <line x1="7" y1="13" x2="14" y2="13" />
              <line x1="7" y1="17" x2="12" y2="17" />
            </svg>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-[15px] font-semibold tracking-[0.01em]" style={{ color: 'var(--ls-text-primary)' }}>
              LogSight
            </div>
            <Tag color="processing" className="!text-[10px] !m-0 !py-0 !px-1.5 !h-4 flex items-center rounded-full">
              v{__APP_VERSION__}
            </Tag>
          </div>
          {totalRunningTabs > 0 && (
            <Tag color="success" className="!text-[10px] !m-0 !py-0 !px-1.5 !h-4 flex items-center rounded-full ml-1">
              {totalRunningTabs} 流会话中
            </Tag>
          )}
          {/* 侧边栏收起/展开按钮 */}
          <Tooltip title={siderCollapsed ? '展开侧边栏' : '收起侧边栏'}>
            <Button
              size="small"
              onClick={toggleSider}
              className="mac-titlebar-nd rounded-lg ml-1 sider-toggle-btn"
              icon={
                <span className="sider-toggle-icon" style={{ transform: siderCollapsed ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                  <MenuFoldOutlined />
                </span>
              }
            />
          </Tooltip>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2 mac-titlebar-nd">
          {/* 主题切换：精致胶囊按钮 */}
          <Tooltip title={theme === 'dark' ? '切到白天主题' : '切到夜间主题'}>
            <Button
              type="default"
              size="small"
              onClick={toggleTheme}
              className="flex items-center gap-1.5 rounded-lg ls-btn-theme-toggle"
              icon={
                theme === 'dark' ? (
                  <MoonOutlined style={{ color: 'var(--ls-brand-cyan)' }} />
                ) : (
                  <SunOutlined style={{ color: '#F59E0B' }} />
                )
              }
            >
              <span className="text-[11px]">{theme === 'dark' ? '夜间' : '白天'}</span>
            </Button>
          </Tooltip>
          <Tooltip title="新建服务器连接">
            <Button
              type="primary"
              size="small"
              icon={<DatabaseOutlined />}
              onClick={() => openConnectionDialog(null)}
              className="ls-btn-primary-glow rounded-lg"
            >
              新建连接
            </Button>
          </Tooltip>
          <Dropdown menu={toolsMenu} trigger={['click']} placement="bottomRight">
            <Button size="small" icon={<SettingOutlined />} className="rounded-lg" />
          </Dropdown>
        </div>
      </Header>

      <Layout hasSider className="h-full min-h-0 w-full overflow-hidden" style={{ flex: 1 }}>
        {/* 左侧服务器列表：用 wrapper div 控制宽度，CSS transition 实现平滑收起 */}
        <div
          className="sider-wrapper shrink-0 h-full overflow-hidden"
          style={{
            width: siderCollapsed ? 0 : 300,
            transition: 'width 0.2s cubic-bezier(.2,.8,.2,1)',
          }}
        >
          <div
            className="h-full border-r"
            style={{
              width: 300,
              backgroundColor: 'var(--ls-bg-sider)',
              borderColor: 'var(--ls-border-l1)',
            }}
          >
            <ServerListPanel onOpenLog={handleOpenLog} />
          </div>
        </div>

        {/* 右侧：多标签日志查看 */}
        <Content
          className="min-h-0 h-full w-full overflow-hidden"
          style={{ flex: 1, backgroundColor: 'var(--ls-bg-base)' }}
        >
          <LogViewerTabs
            tabs={tabs}
            activeKey={activeTabKey}
            onChange={setActiveTab}
            onRemove={removeTab}
          />
        </Content>
      </Layout>

      {/* 连接配置弹窗 */}
      <ServerConnectionDialog
        visible={dialogVisible}
        editingId={dialogEditingId}
        onCancel={closeConnectionDialog}
        onSaved={handleServerSaved}
      />
    </Layout>
  );
};

/**
 * 应用根组件：包装 AntD ConfigProvider（动态算法/色板） + AntApp
 * 移到 App.tsx 以订阅 zustand theme 状态实现实时切换
 * @Author: fu
 */
const App: React.FC = () => {
  const theme = useAppStore((s) => s.theme);

  const config = useMemo(() => {
    const isDark = theme === 'dark';
    /* ====== 双主题色板定义（与 index.css CSS 变量保持一致） ====== */
    const palette = isDark ? {
      /* 深色主题：偏蓝灰深色基底 + 翠绿品牌 */
      bgBase: '#0F1115', bgSurface: '#181A20', bgElevated: '#20242C',
      bgSider: '#14161B', bgOverlay: 'rgba(226,232,240,0.06)',
      textPrimary: '#F1F5F9', textSecondary: '#94A3B8', textTertiary: '#64748B',
      textQuaternary: 'rgba(241,245,249,0.25)',
      borderPrimary: 'rgba(226,232,240,0.08)', borderSecondary: 'rgba(226,232,240,0.14)',
      brand: '#34D399', brandHover: '#10B981', brandActive: '#059669',
      cyan: '#22D3EE', blue: '#60A5FA',
      success: '#34D399', warning: '#FBBF24', error: '#F87171', info: '#60A5FA',
      menuSelectedBg: 'rgba(52,211,153,0.12)', menuSelectedColor: '#34D399',
      menuHoverBg: 'rgba(226,232,240,0.05)',
      btnShadow: '0 0 12px 0 rgba(52,211,153,0.16)',
      inputFocusShadow: '0 0 0 2px rgba(52,211,153,0.18)',
      tagDefaultBg: 'rgba(52,211,153,0.12)', tagDefaultColor: '#34D399',
      tableHeaderBg: '#14161B', rowHoverBg: 'rgba(226,232,240,0.04)',
      treeBg: '#14161B', treeHoverBg: 'rgba(226,232,240,0.04)',
    } : {
      /* 浅色主题：清爽冷灰 + 深青碧品牌 */
      bgBase: '#F8FAFC', bgSurface: '#FFFFFF', bgElevated: '#FFFFFF',
      bgSider: '#F1F5F9', bgOverlay: 'rgba(15,23,42,0.03)',
      textPrimary: '#0F172A', textSecondary: '#475569', textTertiary: '#94A3B8',
      textQuaternary: 'rgba(15,23,42,0.25)',
      borderPrimary: 'rgba(15,23,42,0.08)', borderSecondary: 'rgba(15,23,42,0.12)',
      brand: '#0D9488', brandHover: '#0F766E', brandActive: '#115E59',
      cyan: '#0891B2', blue: '#2563EB',
      success: '#059669', warning: '#D97706', error: '#DC2626', info: '#2563EB',
      menuSelectedBg: 'rgba(13,148,136,0.10)', menuSelectedColor: '#0D9488',
      menuHoverBg: 'rgba(15,23,42,0.04)',
      btnShadow: '0 1px 3px rgba(13,148,136,0.24)',
      inputFocusShadow: '0 0 0 2px rgba(13,148,136,0.14)',
      tagDefaultBg: 'rgba(13,148,136,0.10)', tagDefaultColor: '#0D9488',
      tableHeaderBg: '#F8FAFC', rowHoverBg: 'rgba(15,23,42,0.03)',
      treeBg: '#FFFFFF', treeHoverBg: 'rgba(15,23,42,0.04)',
    };

    return {
      locale: zhCN,
      theme: {
        algorithm: isDark ? AntTheme.darkAlgorithm : AntTheme.defaultAlgorithm,
        token: {
          colorPrimary: palette.brand,
          colorSuccess: palette.success,
          colorInfo: palette.info,
          colorWarning: palette.warning,
          colorError: palette.error,
          colorLink: palette.cyan,
          colorBgLayout: palette.bgBase,
          colorBgContainer: palette.bgSurface,
          colorBgElevated: palette.bgElevated,
          colorBgSpotlight: palette.bgSurface,
          colorBgMask: 'rgba(0,0,0,0.5)',
          colorText: palette.textPrimary,
          colorTextSecondary: palette.textSecondary,
          colorTextTertiary: palette.textTertiary,
          colorTextQuaternary: palette.textQuaternary,
          colorBorder: palette.borderPrimary,
          colorBorderSecondary: palette.borderSecondary,
          borderRadius: 8,
          borderRadiusLG: 10,
          borderRadiusXS: 4,
          borderRadiusSM: 6,
          fontSize: 13,
          fontSizeSM: 12,
          fontSizeLG: 15,
          lineHeight: 1.5,
          controlHeight: 32,
          controlHeightSM: 26,
          controlHeightLG: 38,
          fontFamily:
            '"SF Pro Text", -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Helvetica, Segoe UI, Arial, sans-serif',
          fontFamilyCode:
            '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
          motionDurationMid: '0.16s',
          motionDurationFast: '0.10s',
          motionEaseOut: 'cubic-bezier(.2,.8,.2,1)',
        },
        components: {
          Layout: {
            headerBg: palette.bgSurface,
            bodyBg: palette.bgBase,
            siderBg: palette.bgSider,
            headerHeight: 48,
            headerPadding: '0 14px',
            triggerBg: 'transparent',
            headerBorderBottom: palette.borderSecondary,
            siderBorderRight: palette.borderSecondary,
          },
          Menu: isDark ? {
            darkItemBg: 'transparent',
            darkSubMenuItemBg: 'transparent',
            darkItemSelectedBg: palette.menuSelectedBg,
            darkItemSelectedColor: palette.menuSelectedColor,
            darkItemHoverBg: palette.menuHoverBg,
            darkItemColor: palette.textPrimary,
            darkItemDisabledColor: palette.textTertiary,
            darkSubMenuItemSelectedColor: palette.brand,
          } : {
            itemBg: 'transparent',
            subMenuItemBg: 'transparent',
            itemSelectedBg: palette.menuSelectedBg,
            itemSelectedColor: palette.menuSelectedColor,
            itemHoverBg: palette.menuHoverBg,
            itemColor: palette.textPrimary,
            itemDisabledColor: palette.textTertiary,
          },
          Tabs: {
            itemColor: palette.textTertiary,
            itemSelectedColor: palette.textPrimary,
            itemHoverColor: palette.textSecondary,
            inkBarColor: palette.brand,
            titleFontSize: 13,
            cardBg: palette.bgSurface,
            itemActiveColor: palette.brand,
            horizontalItemGutter: 14,
          },
          Button: {
            colorPrimary: palette.brand,
            colorPrimaryHover: palette.brandHover,
            colorPrimaryActive: palette.brandActive,
            primaryShadow: palette.btnShadow,
            borderRadiusLG: 8,
            defaultBg: palette.bgOverlay,
            defaultColor: palette.textSecondary,
            defaultBorderColor: palette.borderPrimary,
          },
          Input: {
            colorBorder: palette.borderPrimary,
            hoverBorderColor: palette.brand,
            activeBorderColor: palette.brand,
            activeShadow: palette.inputFocusShadow,
            colorBgContainer: palette.bgSurface,
          },
          Select: {
            colorBorder: palette.borderPrimary,
            hoverBorderColor: palette.brand,
            activeBorderColor: palette.brand,
            activeShadow: palette.inputFocusShadow,
            optionSelectedBg: palette.menuSelectedBg,
            colorBgContainer: palette.bgSurface,
          },
          Switch: {
            colorPrimary: palette.brand,
          },
          Modal: {
            headerBg: palette.bgElevated,
            contentBg: palette.bgElevated,
            titleColor: palette.textPrimary,
            headerBorderBottom: palette.borderSecondary,
            footerBorderTop: palette.borderSecondary,
          },
          Tag: {
            defaultBg: palette.tagDefaultBg,
            defaultColor: palette.tagDefaultColor,
          },
          Dropdown: {
            controlItemBgActive: palette.menuSelectedBg,
          },
          Tree: {
            colorBgContainer: palette.treeBg,
            nodeHoverBg: palette.treeHoverBg,
            nodeSelectedBg: palette.menuSelectedBg,
            directoryNodeSelectedBg: palette.menuSelectedBg,
            titleHeight: 28,
          },
          Table: {
            headerBg: palette.tableHeaderBg,
            rowHoverBg: palette.rowHoverBg,
          },
          /* 强制 Tooltip/Popover 背景色 + 文字色：V12.3 日间白底黑字 */
          Tooltip: isDark ? {
            colorBg: '#2A2D31',
            colorText: '#E8EAED',
            colorBorder: 'rgba(232,234,237,0.10)',
          } : {
            colorBg: '#FFFFFF',
            colorText: '#0F172A',
            colorBorder: 'rgba(15,23,42,0.12)',
          },
          Popover: isDark ? {
            colorBg: '#2A2D31',
            colorText: '#E8EAED',
            colorBgElevated: '#2A2D31',
          } : {
            colorBg: '#FFFFFF',
            colorText: '#1D2129',
            colorBgElevated: '#FFFFFF',
          },
        },
      },
    };
  }, [theme]);

  return (
    <ConfigProvider {...config}>
      <AntApp>
        <AppInner />
      </AntApp>
    </ConfigProvider>
  );
};

export default App;
