/**
 * LogSight Tailwind 配置
 * 双主题（Dark / Light）设计系统
 * Dark: 深色开发者风格（柔和翠绿主色）
 * Light: 清爽专业日间风格（深青碧主色）
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-27
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /* ====== 品牌色（CSS 变量驱动，随主题切换） ====== */
        'ls-brand': 'var(--ls-brand)',

        /* ====== 语义背景（双主题自动切换 via CSS vars） ====== */
        'ls-bg': {
          base: 'var(--ls-bg-base)',
          surface: 'var(--ls-bg-surface)',
          elevated: 'var(--ls-bg-elevated)',
          sider: 'var(--ls-bg-sider)',
          overlay: 'var(--ls-bg-overlay)',
          hover: 'var(--ls-bg-hover)',
          active: 'var(--ls-bg-active)',
        },
        'ls-text': {
          primary: 'var(--ls-text-primary)',
          secondary: 'var(--ls-text-secondary)',
          tertiary: 'var(--ls-text-tertiary)',
          brand: 'var(--ls-text-brand)',
          inverse: 'var(--ls-text-inverse)',
        },
        'ls-border': {
          l1: 'var(--ls-border-l1)',
          l2: 'var(--ls-border-l2)',
          brand: 'var(--ls-border-brand)',
        },

        /* ====== 深色主题 Grey 阶梯 ====== */
        'logsight-grey': {
          50:  '#F8FAFC',
          100: '#E2E8F0',
          200: '#CBD5E1',
          300: '#94A3B8',
          400: '#64748B',
          500: '#475569',
          600: '#334155',
          700: '#1E293B',
          800: '#151B25',
          900: '#0F1115',
          950: '#0A0C0F',
        },

        /* ====== 深色主题专属静态色（备用） ====== */
        'logsight-brand-dark': '#34D399',
        'logsight-brand-dark-hover': '#10B981',
        'logsight-cyan-dark': '#22D3EE',
        'logsight-lilac-dark': '#A78BFA',
        'logsight-blue-dark': '#60A5FA',

        /* ====== 浅色主题专属静态色（备用） ====== */
        'logsight-brand-light': '#0D9488',
        'logsight-brand-light-hover': '#0F766E',
        'logsight-cyan-light': '#0891B2',
        'logsight-lilac-light': '#7C3AED',
        'logsight-blue-light': '#2563EB',
        'logsight-bg-sider-light': '#F1F5F9',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', 'Courier New', 'monospace'],
        sans: ['SF Pro Text', '-apple-system', 'BlinkMacSystemFont', 'PingFang SC', 'Helvetica Neue', 'sans-serif'],
      },
      boxShadow: {
        /* 深色主题品牌辉光（柔和） */
        'ls-glow-brand': '0 0 12px 0 rgba(52,211,153,0.16)',
        'ls-glow-cyan': '0 0 12px 0 rgba(34,211,238,0.12)',
        /* 浅色主题面板阴影 */
        'ls-panel': '0 1px 3px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04)',
        'ls-panel-lg': '0 4px 12px rgba(15,23,42,0.08), 0 2px 4px rgba(15,23,42,0.04)',
        'ls-panel-dark': '0 4px 20px rgba(0,0,0,0.35)',
        'ls-float-dark': '0 8px 30px rgba(0,0,0,0.45)',
      },
      borderRadius: {
        'ls': '8px',
        'ls-lg': '10px',
        'ls-xl': '12px',
      },
    },
  },
  plugins: [],
};
