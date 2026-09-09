/*
 * 全局类型声明
 * 声明 Vite 特有的模块与 CSS 模块导入
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */

/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

declare module '*.css' {
  const content: { readonly [key: string]: string };
  export default content;
}

declare module '*.scss' {
  const content: { readonly [key: string]: string };
  export default content;
}

declare module 'react-window' {
  import type { ComponentType, CSSProperties } from 'react';

  export interface VariableSizeListProps {
    height: number;
    itemCount: number;
    itemSize: (index: number) => number;
    estimatedItemSize?: number;
    width: number | string;
    overscanCount?: number;
    ref?: any;
    onItemsRendered?: (p: {
      overscanStartIndex: number;
      overscanStopIndex: number;
      visibleStartIndex: number;
      visibleStopIndex: number;
    }) => void;
    children: (p: { index: number; style: CSSProperties }) => React.ReactNode;
    scrollToItem?: (index: number, align?: 'auto' | 'start' | 'end' | 'center') => void;
    resetAfterIndex?: (index: number, shouldForceUpdate?: boolean) => void;
  }

  export const VariableSizeList: ComponentType<VariableSizeListProps>;
}
