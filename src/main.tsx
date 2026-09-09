/*
 * React 应用入口文件
 * 挂载全局样式、入口组件（ConfigProvider 移到 App.tsx 以支持主题动态切换）
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import 'dayjs/locale/zh-cn';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
