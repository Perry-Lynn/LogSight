/*
 * 日志过滤与续行归并工具
 * 1) 把异常堆栈等续行归并到所属主行，形成可折叠的渲染行
 * 2) 按结构化字段（logger / thread / traceId / 级别 / 时间）+ 关键字过滤
 * 3) 自动识别刷屏 logger，供 UI 折叠
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-09-02
 */
import type { LogLine, LogSourceKey, SearchFilter } from '@/types';

/**
 * 默认搜索过滤条件
 * 结构化维度（loggers / threads / trace_id）为空数组表示不过滤；
 * collapse_stacktrace 默认开启，把异常堆栈折叠进主行，避免堆栈行淹没列表
 */
export const DEFAULT_SEARCH_FILTER: SearchFilter = {
  keyword: [],
  keyword_exclude: [],
  regex: false,
  case_insensitive: true,
  levels: [],
  time_start_ms: null,
  time_end_ms: null,
  loggers: [],
  logger_exclude: [],
  threads: [],
  sources: [],
  trace_id: null,
  collapse_noisy: false,
  collapse_stacktrace: true,
};

/** 渲染行：一条主日志 + 归属它的续行（堆栈等） */
export interface RenderRow {
  /** 主行（结构化日志行） */
  line: LogLine;
  /** 归属的续行，如 Java 异常堆栈 */
  children: LogLine[];
  /** 是否属于刷屏 logger（命中时会被折叠，不出现在结果里） */
  noisy: boolean;
}

/** 分面统计项，供过滤栏下拉选择 */
export interface FacetStat {
  key: string;
  count: number;
}

const IDENTITY_LOGGERS = [
  'com.example.identity',
  'com.example.application.controller.IdentityController',
  'com.example.application.service.IdentityService',
];

const WORKFLOW_LOGGERS = [
  'com.example.workflow',
  'org.flowable',
  'com.example.application.workflow.TaskService',
  'com.example.application.workflow.CallbackService',
  'com.example.application.workflow.StatusNotifier',
];

const PLATFORM_LOGGERS = [
  'com.example.application.controller.platform',
  'com.example.application.service.platform',
  'com.example.application.platform',
  'com.example.application.service.PlatformEventService',
  'com.example.application.service.PlatformTaskService',
  'com.example.application.job.PlatformSyncJob',
  'com.example.application.interceptor.PlatformTrace',
];

const loggerMatches = (logger: string | null | undefined, prefixes: string[]) =>
  !!logger && prefixes.some((prefix) => logger === prefix || logger.startsWith(`${prefix}.`));

/**
 * 按 logback.xml 的专属 logger 规则识别日志来源。
 * 混合输出文件额外识别平台固定标记与 /platform/ URI。
 */
export function classifyLogSource(line: LogLine): LogSourceKey {
  const logger = (line.logger ?? '').toLowerCase();
  if (loggerMatches(line.logger, IDENTITY_LOGGERS)) return 'identity';
  if (
    logger.includes('.identity.') ||
    logger.endsWith('.identitycontroller') ||
    logger.endsWith('.identityservice')
  ) return 'identity';
  if (loggerMatches(line.logger, WORKFLOW_LOGGERS)) return 'workflow';
  if (
    logger.includes('.workflow.') ||
    logger.startsWith('o.workflow.') ||
    logger.endsWith('.taskservice') ||
    logger.endsWith('.callbackservice') ||
    logger.endsWith('.statusnotifier')
  ) return 'workflow';
  if (loggerMatches(line.logger, PLATFORM_LOGGERS)) return 'platform';
  if (
    logger.includes('.platform.') ||
    logger.endsWith('.platformtrace') ||
    logger.endsWith('.platformeventsservice') ||
    logger.endsWith('.platformtaskservice') ||
    logger.endsWith('.platformsyncjob')
  ) return 'platform';
  const text = `${line.message ?? ''}\n${line.raw}`;
  if (/\[(?:PLATFORM-IN|PLATFORM-OUT)\]/.test(text) || text.includes('/platform/')) return 'platform';
  return 'application';
}

/**
 * 构造关键字匹配函数
 * 多个关键字为 AND 关系：所有词都命中才返回 true
 * 正则非法时（用户还在输入过程）退化为纯文本包含，避免报错中断
 * @returns null 表示无关键字，全部命中
 */
