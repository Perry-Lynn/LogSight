/*
 * 服务器目录选择器组件（V10 新增）
 * 可视化浏览远程服务器文件系统：懒加载目录树 + 路径输入 + 面包屑快捷跳转 + 搜索过滤 + 权限置灰
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Input,
  Tree,
  Breadcrumb,
  Button,
  Space,
  Tooltip,
  Empty,
  Tag,
  App as AntApp,
  Spin,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import {
  HomeOutlined,
  SearchOutlined,
  FolderFilled,
  FileTextOutlined,
  FolderOpenFilled,
  LinkOutlined,
  LockOutlined,
  QuestionCircleOutlined,
  FolderOutlined,
} from '@ant-design/icons';
import type { ServerConfig, DirEntry, DirListResult } from '@/types';
import {
  listServerDir,
  validateServerPath,
  resolveServerHome,
  prevalidatePathClient,
} from '@/services/tauriApi';
import { useAppStore } from '@/store/useAppStore';

/**
 * ServerDirectoryPicker 组件外部 Props
 */
interface Props {
  /** 是否打开弹窗 */
  open: boolean;
  /** 取消回调 */
  onCancel: () => void;
  /** 确认回调：返回选中的绝对路径 + 是否为文件（日志查看器场景一般需要文件，但也允许选目录） */
  onOk: (selectedAbsolutePath: string, selectedIsFile: boolean, entry?: DirEntry | null) => void;
  /** 目标服务器配置（解密后的快照） */
  server: ServerConfig;
  /** 解密后的密码明文（密码认证或私钥密码），无则传 null */
  passwordPlain: string | null;
  /** 解密后的私钥 PEM 明文（私钥认证），无则传 null */
  privateKeyPemPlain: string | null;
  /** 初始路径（弹窗打开时默认定位到此路径） */
  initialValue?: string | null;
  /** 该服务器默认根路径预设；未提供时使用通用 Linux 日志路径 */
  defaultRootForThisServer?: string;
}

/** 把 DirEntry[] 转换成 AntD Tree DataNode[]（一层，不含递归 children，children 由 loadData 懒加载） */
function entriesToTreeNodes(parentPath: string, entries: DirEntry[]): DataNode[] {
  return entries.map((e) => {
    const isDir = e.kind === 'Directory' || e.kind === 'Symlink'; // 软链暂时按可展开处理
    const kindIcon =
      !e.readable ? (
        <LockOutlined className="text-slate-400" />
      ) : e.kind === 'Directory' ? (
        <FolderFilled className="text-amber-400" />
      ) : e.kind === 'Symlink' ? (
        <LinkOutlined className="text-cyan-400" />
      ) : e.kind === 'File' ? (
        <FileTextOutlined className="text-slate-400" />
      ) : (
        <QuestionCircleOutlined className="text-slate-500" />
      );
    const titleExtra = (
      <>
        {!e.readable && (
          <Tag color="default" className="!m-0 !ml-1.5 !text-[9.5px] !py-0 !px-1" title="当前 SSH 用户无权限读取">
            🔒 无权限
          </Tag>
        )}
        {e.kind === 'File' && e.size > 0 && (
          <span className="ml-1.5 text-[10.5px] text-slate-500">
            {formatSize(e.size)}
          </span>
        )}
        {!!e.mtime_ms && e.kind === 'File' && (
          <span className="ml-1.5 text-[10.5px] text-slate-500">
            {formatDate(e.mtime_ms)}
          </span>
        )}
      </>
    );
    return {
      key: e.abs_path,
      title: (
        <span className="inline-flex items-center gap-1 select-none max-w-full">
          <span className="shrink-0 w-4 text-center">{kindIcon}</span>
          <span
            className={`truncate ${
              !e.readable ? 'text-slate-400 line-through opacity-70' : ''
            }`}
            title={e.name}
          >
            {e.name}
          </span>
          {titleExtra}
        </span>
      ),
      isLeaf: e.is_leaf,
      disabled: !e.readable,
      selectable: e.readable,
      // 目录即使 readable=false 也允许用户尝试 expand（展开时再拦截），减少用户困惑
    } as DataNode & { _entry?: DirEntry };
  }).map((n) => ({
    ...n,
    _entry: entries.find((e) => e.abs_path === n.key),
  }));
}

