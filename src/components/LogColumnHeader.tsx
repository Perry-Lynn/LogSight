/*
 * 日志列头组件
 * 固定在日志区域顶部，支持拖拽调整列宽和显示/隐藏列
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-09-03
 */
import React, { useCallback, useRef, useState } from 'react';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { SettingOutlined, CheckOutlined } from '@ant-design/icons';
import { LOG_COLUMNS, type ColumnDef } from './LogViewer';

interface Props {
  columnWidths: Record<string, number>;
  hiddenColumns: string[];
  onColumnWidthChange: (id: string, width: number) => void;
  onColumnVisibilityChange: (hiddenColumns: string[]) => void;
}

const LogColumnHeader: React.FC<Props> = ({
  columnWidths,
  hiddenColumns,
  onColumnWidthChange,
  onColumnVisibilityChange,
}) => {
  const hiddenSet = new Set(hiddenColumns);
  const [dragging, setDragging] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; width: number }>({ x: 0, width: 0 });

  const handleMouseDown = useCallback(
    (col: ColumnDef, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = columnWidths[col.id] || col.defaultWidth;
      dragStartRef.current = { x: startX, width: startWidth };
      setDragging(col.id);

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - dragStartRef.current.x;
        const newWidth = Math.max(col.minWidth, dragStartRef.current.width + delta);
        onColumnWidthChange(col.id, newWidth);
      };

      const onMouseUp = () => {
        setDragging(null);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [columnWidths, onColumnWidthChange],
  );

  const menuItems: MenuProps['items'] = LOG_COLUMNS.map((col) => ({
    key: col.id,
    label: (
      <span className="flex items-center gap-2">
        <CheckOutlined
          style={{
            fontSize: 10,
            opacity: hiddenSet.has(col.id) ? 0 : 1,
            color: 'var(--ls-brand)',
          }}
        />
        {col.label}
      </span>
    ),
  }));

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    const colId = key;
    if (hiddenSet.has(colId)) {
      onColumnVisibilityChange(hiddenColumns.filter((id) => id !== colId));
    } else {
      const visibleAfter = LOG_COLUMNS.filter(
        (c) => !hiddenSet.has(c.id) && c.id !== colId,
      );
      if (visibleAfter.length === 0) return;
      onColumnVisibilityChange([...hiddenColumns, colId]);
    }
  };

  return (
    <div
      className="log-column-header flex items-center px-2 shrink-0"
      style={{
        height: 28,
        borderBottom: '1px solid var(--ls-border-l1)',
        background: 'var(--ls-bg-surface)',
        cursor: dragging ? 'col-resize' : undefined,
        userSelect: 'none',
      }}
    >
      {/* 箭头占位 */}
      <div className="shrink-0" style={{ width: 16 }} />

      {LOG_COLUMNS.map((col) => {
        if (hiddenSet.has(col.id)) return null;

        const isMessage = col.id === 'message';
        const width = columnWidths[col.id] || col.defaultWidth;

        return (
          <div
            key={col.id}
            className={`shrink-0 flex items-center log-col-label ${isMessage ? 'flex-1' : ''}`}
            style={isMessage ? undefined : { width }}
          >
            <span className="log-col-label-text">{col.label}</span>
            {col.resizable && (
              <div
                className="col-resize-handle"
                onMouseDown={(e) => handleMouseDown(col, e)}
                title="拖拽调整列宽"
              />
            )}
          </div>
        );
      })}

      {/* 列设置按钮 */}
      <Dropdown
        menu={{ items: menuItems, onClick: handleMenuClick }}
        trigger={['click']}
        placement="bottomRight"
      >
        <button
          type="button"
          className="log-col-settings-btn shrink-0"
          title="显示/隐藏列"
        >
          <SettingOutlined />
        </button>
      </Dropdown>
    </div>
  );
};

export default LogColumnHeader;