export function buildKeywordMatcher(
  f: SearchFilter,
): ((text: string) => boolean) | null {
  const terms = (f.keyword ?? []).filter((t) => t.trim());
  if (terms.length === 0) return null;
  const ci = f.case_insensitive;
  const matchers = terms.map((kw) => {
    try {
      const flags = ci ? 'i' : '';
      const re = f.regex
        ? new RegExp(kw, flags)
        : new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      return (text: string) => re.test(text);
    } catch {
      const lower = kw.toLowerCase();
      return ci
        ? (text: string) => text.toLowerCase().includes(lower)
        : (text: string) => text.includes(kw);
    }
  });
  return (text: string) => matchers.every((m) => m(text));
}

/**
 * 构造排除关键字匹配函数
 * 排除关键字是一个字符串数组，任一词命中即排除该行
 * @returns null 表示无排除关键字，不排除任何行
 */
export function buildExcludeMatcher(
  excludeTerms: string[] | undefined | null,
  caseInsensitive: boolean,
): ((text: string) => boolean) | null {
  const terms = (excludeTerms ?? []).filter((t) => t.trim());
  if (terms.length === 0) return null;
  const ci = caseInsensitive;
  const matchers = terms.map((term) => {
    if (ci) {
      const lower = term.toLowerCase();
      return (text: string) => text.toLowerCase().includes(lower);
    }
    return (text: string) => text.includes(term);
  });
  return (text: string) => matchers.some((m) => m(text));
}

/**
 * 把扁平行数组整理成渲染行
 * is_continuation 的行（异常堆栈、多行消息）归入上一条主行
 * 注意：位于数组开头、无处归属的续行会降级为独立主行
 */
export function groupLines(lines: LogLine[]): RenderRow[] {
  const rows: RenderRow[] = [];
  for (const line of lines) {
    if (line.is_continuation && rows.length > 0) {
      rows[rows.length - 1].children.push(line);
    } else {
      rows.push({ line, children: [], noisy: false });
    }
  }
  return rows;
}

/**
 * 判断单个渲染行是否满足过滤条件
 * 关键字匹配会同时检查主行与续行（在堆栈里搜异常类名是很常见的用法）
 * 排除关键字：主行和所有续行都不命中排除词时才保留
 */
function rowMatches(
  row: RenderRow,
  matcher: ((t: string) => boolean) | null,
  excludeMatcher: ((t: string) => boolean) | null,
  f: SearchFilter,
): boolean {
  const { line, children } = row;

  // 级别：以主行为准
  if (f.levels?.length && !f.levels.includes(line.level)) return false;

  // traceId 精确追踪
  if (f.trace_id && line.trace_id !== f.trace_id) return false;

  // logger 白名单 / 黑名单
  if (f.loggers?.length && (!line.logger || !f.loggers.includes(line.logger))) return false;
  if (f.logger_exclude?.length && line.logger && f.logger_exclude.includes(line.logger)) {
    return false;
  }

  // 线程白名单
  if (f.threads?.length && (!line.thread || !f.threads.includes(line.thread))) return false;

  // 日志来源：按 logback 专属 logger / 平台固定标记分类
  if (f.sources?.length && !f.sources.includes(classifyLogSource(line))) return false;

  // 时间范围：以主行时间戳为准；无时间戳的孤儿行不因时间被过滤掉
  if (line.timestamp_ms != null) {
    if (f.time_start_ms && line.timestamp_ms < f.time_start_ms) return false;
    if (f.time_end_ms && line.timestamp_ms > f.time_end_ms) return false;
  }

  // 排除关键字：主行和所有续行都命中任一排除词时排除
  if (excludeMatcher) {
    const mainHit = excludeMatcher(line.raw);
    const allChildrenHit = children.length > 0 && children.every((c) => excludeMatcher(c.raw));
    if (mainHit || allChildrenHit) return false;
  }

  // 关键字：主行或任一续行命中即保留
  if (matcher) {
    if (matcher(line.raw)) return true;
    return children.some((c) => matcher(c.raw));
  }
  return true;
}

