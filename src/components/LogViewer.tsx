/*
 * 日志查看器核心组件
 * 基于 react-window VariableSizeList 实现 10万+ 行的高效虚拟滚动渲染
 * 分列展示结构化字段：时间 / 级别 / traceId / logger / 消息
 * 异常堆栈等续行折叠进所属主行，点击展开
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-27
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { VariableSizeList as List } from 'react-window';
import dayjs from 'dayjs';
import type { SearchFilter, LogLevel } from '@/types';
import type { RenderRow } from '@/utils/logFilter';
import { parseLogTimestamp } from '@/utils/logTimestamp';
import {
  abbreviateLogger,
  shortTraceId,
  LEVEL_LABEL,
  LEVEL_TEXT,
} from '@/utils/logFormat';

interface Props {
  /** 已过滤并完成续行归并的渲染行 */
  rows: RenderRow[];
  /** 当前搜索过滤条件，用于关键字高亮 */
  filter: SearchFilter;
  /** 容器高度 px（自动铺满时由外层传 ref） */
  height?: number;
  /** 是否实时流模式（自动滚动到底部） */
  autoScroll?: boolean;
  /** 单日志行的估计高度，影响虚拟滚动性能 */
  estimatedRowHeight?: number;
  /** 日志正文字号（px） */
  fontSize?: number;
  /** 右键复制回调：(消息文本) => void */
  onCopy?: (text: string) => void;
  /** 各列宽度配置 */
  columnWidths?: Record<string, number>;
  /** 隐藏的列 ID 列表 */
  hiddenColumns?: string[];
}

const LEVEL_CSS: Record<LogLevel, string> = {
  Fatal: 'log-level-fatal',
  Error: 'log-level-error',
  Warn: 'log-level-warn',
  Info: 'log-level-info',
  Debug: 'log-level-debug',
  Trace: 'log-level-trace',
  Unknown: 'log-level-unknown',
};

/** 列定义 */
export interface ColumnDef {
  id: string;
  label: string;
  defaultWidth: number;
  minWidth: number;
  resizable: boolean;
}

export const LOG_COLUMNS: ColumnDef[] = [
  { id: 'line_no',   label: '行号',   defaultWidth: 56,  minWidth: 40,  resizable: true },
  { id: 'timestamp', label: '时间',   defaultWidth: 100, minWidth: 80,  resizable: true },
  { id: 'level',     label: '级别',   defaultWidth: 23,  minWidth: 23,  resizable: false },
  { id: 'trace_id',  label: 'Trace',  defaultWidth: 74,  minWidth: 50,  resizable: true },
  { id: 'logger',    label: 'Logger', defaultWidth: 190, minWidth: 80,  resizable: true },
  { id: 'message',   label: '消息',   defaultWidth: 0,   minWidth: 100, resizable: false },
];

/** 获取列的有效宽度：优先用户配置，否则用默认值 */
export function getEffectiveColumnWidths(
  customWidths: Record<string, number> | undefined,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const col of LOG_COLUMNS) {
    result[col.id] = customWidths?.[col.id] && customWidths[col.id] > 0
      ? customWidths[col.id]
      : col.defaultWidth;
  }
  return result;
}

/* 单行默认渲染高度（px），多行内容会在渲染后动态测量更新 */
const DEFAULT_ROW_H = 22;

/* 单次展开最多渲染的堆栈行数，避免超长堆栈拖垮渲染 */
const MAX_STACK_RENDER = 200;

/**
 * 日志虚拟滚动查看器组件
 * 将大数组渲染行按视口范围裁切渲染，避免长列表 DOM 爆炸
 */