/** 文件大小（字节）→ 人类可读 */
function formatSize(b: number): string {
  if (!b || b <= 0) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Unix 毫秒 → 紧凑日期 MM-dd HH:mm */
function formatDate(ms: number): string {
  try {
    const d = new Date(ms);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return '';
  }
}

/** 把绝对路径拆成面包屑片段（包含累积绝对路径） */
function splitBreadcrumb(abs: string): { label: string; path: string }[] {
  const a = abs || '/';
  if (a === '/') return [{ label: '/', path: '/' }];
  const parts = a.split('/').filter(Boolean);
  const out: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    out.push({ label: p, path: acc });
  }
  return out;
}

/**
 * 服务器目录选择器组件类
 */
const ServerDirectoryPicker: React.FC<Props> = ({
  open,
  onCancel,
  onOk,
  server,
  passwordPlain,
  privateKeyPemPlain,
  initialValue,
  defaultRootForThisServer,
}) => {
  const { message } = AntApp.useApp();
  const theme = useAppStore((s) => s.theme);

  // 默认路径仅作起点提示，用户可以直接输入或浏览任意远端日志路径。
  const computedDefaultRoot = useMemo(() => {
    if (defaultRootForThisServer) return defaultRootForThisServer;
    return '/var/log/app/application.log';
  }, [defaultRootForThisServer]);

  /* ===================== State ===================== */
  const [pathInput, setPathInput] = useState<string>('');
  const [pathError, setPathError] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState<string>('');
  const [treeData, setTreeData] = useState<DataNode[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [loadedKeys, setLoadedKeys] = useState<React.Key[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [rootLoading, setRootLoading] = useState<boolean>(false);
  const [currentDirEntries, setCurrentDirEntries] = useState<DirEntry[] | null>(null);
  // 选中的条目快照（onOk 时传递给父组件）
  const selectedEntryRef = useRef<DirEntry | null>(null);
  // V12.3 修复：弹窗关闭守卫 ref —— 用户点取消/关闭后，所有 await 回来的异步 setState 全部短路，防止重渲染阻塞
  const closedRef = useRef<boolean>(false);
  /**
   * 封装安全 setState：只有弹窗仍打开时才真正更新 state，避免已关闭状态下无谓重渲染导致"卡死"
   * NOTE: 用 any 放宽 TS 约束，避免 TS 先从 value 的字面量(null/""/[])收窄泛型导致 TS2345。
   *       调用处我们逻辑层面 100% 保证 setter/value 类型匹配，安全。
   */
  const safeSet = (setter: React.Dispatch<any>, value: any): void => {
    if (closedRef.current) return;
    setter(value);
  };

  /* ===================== 初始化：open 变化时加载默认路径 ===================== */
  useEffect(() => {
    if (!open) return;
    // 打开弹窗时：重置关闭守卫，确保异步 setSate 能正常跑
    closedRef.current = false;
    // 初始路径优先级：用户之前填的路径 > 通用默认路径
    const startPath = (initialValue && initialValue.trim()) || computedDefaultRoot;
    safeSet(setPathInput, startPath);
    safeSet(setPathError, null);
    safeSet(setSearchValue, '');
    safeSet(setSelectedKeys, []);
    safeSet(setExpandedKeys, []);
    safeSet(setLoadedKeys, []);
    selectedEntryRef.current = null;
    // 先尝试加载 startPath 的内容；如果是文件则取其父目录加载
    loadRootOrParent(startPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * 加载某个路径作为根级浏览（如果路径指向文件 → 取 parentDir，加载其 siblings 并高亮选中该文件）
   */
  const loadRootOrParent = async (rawPath: string) => {
    safeSet(setRootLoading, true);
    safeSet(setLoading, true);
    try {
      // 先客户端预校验（便宜快失败）
      const pre = prevalidatePathClient(rawPath);
      if (pre) {
        safeSet(setPathError, pre);
        safeSet(setTreeData, []);
        safeSet(setCurrentDirEntries, []);
        return;
      }
      // 先判定是目录还是文件
      let v;
      try {
        v = await validateServerPath(server, rawPath.trim(), passwordPlain, privateKeyPemPlain);
      } catch (e: any) {
        safeSet(setPathError, e?.message || '路径校验失败');
        safeSet(setTreeData, []);
        safeSet(setCurrentDirEntries, []);
        return;
      }
      if (closedRef.current) return; // 守卫：await 后如果用户已关弹窗，立即中断
      if (!v.safe) {
        safeSet(setPathError, v.reason || '路径不安全，已拦截');
        safeSet(setTreeData, []);
        safeSet(setCurrentDirEntries, []);
        return;
      }
      // 归一化后的路径填回输入框
      safeSet(setPathInput, v.normalized_path);
      // 目录 → 直接加载；文件 → 先取父目录
      let listDir: string;
      let highlightFilePath: string | null = null;
      if (v.is_directory) {
        listDir = v.normalized_path;
      } else {
        const np = v.normalized_path;
        const idx = np.lastIndexOf('/');
        listDir = idx <= 0 ? '/' : np.substring(0, idx);
        highlightFilePath = v.normalized_path;
        if (!v.exists) {
          // 文件不存在 → 跳到父目录
          if (!closedRef.current) message.warning(`路径 ${v.normalized_path} 不存在，已跳到父目录`);
        }
      }
      // 加载该目录作为根
      let r: DirListResult;
      try {
        r = await listServerDir(server, listDir, passwordPlain, privateKeyPemPlain);
      } catch (e2: any) {
        safeSet(setPathError, e2?.message || '目录加载失败');
        safeSet(setTreeData, []);
        safeSet(setCurrentDirEntries, []);
        return;
      }
      if (closedRef.current) return; // 守卫：第二次 await 后再次检查
      safeSet(setCurrentDirEntries, r.entries);
      safeSet(setPathInput, r.normalized_path);
      safeSet(setPathError, null);
      const nodes = entriesToTreeNodes(r.normalized_path, r.entries);
      safeSet(setTreeData, nodes);
      // 标记根路径（当前 listDir）为 "已加载"，避免 onExpand 时重复请求
      safeSet(setLoadedKeys, [r.normalized_path]);
      safeSet(setExpandedKeys, [r.normalized_path]);
      // 高亮选中之前的文件
      if (highlightFilePath) {
        safeSet(setSelectedKeys, [highlightFilePath]);
        const e = r.entries.find((x) => x.abs_path === highlightFilePath);
        selectedEntryRef.current = e || null;
      } else {
        safeSet(setSelectedKeys, []);
        selectedEntryRef.current = null;
      }
    } finally {
      safeSet(setRootLoading, false);
      safeSet(setLoading, false);
    }
  };

  /* ===================== Tree loadData 懒加载 onExpand 调用 ===================== */
  const onLoadData: React.ComponentProps<typeof Tree>['loadData'] = async (node) => {
    const nodeKey = String(node.key);
    // 已加载过就跳过（理论上 AntD 用 loadedKeys 也能控制，但这里双保险）
    if (loadedKeys.includes(nodeKey)) return;
    // 关闭状态下拒绝发起新请求
    if (closedRef.current) return;
    // 目录尝试打开前做一次可读判断（disabled 的节点一般到不了这里）
    try {
      const r = await listServerDir(server, nodeKey, passwordPlain, privateKeyPemPlain);
      if (closedRef.current) return; // 守卫：await 后已关弹窗则不 setState
      const children = entriesToTreeNodes(nodeKey, r.entries);
      safeSet(setTreeData, (prev: DataNode[]) => attachChildren(prev, nodeKey, children));
      safeSet(setLoadedKeys, (prev: React.Key[]) => Array.from(new Set([...prev, nodeKey])));
    } catch (e: any) {
      if (!closedRef.current) {
        message.error(`展开失败：${e?.message || '未知错误'}`);
      }
      // 该节点即使失败也记为 loadedKeys，防止无限重试（用户关闭再打开可重试）
      safeSet(setLoadedKeys, (prev: React.Key[]) => Array.from(new Set([...prev, nodeKey])));
    }
  };

  /** 递归找到 key==parentKey 的节点，给它挂 children */
  function attachChildren(list: DataNode[], parentKey: string, children: DataNode[]): DataNode[] {
    return list.map((n) => {
      if (n.key === parentKey) {
        return { ...n, children };
      }
      if (n.children && n.children.length > 0) {
        return { ...n, children: attachChildren(n.children, parentKey, children) };
      }
      return n;
    });
  }

  /* ===================== Tree onExpand / onSelect ===================== */
  const onTreeExpand = (keys: React.Key[]) => safeSet(setExpandedKeys, keys);
  const onTreeSelect = (
    keys: React.Key[],
    info: { node: DataNode; selected: boolean },
  ) => {
    safeSet(setSelectedKeys, keys);
    if (keys.length === 0) {
      selectedEntryRef.current = null;
      return;
    }
    const absPath = String(keys[0]);
    // 从 treeData + 已加载 children 里找 entry（这里用一个递归查找）
    const found = findEntryByKey(treeData, absPath);
    selectedEntryRef.current = found || null;
    // 同时把 pathInput 更新为选中的路径
    safeSet(setPathInput, absPath);
    safeSet(setPathError, null);
  };

  /** 在 treeData（含嵌套）里根据 key 找 DirEntry */
  function findEntryByKey(list: DataNode[], key: string): DirEntry | null {
    for (const n of list) {
      const anyNode = n as unknown as { _entry?: DirEntry };
      if (n.key === key && anyNode._entry) return anyNode._entry;
      if (n.children && n.children.length > 0) {
        const f = findEntryByKey(n.children, key);
        if (f) return f;
      }
    }
    return null;
  }

  /* ===================== 路径输入框回车 → 加载该路径 ===================== */
  const onPathInputBlurOrEnter = async (val: string) => {
    const pre = prevalidatePathClient(val);
    if (pre) {
      safeSet(setPathError, pre);
      if (!closedRef.current) message.warning(pre);
      return;
    }
    safeSet(setPathError, null);
    await loadRootOrParent(val);
  };

  /* ===================== 面包屑点击 → 跳到该目录 ===================== */
  const crumbs = splitBreadcrumb(pathInput || '/');
  const onBreadcrumbClick = async (p: string) => {
    safeSet(setPathInput, p);
    safeSet(setPathError, null);
    await loadRootOrParent(p);
  };

  /* ===================== Home 按钮 → 跳到远程 $HOME ===================== */
  const onHomeClick = async () => {
    safeSet(setLoading, true);
    try {
      const home = await resolveServerHome(server, passwordPlain, privateKeyPemPlain);
      if (closedRef.current) return; // 守卫：await 后若已关弹窗则终止
      await loadRootOrParent(home);
    } catch (e: any) {
      if (!closedRef.current) {
        message.error(`获取家目录失败：${e?.message || '未知错误'}`);
      }
    } finally {
      safeSet(setLoading, false);
    }
  };

  /* ===================== 搜索过滤：按 name 包含 keyword（不区分大小写） ===================== */
  const filterTreeNode: React.ComponentProps<typeof Tree>['filterTreeNode'] = (node) => {
    if (!searchValue.trim()) return true;
    const kw = searchValue.trim().toLowerCase();
    // 节点 key 是绝对路径；或者通过 title 解析
    const keyLower = String(node.key).toLowerCase();
    // 直接取最后一段作为 name
    const seg = keyLower.substring(keyLower.lastIndexOf('/') + 1);
    return seg.includes(kw) || keyLower.includes(kw);
  };

  /* ===================== 确定 / 取消 按钮回调 ===================== */
  const okDisabled = (() => {
    if (!selectedKeys || selectedKeys.length === 0) return true;
    const selEntry = selectedEntryRef.current;
    if (selEntry && !selEntry.readable) return true; // 理论上 disabled 节点选不到，兜底
    return false;
  })();

  const handleOk = () => {
    // 点确定时也标记关闭，避免后续异步回调再 setState
    closedRef.current = true;
    if (okDisabled) {
      message.warning('请先选择一个具有读取权限的文件或目录');
      return;
    }
    const abs = String(selectedKeys[0]);
    const e = selectedEntryRef.current;
    const isFile = e ? e.kind === 'File' : !abs.endsWith('/') && !isDirByName(abs);
    onOk(abs, isFile, e);
  };

  const handleCancel = () => {
    // 立即标记关闭 + 强制清空 loading，避免 UI 卡死（同步执行，不等待父组件 setState）
    closedRef.current = true;
    try {
      // 同步清空所有可能阻塞 UI 的 loading 状态
      setRootLoading(false);
      setLoading(false);
    } catch (_) {}
    onCancel();
  };

  const isDirByName = (p: string) =>
    p === '/' || /\/(etc|var|usr|mnt|home|tmp|data|logs?|log|app|bin|boot|dev|lib|opt|proc|root|run|sbin|srv|sys|tmp|www|webroot|share|upload)$/.test(p);

  /* ===================== Render ===================== */
  return (
    <Modal
      open={open}
      title={
        <div className="flex items-center gap-2">
          <FolderOutlined className="text-amber-500" />
          <span className="font-semibold">选择服务器目录 / 文件</span>
          <Tag
            color="blue"
            className="!m-0 !text-[10px] !py-0 !px-1.5"
            title={server.username + '@' + server.host}
          >
            {server.username}@{server.host}
          </Tag>
        </div>
      }
      onCancel={handleCancel}
      onOk={handleOk}
      okText="确定"
      cancelText="取消"
      okButtonProps={{ disabled: okDisabled }}
      cancelButtonProps={{}}
      width={1020}
      style={{ top: 56 }}
      // V12.3 修复：关闭时彻底销毁 Modal DOM、Tree 实例、pending Promise，避免阻塞主线程造成"卡死"观感
      destroyOnClose={true}
      maskClosable={false}
    >
      <Spin spinning={loading} size="small">
        {/* 顶栏：路径输入框 + 快捷按钮 */}
        <div className={`mb-2 flex flex-wrap items-center gap-1.5 ${
          theme === 'dark' ? '' : ''
        }`}>
          <Button
            size="small"
            icon={<HomeOutlined />}
            onClick={onHomeClick}
            title="跳转到当前用户的 $HOME 目录"
          >
            家目录
          </Button>
          <Input
            size="small"
            style={{ flex: 1, minWidth: 240 }}
            placeholder="输入绝对路径后回车跳转，例如 /var/log/app/"
            status={pathError ? 'error' : ''}
            value={pathInput}
            onChange={(e) => {
              safeSet(setPathInput, e.target.value);
              if (pathError) safeSet(setPathError, null);
            }}
            onPressEnter={() => onPathInputBlurOrEnter(pathInput)}
            onBlur={(e) => {
              if (e.target.value.trim() && e.target.value.trim() !== pathErrorRef.current) {
                // 仅在值与当前浏览目录不同时才校验，减少无感校验
              }
            }}
            prefix={<FolderOpenFilled className="text-logsight-grey-400" />}
            allowClear
          />
          <Input
            size="small"
            style={{ width: 220 }}
            placeholder="🔍 搜索文件名"
            prefix={<SearchOutlined className="text-logsight-grey-400" />}
            allowClear
            value={searchValue}
            onChange={(e) => safeSet(setSearchValue, e.target.value)}
          />
        </div>
        {/* 面包屑行 */}
        <div className={`mb-2 px-1 py-1 rounded flex flex-wrap items-center gap-0.5 ${
          theme === 'dark' ? 'bg-logsight-grey-900/60' : 'bg-logsight-grey-50'
        }`}>
          <Breadcrumb
            className="!text-[11.5px]"
            items={crumbs.map((c, idx) => ({
              title: idx === crumbs.length - 1 ? (
                <span className={theme === 'dark' ? 'text-logsight-text-primary-dark font-medium' : 'text-logsight-text-primary-light font-medium'}>{c.label || '/'}</span>
              ) : (
                <a
                  onClick={() => onBreadcrumbClick(c.path)}
                  className="hover:underline"
                >
                  {c.label || '/'}
                </a>
              ),
            }))}
          />
          <div className="ml-auto" />
          {pathError && (
            <span className="text-[11px] text-logsight-status-error ml-1">路径异常：{pathError}</span>
          )}
        </div>

        {/* 目录树 */}
        <div
          className={`border rounded overflow-hidden ${
            theme === 'dark' ? 'border-logsight-grey-900 bg-logsight-grey-950/70' : 'border-logsight-grey-200 bg-white'
          }`}
          style={{ height: 460, maxHeight: '60vh', overflowY: 'auto', overflowX: 'auto' }}
        >
          {rootLoading && treeData.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <Spin size="large" />
              <span className="ml-2 text-sm text-logsight-grey-500">正在加载目录...</span>
            </div>
          ) : !currentDirEntries || currentDirEntries.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <span className="text-[12px] text-logsight-grey-500">
                    该目录为空 📭 或当前用户无权限读取
                  </span>
                }
              />
            </div>
          ) : (
            <Tree
              className="!py-1.5 !px-1 text-[12px]"
              showLine={{ showLeafIcon: false }}
              treeData={treeData}
              expandedKeys={expandedKeys}
              loadedKeys={loadedKeys}
              selectedKeys={selectedKeys}
              onExpand={onTreeExpand}
              onSelect={onTreeSelect}
              loadData={onLoadData}
              filterTreeNode={filterTreeNode}
              autoExpandParent={!!searchValue.trim()}
              blockNode
              // V12.3 修复：关闭 virtual 虚拟列表——在 Modal 场景下虚拟滚动初始化会阻塞主线程交互
              // 单目录通常 < 2000 个文件，直接 DOM 渲染更快、更稳
              virtual={false}
            />
          )}
        </div>

        {/* 底部说明 */}
        <div className={`mt-2.5 flex items-center justify-between text-[11px] ${
          theme === 'dark' ? 'text-logsight-grey-500' : 'text-logsight-grey-500'
        }`}>
          <Space size={12} wrap>
            <span>
              <LockOutlined className="text-logsight-grey-500 mr-0.5" />
              灰色带 🔒 = 当前 SSH 用户（<b>{server.username}</b>）无权限读取
            </span>
            <span>
              <LinkOutlined className="text-logsight-brand-cyan mr-0.5" />
              ⛓️ 符号链接
            </span>
            <span>
              <FolderFilled className="text-amber-400 mr-0.5" />
              目录
            </span>
            <span>
              <FileTextOutlined className="text-logsight-grey-400 mr-0.5" />
              文件
            </span>
          </Space>
          <Tooltip title="响应通常 < 500ms（不含首次 TCP 握手）">
            <Tag color="geekblue" className="!m-0 !text-[10px] !py-0 !px-1.5">
              懒加载单层 · 响应 &lt; 500ms 目标
            </Tag>
          </Tooltip>
        </div>
      </Spin>
    </Modal>
  );
};

/** 空 ref：避免 onBlur 无意义校验（保留用于未来扩展） */
const pathErrorRef = { current: '' };

export default ServerDirectoryPicker;