/** 过滤结果：可直接渲染的行 + 被折叠掉的刷屏行数 */
export interface FilterResult {
  rows: RenderRow[];
  /** 因命中刷屏 logger 被折叠隐藏的行数（含其续行） */
  collapsedNoisy: number;
}

/**
 * 应用完整过滤条件，返回可直接渲染的行
 * collapse_noisy 开启时，命中刷屏 logger 的行直接折叠掉并计数，
 * 这样 81% 都是同一个定时任务的日志时，列表里剩下的才是真正要看的内容
 * @param noisyLoggers 自动识别出的刷屏 logger 集合
 */
export function applyLogFilter(
  lines: LogLine[],
  f: SearchFilter,
  noisyLoggers: Set<string> = new Set(),
): FilterResult {
  const matcher = buildKeywordMatcher(f);
  const excludeMatcher = buildExcludeMatcher(f.keyword_exclude, f.case_insensitive);
  const rows = groupLines(lines);
  const out: RenderRow[] = [];
  let collapsedNoisy = 0;
  for (const row of rows) {
    if (!rowMatches(row, matcher, excludeMatcher, f)) continue;
    const isNoisy =
      !!f.collapse_noisy && !!row.line.logger && noisyLoggers.has(row.line.logger);
    if (isNoisy) {
      collapsedNoisy += 1 + row.children.length;
      continue;
    }
    row.noisy = isNoisy;
    out.push(row);
  }
  // 所有查看模式统一按时间倒序展示；相同时间用行号倒序保持最新记录在上。
  out.sort((a, b) => {
    const aTs = a.line.timestamp_ms ?? Number.MIN_SAFE_INTEGER;
    const bTs = b.line.timestamp_ms ?? Number.MIN_SAFE_INTEGER;
    if (aTs !== bTs) return bTs - aTs;
    return b.line.line_no - a.line.line_no;
  });
  return { rows: out, collapsedNoisy };
}

/**
 * 自动识别刷屏 logger
 * 单个 logger 占比超过阈值且总量够大时判定为噪音（如每 N 秒一次的定时轮询任务）
 * @param minCount 参与统计的最少行数，样本太少不做判定
 * @param ratioThreshold 占比阈值，默认 20%
 */
export function detectNoisyLoggers(
  lines: LogLine[],
  minCount = 100,
  ratioThreshold = 0.2,
): Set<string> {
  const counts = new Map<string, number>();
  let total = 0;
  for (const l of lines) {
    if (l.is_continuation || !l.logger) continue;
    counts.set(l.logger, (counts.get(l.logger) ?? 0) + 1);
    total += 1;
  }
  const noisy = new Set<string>();
  if (total < minCount) return noisy;
  for (const [logger, c] of counts) {
    if (c / total >= ratioThreshold) noisy.add(logger);
  }
  return noisy;
}

/** 统计 logger 分布（按出现次数降序），供过滤栏下拉 */
export function collectLoggerFacets(lines: LogLine[]): FacetStat[] {
  const counts = new Map<string, number>();
  for (const l of lines) {
    if (l.is_continuation || !l.logger) continue;
    counts.set(l.logger, (counts.get(l.logger) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

/** 统计线程分布（按出现次数降序），供过滤栏下拉 */
export function collectThreadFacets(lines: LogLine[]): FacetStat[] {
  const counts = new Map<string, number>();
  for (const l of lines) {
    if (l.is_continuation || !l.thread) continue;
    counts.set(l.thread, (counts.get(l.thread) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

/** 统计应用 / 平台 / 工作流 / 身份服务的日志数量 */
export function collectSourceFacets(lines: LogLine[]): Array<{ key: LogSourceKey; count: number }> {
  const counts = new Map<LogSourceKey, number>();
  for (const line of lines) {
    if (line.is_continuation) continue;
    const key = classifyLogSource(line);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (['application', 'platform', 'workflow', 'identity'] as LogSourceKey[]).map((key) => ({
    key,
    count: counts.get(key) ?? 0,
  }));
}

/** 收集出现过的 traceId（去重，按首次出现顺序），供链路追踪下拉 */
export function collectTraceIds(lines: LogLine[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (l.trace_id && !seen.has(l.trace_id)) {
      seen.add(l.trace_id);
      out.push(l.trace_id);
    }
  }
  return out;
}