const LogViewer: React.FC<Props> = ({
  rows,
  filter,
  height = 0,
  autoScroll = true,
  estimatedRowHeight,
  fontSize = 12.5,
  onCopy,
  columnWidths: customWidths,
  hiddenColumns = [],
}) => {
  const listRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowHeightCacheRef = useRef<Map<number, number>>(new Map());
  const colWidths = useMemo(() => getEffectiveColumnWidths(customWidths), [customWidths]);
  const hiddenSet = useMemo(() => new Set(hiddenColumns), [hiddenColumns]);
  // 安全模式：用 window.innerHeight - getBoundingClientRect().top 绝对算法
  // 不依赖任何父级 flex 高度链，彻底避免 AntD Tabs 结构冲突导致白屏
  const [h, setH] = useState<number>(height || 800);
  /* 已展开堆栈的行下标集合 */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const effectiveRowHeight = estimatedRowHeight ?? Math.max(DEFAULT_ROW_H, Math.ceil(fontSize * 1.7));

  /* 外层容器尺寸自适应：绝对安全算法 —— 直接用窗口高度减容器顶部距，不依赖父级 */
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      try {
        const rect = el.getBoundingClientRect();
        // 视口高度 - 日志容器顶部 - 底部预留 8px
        const computed = Math.max(400, window.innerHeight - Math.ceil(rect.top) - 8);
        // 如果 height prop > 0 优先用 height
        setH(height > 0 ? height : computed);
      } catch (_) {
        // 失败 fallback：直接拿窗口高度 - 顶部 300px，一定不会太小
        setH(Math.max(600, window.innerHeight - 320));
      }
    };

    update();
    // 监听窗口大小
    window.addEventListener('resize', update);
    // 监听容器自身（如果支持）
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(update);
      ro.observe(el);
    } catch (_) { /* 不支持就算了 */ }
    // 延迟 2 次更新（AntD Tab 切换动画 / 窗口打开 300ms / 700ms）
    const t = setTimeout(update, 280);
    const t2 = setTimeout(update, 750);
    const t3 = setTimeout(update, 1500);
    return () => {
      window.removeEventListener('resize', update);
      if (ro) ro.disconnect();
      clearTimeout(t);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [height]);

  /* 搜索正则（高亮用）—— 多个关键字用 | 合并，任一词命中即高亮 */
  const highlightReg = useMemo<RegExp | null>(() => {
    const terms = (filter.keyword ?? []).filter((t) => t.trim());
    if (terms.length === 0) return null;
    try {
      const flags = `${filter.case_insensitive ? 'i' : ''}g`;
      const patterns = terms.map((kw) =>
        filter.regex ? kw : kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      );
      return new RegExp(patterns.join('|'), flags);
    } catch (_) {
      return null;
    }
  }, [filter.keyword, filter.regex, filter.case_insensitive]);

  /**
   * 高亮关键字：将字符串按搜索正则切割，匹配段包上 .kw-highlight
   */
  const renderHighlighted = useCallback(
    (text: string): React.ReactNode => {
      if (!highlightReg) return text;
      highlightReg.lastIndex = 0;
      const parts: React.ReactNode[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      let i = 0;
      while ((m = highlightReg.exec(text)) !== null) {
        if (m.index > last) parts.push(text.slice(last, m.index));
        parts.push(
          <mark key={i++} className="kw-highlight">
            {m[0]}
          </mark>,
        );
        last = m.index + m[0].length;
        if (m[0].length === 0) highlightReg.lastIndex++; // 防止空匹配死循环
      }
      if (last < text.length) parts.push(text.slice(last));
      return parts.length ? parts : text;
    },
    [highlightReg],
  );

  /** 展开/收起某行的堆栈续行 */
  const toggleExpand = useCallback((idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
    // 行高变化：让虚拟列表立刻重新测量该行及之后的行
    requestAnimationFrame(() => {
      rowHeightCacheRef.current.delete(idx);
      listRef.current?.resetAfterIndex(idx, true);
      requestAnimationFrame(() => listRef.current?.resetAfterIndex(idx, true));
    });
  }, []);

  /** 数据顺序或字号改变后，旧的下标行高不再可信。 */
  useEffect(() => {
    rowHeightCacheRef.current.clear();
    listRef.current?.resetAfterIndex(0, true);
  }, [rows, fontSize]);

  /**
   * 在 ref 回调中直接测量行高，避免 ResizeObserver 闭包捕获旧 index。
   * 使用 requestAnimationFrame 确保 DOM 布局完成后再读取 scrollHeight。
   */
  const measureRow = useCallback((idx: number, el: HTMLDivElement | null) => {
    if (!el) return;
    // 用 rAF 确保浏览器已完成布局计算
    requestAnimationFrame(() => {
      const realH = Math.max(effectiveRowHeight, Math.ceil(el.scrollHeight + 4));
      if (rowHeightCacheRef.current.get(idx) === realH) return;
      rowHeightCacheRef.current.set(idx, realH);
      listRef.current?.resetAfterIndex(idx, false);
    });
  }, [effectiveRowHeight]);

  /** 倒序模式下新增日志自动回到顶部（最新日志位于第 1 行） */
  useEffect(() => {
    if (autoScroll && listRef.current && rows.length) {
      listRef.current.scrollToItem(0, 'start');
    }
  }, [rows.length, autoScroll]);

  /** 虚拟滚动行高读取器 */
  const getItemSize = useCallback(
    (index: number) => rowHeightCacheRef.current.get(index) ?? effectiveRowHeight,
    [effectiveRowHeight],
  );

  /** 单行渲染函数 */
  const Row: React.FC<{ index: number; style: React.CSSProperties }> = useCallback(
    ({ index, style }) => {
      const row = rows[index];
      if (!row) return null;
      const { line, children } = row;
      const messageText = line.message ?? line.raw;

      // 时间戳：优先用后端结构化解析结果，缺失时回退到前端文本解析
      const tsStr = (() => {
        if (line.timestamp_ms) return dayjs(line.timestamp_ms).format('HH:mm:ss.SSS');
        const real = parseLogTimestamp(line.raw);
        return real ? dayjs(real).format('HH:mm:ss.SSS') : '';
      })();

      const hasStack = children.length > 0;
      const rowOpen = expanded.has(index);
      // collapse_stacktrace 默认开启（折叠）；显式关闭时全部展开
      const stackOpen = filter.collapse_stacktrace === false || rowOpen;
      const showStack = hasStack && stackOpen;
      const stackShown = children.slice(0, MAX_STACK_RENDER);
      const stackTruncated = children.length - stackShown.length;

      const isEven = index % 2 === 0;
      return (
        <div
          className={`flex items-start px-2 border-b ${
            isEven ? 'bg-transparent' : 'bg-ls-bg-overlay/50'
          } hover:bg-ls-bg-hover`}
          style={{
            ...style,
            borderColor: 'var(--ls-border-l1)',
          }}
          onDoubleClick={() => hasStack && toggleExpand(index)}
          onContextMenu={(e) => {
            // 先捕获选中文本（preventDefault 在 Tauri WebView 中会清除选区）
            const sel = window.getSelection();
            const selectedText = sel?.toString() || '';
            e.preventDefault();
            e.stopPropagation();
            // 优先用选中文本，无选区则复制整行消息
            const textToCopy = selectedText || messageText;
            onCopy?.(textToCopy);
          }}
        >
          {/* 展开箭头：有堆栈续行时显示 */}
          <div className="shrink-0 pt-[2px]" style={{ width: 16 }}>
            {hasStack && (
              <button
                type="button"
                className="log-twisty"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleExpand(index);
                }}
                title={rowOpen ? '收起堆栈' : `展开 ${children.length} 行堆栈`}
              >
                {rowOpen ? '▼' : '▶'}
              </button>
            )}
          </div>

          {!hiddenSet.has('line_no') && (
            <div className="log-line-no shrink-0 pt-[2px]" style={{ width: colWidths.line_no }}>
              {line.line_no}
            </div>
          )}
          {!hiddenSet.has('timestamp') && tsStr && (
            <div className="log-line-ts shrink-0 pt-[2px]" style={{ width: colWidths.timestamp }}>
              {tsStr}
            </div>
          )}

          {/* 级别徽标 */}
          {!hiddenSet.has('level') && (
            <div className="shrink-0 pt-[3px]" style={{ width: colWidths.level }}>
              <span
                className={`log-level-badge ${line.level.toLowerCase()}`}
                title={LEVEL_TEXT[line.level]}
              >
                {LEVEL_LABEL[line.level]}
              </span>
            </div>
          )}

          {/* traceId 短码 */}
          {!hiddenSet.has('trace_id') && (
            <div
              className="log-trace shrink-0 pt-[3px]"
              style={{ width: colWidths.trace_id }}
              title={line.trace_id ? `traceId: ${line.trace_id}` : undefined}
            >
              {shortTraceId(line.trace_id)}
            </div>
          )}

          {/* logger 缩写 */}
          {!hiddenSet.has('logger') && (
            <div
              className="log-logger shrink-0 pt-[3px]"
              style={{ width: colWidths.logger }}
              title={line.logger ? `logger: ${line.logger}` : undefined}
            >
              {abbreviateLogger(line.logger)}
            </div>
          )}

          {/* 消息正文 + 折叠的堆栈 */}
          <div
            ref={(el) => measureRow(index, el)}
            className={`flex-1 log-line-text ${LEVEL_CSS[line.level]}`}
          >
            <span className="log-message-main">
              {renderHighlighted(messageText)}
            </span>
            {hasStack && !showStack && (
              <span
                className="log-stack-hint"
                onClick={() => toggleExpand(index)}
                title="点击展开完整堆栈"
              >
                +{children.length} 行堆栈
              </span>
            )}
            {showStack && (
              <div className="log-stack">
                {stackShown.map((c, i) => (
                  <div key={i}>{renderHighlighted(c.raw)}</div>
                ))}
                {stackTruncated > 0 && (
                  <div style={{ opacity: 0.7 }}>
                    ... 还有 {stackTruncated} 行未显示
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      );
    },
    [rows, renderHighlighted, expanded, filter.collapse_stacktrace, toggleExpand, measureRow, colWidths, hiddenSet],
  );

  /* 空状态提示 */
  if (rows.length === 0) {
    return (
      <div
        ref={containerRef}
        className="w-full h-full min-h-0 flex items-start justify-center pt-20 sm:pt-24 text-sm"
        style={{ color: 'var(--ls-text-tertiary)' }}
      >
        <div className="text-center space-y-2.5">
          <div className="text-[64px] opacity-25">📄</div>
          <div className="text-sm" style={{ color: 'var(--ls-text-secondary)' }}>
            暂无日志内容
          </div>
          <div className="text-[12px]" style={{ color: 'var(--ls-text-tertiary)' }}>
            启动实时流或加载历史日志后将展示在这里
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="logsight-log-viewport w-full h-full min-h-0 overflow-hidden"
      style={{ '--ls-log-font-size': `${fontSize}px` } as React.CSSProperties}
    >
      <List
        ref={listRef}
        height={h}
        itemCount={rows.length}
        itemSize={getItemSize}
        estimatedItemSize={effectiveRowHeight}
        width="100%"
        overscanCount={40}
      >
        {Row}
      </List>
    </div>
  );
};

export default LogViewer;
