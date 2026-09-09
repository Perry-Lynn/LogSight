/*
 * 日志时间戳解析工具
 * 从日志行首自动识别并提取时间戳（毫秒级 Unix 时间戳）
 * 支持常见日志格式：ISO、Syslog、Apache/Nginx、Java/Logback 等
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-09-02
 */
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';

dayjs.extend(customParseFormat);

/**
 * 常见日志时间戳正则 + dayjs 格式
 * 按优先级排列：越精确的格式越靠前，避免被宽泛格式误匹配
 */
const TS_PATTERNS: Array<{ re: RegExp; fmt: string }> = [
  // 2026-09-02 11:30:45.123（ISO 带毫秒，最常见）
  { re: /^\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\.\d{3})/, fmt: 'YYYY-MM-DD HH:mm:ss.SSS' },
  // 2026-09-02 11:30:45（ISO 无毫秒）
  { re: /^\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?!\.\d)/, fmt: 'YYYY-MM-DD HH:mm:ss' },
  // 2026/09/02 11:30:45.123（Java/Logback 斜杠风格）
  { re: /^\s*(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/, fmt: 'YYYY/MM/DD HH:mm:ss.SSS' },
  // 2026/09/02 11:30:45
  { re: /^\s*(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})(?!\.\d)/, fmt: 'YYYY/MM/DD HH:mm:ss' },
  // 02/Sep/2026:11:30:45 +0800（Apache/Nginx 格式）
  { re: /(\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4})/, fmt: 'DD/MMM/YYYY:HH:mm:ss Z' },
  // 02/Sep/2026:11:30:45（无时区）
  { re: /(\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2})(?! [+-]\d)/, fmt: 'DD/MMM/YYYY:HH:mm:ss' },
  // Sep  2 11:30:45.123（Syslog 带毫秒）
  { re: /([A-Za-z]{3}\s+\d{1,2} \d{2}:\d{2}:\d{2}\.\d{3})/, fmt: 'MMM D HH:mm:ss.SSS' },
  // Sep  2 11:30:45（Syslog 标准格式）
  { re: /([A-Za-z]{3}\s+\d{1,2} \d{2}:\d{2}:\d{2})(?!\.\d)/, fmt: 'MMM D HH:mm:ss' },
  // 2026-09-02T11:30:45Z（UTC ISO 8601）
  { re: /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/, fmt: 'YYYY-MM-DDTHH:mm:ssZ' },
  // 12:05:37.795（纯时间无日期，常见于 Java/MyBatis 日志；补今天日期）
  { re: /^\s*(\d{2}:\d{2}:\d{2}\.\d{1,3})\b/, fmt: 'HH:mm:ss.SSS' },
  // 12:05:37（纯时间无毫秒；补今天日期）
  { re: /^\s*(\d{2}:\d{2}:\d{2})\b/, fmt: 'HH:mm:ss' },
];

/* 缓存上一次匹配成功的 pattern index，加速连续同格式日志 */
let lastHitIdx = 0;

/**
 * 从日志原始文本中解析时间戳
 * @param raw 日志行原始文本
 * @returns Unix 毫秒时间戳；无法识别时返回 null
 */
export function parseLogTimestamp(raw: string): number | null {
  if (!raw || raw.length < 10) return null;

  // 优先尝试上次成功的 pattern（连续同格式日志场景优化）
  if (lastHitIdx >= 0 && lastHitIdx < TS_PATTERNS.length) {
    const p = TS_PATTERNS[lastHitIdx];
    const m = raw.match(p.re);
    if (m) {
      const d = dayjs(m[1], p.fmt);
      if (d.isValid()) {
        // Syslog 无年份 / 纯时间无日期：补当前年/今天日期
        let result = d.valueOf();
        if (!/\d{4}/.test(m[1])) {
          const withYear = d.year(dayjs().year());
          result = withYear.valueOf();
        }
        return result;
      }
    }
  }

  // 遍历所有 pattern
  for (let i = 0; i < TS_PATTERNS.length; i++) {
    const p = TS_PATTERNS[i];
    const m = raw.match(p.re);
    if (m) {
      const d = dayjs(m[1], p.fmt);
      if (d.isValid()) {
        lastHitIdx = i;
        // Syslog 无年份 / 纯时间无日期：补当前年/今天日期
        let result = d.valueOf();
        if (!/\d{4}/.test(m[1])) {
          const withYear = d.year(dayjs().year());
          result = withYear.valueOf();
        }
        return result;
      }
    }
  }
  return null;
}

/**
 * 重置 pattern 缓存（切换标签页或重新加载时调用）
 */
export function resetTimestampCache(): void {
  lastHitIdx = 0;
}
