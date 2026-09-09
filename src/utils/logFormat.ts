/*
 * 日志结构化字段展示格式化工具
 * 数据来自后端按 logback pattern 解析出的 thread / trace_id / logger / message
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-09-02
 */
import type { LogLevel } from '@/types';

/**
 * logger 缩写：com.example.application.job.SyncJob -> c.e.a.job.SyncJob
 * 包名只留首字母、类名保留完整，便于在窄列里快速区分模块
 */
export function abbreviateLogger(logger: string | null | undefined): string {
  if (!logger) return '';
  const parts = logger.split('.');
  if (parts.length <= 1) return logger;
  const head = parts
    .slice(0, -1)
    .map((p) => p.charAt(0))
    .join('.');
  return `${head}.${parts[parts.length - 1]}`;
}

/** logger 短名：只取最后一段类名，用于极窄列或折叠摘要 */
export function shortLogger(logger: string | null | undefined): string {
  if (!logger) return '';
  const parts = logger.split('.');
  return parts[parts.length - 1] || logger;
}

/** traceId 短码：取前 8 位，列表里能快速比对是否同一链路即可 */
export function shortTraceId(traceId: string | null | undefined): string {
  if (!traceId) return '';
  return traceId.length > 8 ? traceId.slice(0, 8) : traceId;
}

/** 字节数格式化：1.2 MB / 340 KB / 512 B */
export function formatBytes(bytes: number | undefined | null): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / Math.pow(1024, i);
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 日志级别单字母标签，用于分列渲染的级别列 */
export const LEVEL_LABEL: Record<LogLevel, string> = {
  Fatal: 'F',
  Error: 'E',
  Warn: 'W',
  Info: 'I',
  Debug: 'D',
  Trace: 'T',
  Unknown: '-',
};

/** 日志级别中文名，用于 tooltip */
export const LEVEL_TEXT: Record<LogLevel, string> = {
  Fatal: '致命',
  Error: '错误',
  Warn: '警告',
  Info: '信息',
  Debug: '调试',
  Trace: '追踪',
  Unknown: '未知',
};
