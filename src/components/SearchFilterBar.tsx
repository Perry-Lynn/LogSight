/*
 * 日志搜索过滤工具栏
 * 关键字输入 + 正则/忽略大小写开关 + 日志级别多选 + 时间范围快捷按钮/自定义 + 操作按钮
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-27
 */
import React from 'react';
import {
  Input,
  Button,
  Checkbox,
  Tooltip,
  Tag,
  App as AntApp,
  Switch,
  Popover,
  DatePicker,
  Select,
} from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import {
  SearchOutlined,
  ReloadOutlined,
  DownloadOutlined,
  FilterOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  FontSizeOutlined,
  MinusOutlined,
  PlusOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import type { SearchFilter, LogLevel, LogSourceKey } from '@/types';

const { RangePicker } = DatePicker;

interface Props {
  filter: SearchFilter;
  onChange: (patch: Partial<SearchFilter>) => void;
  onReset: () => void;
  /** 服务端搜索（ssh grep） */
  onSearchRemote?: (kw: string, excludeKw: string, regex: boolean, case_i: boolean) => Promise<void> | void;
  /** 时间范围被应用/清除时回调（start/end 为 null 表示清除） */
  onApplyTimeRange?: (startMs: number | null, endMs: number | null) => void;
  onExport?: () => void;
  onReloadHistory?: () => void;
  totalCount?: number;
  matchedCount?: number;
  autoScroll?: boolean;
  onAutoScrollChange?: (v: boolean) => void;
  logFontSize?: number;
  onLogFontSizeChange?: (size: number) => void;
  /** Logback 结构化字段候选 */
  loggerFacets?: Array<{ key: string; count: number }>;
  threadFacets?: Array<{ key: string; count: number }>;
  sourceFacets?: Array<{ key: LogSourceKey; count: number }>;
  traceIds?: string[];
  /** 被“折叠刷屏”隐藏的日志行数 */
  collapsedNoisy?: number;
  /** 在远端滚动文件中按 traceId 精确追踪 */
  onTraceRemote?: (traceId: string) => Promise<void> | void;
}

const LEVELS: Array<{ v: LogLevel; label: string; color: string }> = [
  { v: 'Fatal', label: 'FATAL', color: 'red' },
  { v: 'Error', label: 'ERROR', color: 'volcano' },
  { v: 'Warn', label: 'WARN', color: 'gold' },
  { v: 'Info', label: 'INFO', color: 'blue' },
  { v: 'Debug', label: 'DEBUG', color: 'default' },
  { v: 'Trace', label: 'TRACE', color: 'purple' },
];

/** 快捷时间范围预设：[标签, 相对于现在的前向分钟数] */
const TIME_PRESETS: Array<{ label: string; minutes: number | 'today' | 'clear' }> = [
  { label: '15分', minutes: 15 },
  { label: '1时', minutes: 60 },
  { label: '6时', minutes: 360 },
  { label: '24时', minutes: 1440 },
  { label: '今日', minutes: 'today' },
  { label: '清空', minutes: 'clear' },
];

/**
 * 日志搜索过滤工具栏组件类
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-27
 */
const SearchFilterBar: React.FC<Props> = ({
  filter,
  onChange,
  onReset,
  onSearchRemote,
  onApplyTimeRange,
  onExport,
  onReloadHistory,
  totalCount = 0,
  matchedCount,
  autoScroll = true,
  onAutoScrollChange,
  logFontSize = 12.5,
  onLogFontSizeChange,
  loggerFacets = [],
  threadFacets = [],
  sourceFacets = [],
  traceIds = [],
  collapsedNoisy = 0,
  onTraceRemote,
}) => {
  const { message } = AntApp.useApp();
  const [inputKw, setInputKw] = React.useState('');
  const [excludeInput, setExcludeInput] = React.useState('');
  const [customOpen, setCustomOpen] = React.useState(false);
  const [customRange, setCustomRange] = React.useState<
    [Dayjs | null, Dayjs | null] | null
  >(null);

  /* 辅助：拼接当前 keyword 数组为空格分隔字符串（供远端 grep） */
  const joinKw = (arr: string[]) => arr.filter(Boolean).join(' ');

  /* 辅助：触发远端搜索 */
  const triggerRemoteSearch = async (kwArr: string[], exArr: string[]) => {
    if (!onSearchRemote) return;
    const kw = joinKw(kwArr);
    const ex = joinKw(exArr);
    try {
      await onSearchRemote(kw, ex, filter.regex, filter.case_insensitive);
    } catch (e: any) {
      message.error(e?.message || '搜索失败');
    }
  };

  /* 添加搜索关键字：按 Enter 把输入内容作为一个搜索条件加入列表，并自动触发搜索 */
  const handleAddKeyword = async () => {
    const term = inputKw.trim();
    if (!term) return;
    const current = filter.keyword ?? [];
    if (current.includes(term)) {
      setInputKw('');
      return;
    }
    const newKw = [...current, term];
    onChange({ keyword: newKw });
    setInputKw('');
    await triggerRemoteSearch(newKw, filter.keyword_exclude ?? []);
  };

  /* 移除某个搜索关键字，并自动重新搜索 */
  const handleRemoveKeyword = async (term: string) => {
    const current = filter.keyword ?? [];
    const newKw = current.filter((t) => t !== term);
    onChange({ keyword: newKw });
    await triggerRemoteSearch(newKw, filter.keyword_exclude ?? []);
  };

  /* 添加排除关键字：按 Enter 把输入内容作为一个排除条件加入列表，并自动触发搜索 */
  const handleAddExclude = async () => {
    const term = excludeInput.trim();
    if (!term) return;
    const current = filter.keyword_exclude ?? [];
    if (current.includes(term)) {
      setExcludeInput('');
      return;
    }
    const newExclude = [...current, term];
    onChange({ keyword_exclude: newExclude });
    setExcludeInput('');
    await triggerRemoteSearch(filter.keyword ?? [], newExclude);
  };

  /* 移除某个排除条件，并自动重新搜索 */
  const handleRemoveExclude = async (term: string) => {
    const current = filter.keyword_exclude ?? [];
    const newExclude = current.filter((t) => t !== term);
    onChange({ keyword_exclude: newExclude });
    await triggerRemoteSearch(filter.keyword ?? [], newExclude);
  };

  const handleSearchRemote = async () => {
    if (!onSearchRemote) return;
    const kw = joinKw(filter.keyword ?? []);
    const excludeKw = joinKw(filter.keyword_exclude ?? []);
    if (!kw && !excludeKw) {
      message.warning('请输入要搜索的关键字');
      return;
    }
    try {
      await onSearchRemote(kw, excludeKw, filter.regex, filter.case_insensitive);
    } catch (e: any) {
      message.error(e?.message || '搜索失败');
    }
  };

  /* 点击快捷时间按钮 */
  const applyTimePreset = (p: (typeof TIME_PRESETS)[number]) => {
    if (p.minutes === 'clear') {
      onChange({ time_start_ms: null, time_end_ms: null });
      onApplyTimeRange?.(null, null);
      return;
    }
    const now = Date.now();
    if (p.minutes === 'today') {
      const start = dayjs().startOf('day').valueOf();
      onChange({ time_start_ms: start, time_end_ms: now });
      onApplyTimeRange?.(start, now);
    } else {
      const start = now - p.minutes * 60 * 1000;
      onChange({ time_start_ms: start, time_end_ms: now });
      onApplyTimeRange?.(start, now);
    }
  };

  const openCustomRange = (open: boolean) => {
    setCustomOpen(open);
    if (open) {
      setCustomRange(
        filter.time_start_ms && filter.time_end_ms
          ? [dayjs(filter.time_start_ms), dayjs(filter.time_end_ms)]
          : null,
      );
    }
  };

  /* 自定义时间只在点击“应用”后写入过滤条件，避免选择过程中自动跳回当前时间 */
  const applyCustomRange = () => {
    const start = customRange?.[0];
    const end = customRange?.[1];
    if (!start || !end) {
      message.warning('请选择完整的开始和结束时间');
      return;
    }
    if (end.valueOf() < start.valueOf()) {
      message.warning('结束时间不能早于开始时间');
      return;
    }
    onChange({ time_start_ms: start.valueOf(), time_end_ms: end.valueOf() });
    onApplyTimeRange?.(start.valueOf(), end.valueOf());
    setCustomOpen(false);
  };

  /* 已选时间范围的当前展示 Tag（只展示，点 × 清除 */
  const TimeRangeBadge: React.ReactNode = (() => {
    const s = filter.time_start_ms;
    const e = filter.time_end_ms;
    if (!s && !e) return null;
    // 始终展示日期，避免“今天 01 点”被误解为“任意日期的 01 点”。
    const fmt = (t: number) => dayjs(t).format('YYYY-MM-DD HH:mm:ss');
    let label = (() => {
      if (s && e) return `${fmt(s)} ~ ${fmt(e)}`;
      if (s) return `≥ ${fmt(s)}`;
      return `≤ ${fmt(e ?? 0)}`;
    })();
    return (
      <Tag
      closable
      onClose={(e) => {
        e.preventDefault();
        onChange({ time_start_ms: null, time_end_ms: null });
        onApplyTimeRange?.(null, null);
      }}
      color="blue"
      className="!text-[10.5px] !py-0 !px-1.5 !m-0 rounded-full"
    >
      <ClockCircleOutlined className="mr-0.5" />
      {label}
    </Tag>
    );
  })();

  const hasTimeFilter = !!(filter.time_start_ms || filter.time_end_ms);

  return (
    <div
      className="flex items-center gap-1.5 flex-wrap px-2.5 py-1.5 border-b"
      style={{
        borderColor: 'var(--ls-border-l1)',
        backgroundColor: 'var(--ls-bg-surface)',
      }}
    >
      {/* 左侧：搜索框 + 搜索标签 + 排除输入 + 排除标签 */}
      <Input
        size="small"
        style={{ width: 220, minWidth: 160 }}
        placeholder="搜索关键字，回车添加"
        prefix={<SearchOutlined style={{ color: 'var(--ls-text-tertiary)' }} />}
        allowClear
        value={inputKw}
        onChange={(e) => setInputKw(e.target.value)}
        onPressEnter={handleAddKeyword}
        className="mac-titlebar-nd rounded-lg"
      />
      {(filter.keyword ?? []).map((term) => (
        <Tag
          key={term}
          closable
          onClose={() => handleRemoveKeyword(term)}
          color="blue"
          className="!text-[10px] !py-0 !px-1.5 !m-0 rounded-full"
        >
          {term}
          {typeof matchedCount === 'number' && (filter.keyword ?? []).length === 1 && (
            <span className="ml-0.5 opacity-70">{matchedCount}</span>
          )}
        </Tag>
      ))}
      {/* 排除关键字：独立输入 + 标签 */}
      <Input
        size="small"
        style={{ width: 220, minWidth: 160 }}
        placeholder="排除关键字，回车添加"
        prefix={<MinusCircleOutlined style={{ color: 'var(--ls-text-tertiary)' }} />}
        value={excludeInput}
        onChange={(e) => setExcludeInput(e.target.value)}
        onPressEnter={handleAddExclude}
        className="mac-titlebar-nd rounded-lg"
        allowClear
      />
      {(filter.keyword_exclude ?? []).map((term) => (
        <Tag
          key={term}
          closable
          onClose={() => handleRemoveExclude(term)}
          color="red"
          className="!text-[10px] !py-0 !px-1.5 !m-0 rounded-full"
        >
          -{term}
        </Tag>
      ))}
      <Tooltip title="正则匹配模式">
        <Tag.CheckableTag
          checked={filter.regex}
          onChange={(c) => onChange({ regex: c })}
          className="!text-[11px] !px-1.5 !py-0"
          style={{
            borderColor: 'var(--ls-border-l2)',
            color: filter.regex ? 'var(--ls-text-inverse)' : 'var(--ls-text-secondary)',
            backgroundColor: filter.regex ? 'var(--ls-brand)' : 'var(--ls-bg-overlay)',
          }}
        >
          .*正则
        </Tag.CheckableTag>
      </Tooltip>
      <Tooltip title="忽略大小写">
        <Tag.CheckableTag
          checked={filter.case_insensitive}
          onChange={(c) => onChange({ case_insensitive: c })}
          className="!text-[11px] !px-1.5 !py-0"
          style={{
            borderColor: 'var(--ls-border-l2)',
            color: filter.case_insensitive ? 'var(--ls-text-inverse)' : 'var(--ls-text-secondary)',
            backgroundColor: filter.case_insensitive ? 'var(--ls-brand)' : 'var(--ls-bg-overlay)',
          }}
        >
          Aa
        </Tag.CheckableTag>
      </Tooltip>

      {/* 级别过滤 */}
      <div className="flex items-center gap-1 text-[10.5px] ml-1" style={{ color: 'var(--ls-text-tertiary)' }}>
        <FilterOutlined />
        <span>级别</span>
      </div>
      <Checkbox.Group
        value={filter.levels}
        onChange={(arr) => onChange({ levels: arr as LogLevel[] })}
        className="flex flex-wrap gap-x-2 gap-y-0 items-center"
      >
        {LEVELS.map((L) => (
          <Checkbox key={L.v} value={L.v} className="!pb-0 !text-[11px]">
            <Tag color={L.color} className="!text-[10px] !py-0 !px-1 !m-0 font-mono rounded-full">
              {L.label.charAt(0)}
            </Tag>
          </Checkbox>
        ))}
      </Checkbox.Group>

      {/* 时间过滤：时间图标 + 快捷按钮组 + 自定义范围 Popover + 已选范围 Tag */}
      <div
        className="flex items-center gap-1 text-[10.5px] ml-0.5"
        style={{ color: hasTimeFilter ? 'var(--ls-brand)' : 'var(--ls-text-tertiary)' }}
      >
        <ClockCircleOutlined />
        <span>时间</span>
      </div>
      {/* 已选范围紧跟“时间”标题展示，换行时也不会被后续筛选项挤到末尾。 */}
      {TimeRangeBadge}
      <div className="flex items-center gap-1">
          {TIME_PRESETS.map((p) => {
            const active: boolean =
              p.minutes === 'clear'
                ? false
                : (() => {
                    // 高亮：简单判定当前是否符合这个预设 —— 清空/自定义 不高亮快捷按钮
                    if (!hasTimeFilter) return false;
                    const now = Date.now();
                    const end = filter.time_end_ms;
                    if (p.minutes === 'today') {
                      const startOfDay = dayjs().startOf('day').valueOf();
                      return !!(
                        end &&
                        Math.abs(end - now) < 60_000 &&
                        filter.time_start_ms === startOfDay
                      );
                    }
                    if (typeof p.minutes === 'number' && end) {
                      const expectedStart = now - p.minutes * 60 * 1000;
                      return !!(
                        Math.abs(end - now) < 60_000 &&
                        Math.abs((filter.time_start_ms ?? 0) - expectedStart) < 60_000
                      );
                    }
                    return false;
                  })();
            const isClear = p.minutes === 'clear';
            return (
              <Tooltip key={p.label} title={isClear ? '清除时间筛选' : `最近 ${p.label}`}>
                <Tag.CheckableTag
                  checked={active}
                  onChange={() => applyTimePreset(p)}
                  className="!text-[10.5px] !px-1.5 !py-0"
                  style={{
                    borderColor: 'var(--ls-border-l2)',
                    color: isClear
                      ? 'var(--ls-text-secondary)'
                      : active
                      ? 'var(--ls-text-inverse)'
                      : 'var(--ls-text-secondary)',
                    backgroundColor: isClear
                      ? 'var(--ls-bg-overlay)'
                      : active
                      ? 'var(--ls-brand)'
                      : 'var(--ls-bg-overlay)',
                  }}
                >
                  {p.label}
                </Tag.CheckableTag>
              </Tooltip>
            );
          })}
          {/* 自定义时间范围 */}
          <Popover
            trigger="click"
            placement="bottomLeft"
            open={customOpen}
            onOpenChange={openCustomRange}
            styles={{ container: { padding: 8 } }}
            content={
              <div className="flex flex-col items-start gap-2" style={{ width: 360 }}>
                <div className="text-[11px]" style={{ color: 'var(--ls-text-secondary)' }}>
                  选择日期时间范围（精确到分钟，支持毫秒级过滤）
                </div>
                <RangePicker
                  showTime={{
                    format: 'HH:mm:ss',
                    defaultOpenValue: [dayjs().startOf('day'), dayjs().endOf('day')],
                  }}
                  format="YYYY-MM-DD HH:mm:ss"
                  allowClear
                  getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
                  style={{ width: '100%' }}
                  value={customRange as any}
                  onChange={(dates) => setCustomRange(dates as any)}
                  size="small"
                />
                <div className="flex justify-end gap-2 w-full">
                  <Button
                    size="small"
                    onClick={() => {
                      setCustomRange(null);
                      onChange({ time_start_ms: null, time_end_ms: null });
                      onApplyTimeRange?.(null, null);
                      setCustomOpen(false);
                    }}
                  >
                    清除
                  </Button>
                  <Button size="small" onClick={() => setCustomOpen(false)}>取消</Button>
                  <Button size="small" type="primary" onClick={applyCustomRange}>应用</Button>
                </div>
              </div>
            }
            title={null}
          >
            <Tooltip title="自定义时间范围">
              <Tag.CheckableTag
                checked={(() => {
                  // 自定义高亮：设置了时间范围但不匹配任何快捷预设
                  if (!hasTimeFilter) return false;
                  const now = Date.now();
                  const end = filter.time_end_ms;
                  const matchesPreset = TIME_PRESETS.some((pp) => {
                    if (pp.minutes === 'clear') return false;
                    if (pp.minutes === 'today') {
                      return !!(
                        end &&
                        Math.abs(end - now) < 60_000 &&
                        filter.time_start_ms === dayjs().startOf('day').valueOf()
                      );
                    }
                    if (typeof pp.minutes === 'number' && end) {
                      const expectedStart = now - pp.minutes * 60 * 1000;
                      return !!(
                        Math.abs(end - now) < 60_000 &&
                        Math.abs((filter.time_start_ms ?? 0) - expectedStart) < 60_000
                      );
                    }
                    return false;
                  });
                  return !matchesPreset;
                })()}
                onChange={() => {}}
                className="!text-[10.5px] !px-1.5 !py-0"
                style={{
                  borderColor: 'var(--ls-border-l2)',
                  color: hasTimeFilter ? 'var(--ls-brand)' : 'var(--ls-text-secondary)',
                  backgroundColor: hasTimeFilter ? 'var(--ls-bg-selected)' : 'var(--ls-bg-overlay)',
                }}
              >
                📅 自定义
              </Tag.CheckableTag>
            </Tooltip>
          </Popover>
        </div>
      {/* 通用 Logback 结构化字段模式 */}
      <Tooltip title="按 logback.xml 的专属 logger 规则筛选；output.log 混合日志也可直接区分">
        <Select
          size="small"
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder="日志来源"
          value={filter.sources ?? []}
          onChange={(v) => onChange({ sources: v })}
          options={sourceFacets.map((x) => ({
            value: x.key,
            label: `${({ application: '应用', platform: '平台', workflow: '工作流', identity: '身份服务' } as const)[x.key]} (${x.count})`,
          }))}
          style={{ width: 155 }}
          popupMatchSelectWidth={220}
        />
      </Tooltip>
      <Tooltip title="按 logger 精确过滤（来自 logback 的 %logger 字段）">
        <Select
          size="small"
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder="Logger"
          value={filter.loggers ?? []}
          onChange={(v) => onChange({ loggers: v })}
          options={loggerFacets.map((x) => ({
            value: x.key,
            label: `${x.key} (${x.count})`,
          }))}
          style={{ width: 150 }}
          popupMatchSelectWidth={360}
        />
      </Tooltip>
      <Tooltip title="按线程精确过滤（来自 logback 的 %thread 字段）">
        <Select
          size="small"
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder="线程"
          value={filter.threads ?? []}
          onChange={(v) => onChange({ threads: v })}
          options={threadFacets.map((x) => ({
            value: x.key,
            label: `${x.key} (${x.count})`,
          }))}
          style={{ width: 120 }}
          popupMatchSelectWidth={300}
        />
      </Tooltip>
      <Tooltip title="选择 traceId 后可在当前文件或滚动文件通配路径中还原调用链">
        <Select
          size="small"
          allowClear
          showSearch
          placeholder="traceId"
          value={filter.trace_id ?? undefined}
          onChange={(v) => onChange({ trace_id: v || null })}
          options={traceIds.map((x) => ({ value: x, label: x }))}
          style={{ width: 140 }}
          popupMatchSelectWidth={300}
        />
      </Tooltip>
      {onTraceRemote && (
        <Tooltip title="在服务器端精确搜索当前 traceId">
          <Button
            size="small"
            disabled={!filter.trace_id}
            onClick={() => filter.trace_id && onTraceRemote(filter.trace_id)}
          >
            追链
          </Button>
        </Tooltip>
      )}
      <Tooltip title="自动隐藏占比过高、持续刷屏的 logger">
        <div className="flex items-center gap-1 text-[10.5px]">
          <span style={{ color: 'var(--ls-text-secondary)' }}>
            折叠刷屏{collapsedNoisy > 0 ? `(${collapsedNoisy})` : ''}
          </span>
          <Switch
            size="small"
            checked={!!filter.collapse_noisy}
            onChange={(v) => onChange({ collapse_noisy: v })}
          />
        </div>
      </Tooltip>
      <Tooltip title="把 Java 异常堆栈续行归并到首行">
        <div className="flex items-center gap-1 text-[10.5px]">
          <span style={{ color: 'var(--ls-text-secondary)' }}>折叠堆栈</span>
          <Switch
            size="small"
            checked={filter.collapse_stacktrace !== false}
            onChange={(v) => onChange({ collapse_stacktrace: v })}
          />
        </div>
      </Tooltip>

      <div className="flex-1" />

      {/* 右侧：统计 + 自动滚动 + 操作按钮 */}
      <span
        className="text-[10.5px] font-mono mr-1"
        style={{ color: 'var(--ls-text-tertiary)' }}
      >
        {totalCount.toLocaleString()} 行
      </span>
      {onLogFontSizeChange && (
        <div className="flex items-center gap-0.5" title={`日志字号 ${logFontSize}px`}>
          <FontSizeOutlined style={{ color: 'var(--ls-text-tertiary)' }} />
          <Button
            size="small"
            type="text"
            icon={<MinusOutlined />}
            disabled={logFontSize <= 10}
            onClick={() => onLogFontSizeChange(logFontSize - 1)}
            className="!w-6 !px-0"
          />
          <button
            type="button"
            className="text-[10px] font-mono min-w-[34px] cursor-pointer"
            style={{ color: 'var(--ls-text-secondary)' }}
            title="点击恢复默认字号"
            onClick={() => onLogFontSizeChange(12.5)}
          >
            {logFontSize}px
          </button>
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
            disabled={logFontSize >= 20}
            onClick={() => onLogFontSizeChange(logFontSize + 1)}
            className="!w-6 !px-0"
          />
        </div>
      )}
      <Tooltip title="自动跟随最新日志">
        <div className="flex items-center gap-1">
          <span className="text-[10.5px]" style={{ color: 'var(--ls-text-secondary)' }}>
            跟随
          </span>
          <Switch
            size="small"
            checked={autoScroll}
            onChange={onAutoScrollChange}
          />
        </div>
      </Tooltip>
      {onReloadHistory && (
        <Tooltip title="重新加载历史日志">
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={onReloadHistory}
            className="mac-titlebar-nd !text-[11px] rounded-lg"
          >
            刷新
          </Button>
        </Tooltip>
      )}
      {onSearchRemote && (
        <Button
          size="small"
          type="primary"
          icon={<SearchOutlined />}
          onClick={handleSearchRemote}
          className="mac-titlebar-nd !text-[11px] rounded-lg ls-btn-primary-glow"
        >
          grep
        </Button>
      )}
      {onExport && (
        <Tooltip title="导出当前显示的日志为 .log">
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={onExport}
            className="mac-titlebar-nd !text-[11px] rounded-lg"
          >
            导出
          </Button>
        </Tooltip>
      )}
      {((filter.keyword ?? []).length > 0 || (filter.keyword_exclude ?? []).length > 0 || filter.levels.length || hasTimeFilter) ? (
        <Tooltip title="清除所有过滤条件">
          <Button
            size="small"
            type="text"
            danger
            icon={<CloseCircleOutlined />}
            onClick={onReset}
            className="mac-titlebar-nd rounded-lg"
          />
        </Tooltip>
      ) : null}
    </div>
  );
};

export default SearchFilterBar;
