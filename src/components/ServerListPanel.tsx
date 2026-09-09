/*
 * 左侧服务器列表面板
 * 展示书签分类、服务器列表、增删改查操作、右键快速打开日志
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-27
 */
import React, { useMemo, useState } from 'react';
import {
  Button,
  Input,
  Select,
  Empty,
  Dropdown,
  Modal,
  Tag,
  Tooltip,
  App as AntApp,
} from 'antd';
import {
  PlusOutlined,
  SearchOutlined,
  EditOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  FolderOpenOutlined,
  MoreOutlined,
  CloudServerOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type { MenuProps } from 'antd';
import type { ServerConfig } from '@/types';
import { deleteServer } from '@/services/tauriApi';
import { useAppStore } from '@/store/useAppStore';

interface Props {
  /** 点击"打开日志"回调：(server, defaultLogPath?) => void */
  onOpenLog: (server: ServerConfig) => void;
}

/**
 * 服务器列表面板组件类
 * 展示书签分类、搜索框、服务器卡片列表，支持增删改查+右键菜单
 */
const ServerListPanel: React.FC<Props> = ({ onOpenLog }) => {
  const { message, modal } = AntApp.useApp();
  const servers = useAppStore((s) => s.servers);
  const removeServer = useAppStore((s) => s.removeServer);
  const openConnectionDialog = useAppStore((s) => s.openConnectionDialog);

  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState<string | undefined>(undefined);

  /** 书签分类下拉选项（去重，支持逗号分隔的多分类） */
  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    servers.forEach((s) => {
      if (s.bookmark_category) {
        s.bookmark_category.split(',').forEach((c) => set.add(c.trim()));
      }
    });
    return Array.from(set).map((v) => ({ label: v, value: v }));
  }, [servers]);

  /** 过滤后的服务器列表 */
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return servers.filter((s) => {
      if (category && !s.bookmark_category?.split(',').map((c) => c.trim()).includes(category)) return false;
      if (!kw) return true;
      return (
        s.title.toLowerCase().includes(kw) ||
        s.host.toLowerCase().includes(kw) ||
        s.username.toLowerCase().includes(kw) ||
        (s.description || '').toLowerCase().includes(kw)
      );
    });
  }, [servers, keyword, category]);

  /** 删除确认 */
  const handleDelete = (s: ServerConfig) => {
    modal.confirm({
      title: '确认删除该服务器连接？',
      content: `${s.title}（${s.username}@${s.host}:${s.port}），删除后无法恢复。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        const ok = await deleteServer(s.id);
        if (ok) {
          removeServer(s.id);
          message.success('已删除');
        }
      },
    });
  };

  /** 构造右键菜单 */
  const menuOf = (s: ServerConfig): MenuProps['items'] => [
    {
      key: 'open',
      icon: <PlayCircleOutlined />,
      label: '打开实时日志（Tail -f）',
      onClick: () => onOpenLog(s),
    },
    {
      key: 'edit',
      icon: <EditOutlined />,
      label: '编辑配置',
      onClick: () => openConnectionDialog(s.id),
    },
    { type: 'divider' },
    {
      key: 'delete',
      danger: true,
      icon: <DeleteOutlined />,
      label: '删除服务器',
      onClick: () => handleDelete(s),
    },
  ];

  return (
    <div className="h-full flex flex-col min-h-0 bg-ls-bg-sider">
      {/* ===== 顶部工具栏 ===== */}
      <div
        className="p-3 space-y-3 border-b"
        style={{ borderColor: 'var(--ls-border-l1)' }}
      >
        <div className="flex gap-2 items-center">
          <div className="flex-1 flex items-center gap-2">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: 'var(--ls-bg-overlay)' }}
            >
              <CloudServerOutlined
                className="text-[15px]"
                style={{ color: 'var(--ls-brand-cyan)' }}
              />
            </div>
            <span
              className="font-semibold text-sm"
              style={{ color: 'var(--ls-text-primary)' }}
            >
              服务器列表
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Tooltip title="新建服务器连接">
              <Button
                type="primary"
                size="small"
                icon={<PlusOutlined />}
                onClick={() => openConnectionDialog(null)}
                className="mac-titlebar-nd rounded-lg ls-btn-primary-glow"
              >
                新建
              </Button>
            </Tooltip>
          </div>
        </div>
        <div className="space-y-2">
          <Select
            allowClear
            placeholder="书签分类（全部）"
            size="small"
            style={{ width: '100%' }}
            value={category}
            onChange={(v) => setCategory(v)}
            options={categoryOptions}
          />
          <Input
            size="small"
            placeholder="搜索标题/主机/用户名..."
            prefix={<SearchOutlined style={{ color: 'var(--ls-text-tertiary)' }} />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            allowClear
          />
        </div>
      </div>

      {/* ===== 服务器列表 ===== */}
      <div className="flex-1 overflow-y-auto min-h-0 py-2 px-2">
        {filtered.length === 0 ? (
          <div className="px-2 py-10">
            <Empty
              description={
                <span style={{ color: 'var(--ls-text-tertiary)' }} className="text-xs">
                  {servers.length === 0 ? '暂无服务器，点右上角新建 →' : '无匹配的服务器'}
                </span>
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
            {servers.length === 0 && (
              <div className="mt-4 text-center">
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => openConnectionDialog(null)}
                  className="mac-titlebar-nd rounded-lg ls-btn-primary-glow"
                >
                  添加第一台服务器
                </Button>
              </div>
            )}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {filtered.map((s) => (
              <li
                key={s.id}
                className="group rounded-lg px-3 py-2.5 cursor-pointer transition-all border border-transparent ls-card-hover"
                style={{
                  backgroundColor: 'var(--ls-bg-surface)',
                }}
                onDoubleClick={() => onOpenLog(s)}
              >
                <div className="flex items-start gap-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-sm font-medium truncate"
                        style={{ color: 'var(--ls-text-primary)' }}
                      >
                        {s.title || '(未命名)'}
                      </span>
                      {s.bookmark_category &&
                        s.bookmark_category.split(',').map((c) => c.trim()).filter(Boolean).map((c) => (
                          <Tag
                            key={c}
                            className="!text-[10px] !py-0 !px-1.5 !h-4 flex items-center !m-0 rounded-full"
                            style={{
                              backgroundColor: 'var(--ls-bg-overlay)',
                              color: 'var(--ls-text-secondary)',
                              borderColor: 'var(--ls-border-l1)',
                            }}
                          >
                            {c}
                          </Tag>
                        ))}
                    </div>
                    <div
                      className="text-[11.5px] mt-1.5 font-mono truncate"
                      style={{ color: 'var(--ls-text-secondary)' }}
                    >
                      {s.username}@{s.host}:{s.port}
                    </div>
                    {s.last_connected_at ? (
                      <div
                        className="text-[10.5px] mt-1"
                        style={{ color: 'var(--ls-text-tertiary)' }}
                      >
                        最近连接 {dayjs(s.last_connected_at).fromNow()}
                      </div>
                    ) : null}
                  </div>
                  <div
                    className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color: 'var(--ls-text-secondary)' }}
                  >
                    <Tooltip title="打开日志">
                      <Button
                        type="text"
                        size="small"
                        className="!p-1 !h-7 mac-titlebar-nd rounded-md"
                        icon={<FolderOpenOutlined style={{ color: 'var(--ls-brand-cyan)' }} />}
                        onClick={() => onOpenLog(s)}
                      />
                    </Tooltip>
                    <Tooltip title="编辑">
                      <Button
                        type="text"
                        size="small"
                        className="!p-1 !h-7 mac-titlebar-nd rounded-md"
                        icon={<EditOutlined style={{ color: 'var(--ls-text-secondary)' }} />}
                        onClick={() => openConnectionDialog(s.id)}
                      />
                    </Tooltip>
                    <Dropdown
                      menu={{ items: menuOf(s) }}
                      trigger={['click']}
                      placement="bottomRight"
                    >
                      <Button
                        type="text"
                        size="small"
                        className="!p-1 !h-7 mac-titlebar-nd rounded-md"
                        icon={<MoreOutlined style={{ color: 'var(--ls-text-tertiary)' }} />}
                      />
                    </Dropdown>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default ServerListPanel;
