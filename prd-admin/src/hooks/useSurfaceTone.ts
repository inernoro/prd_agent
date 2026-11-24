import { useEffect, useState, type RefObject } from 'react';
import { useDataTheme } from '@/hooks/useDataTheme';

type SurfaceTone = 'light' | 'dark';

/**
 * 解析某个元素**实际所处表面**的明暗，而不是全局主题。
 *
 * 为什么需要它：全局是浅色主题时，页面里仍可能有「钉死深色的局部区域」——
 * 星图、CDS Agent 的回答区、作品展示这些。这些区域标了 `surface-tone-dark`
 * 或 `data-surface-tone="dark"`，区域内的 token 会翻回暗色档，但**只读全局主题的组件
 * 感知不到**，于是按浅色档配色画在深底上。
 *
 * 真实事故：Mermaid 图只读 `useDataTheme()`（即 `<html data-theme>`），在 CDS Agent
 * 的深色回答区里选了浅色调色板 —— `#1f2937` 的字压深底约 1.1:1，连线约 2.3:1。
 * Codex 在 PR #1374 抓到。
 *
 * 用法：把容器 ref 传进来，它往上找最近的 `[data-surface-tone]` 或 `.surface-tone-dark`；
 * 都没有就退回全局主题。
 */
export function useSurfaceTone(ref: RefObject<HTMLElement | null>): SurfaceTone {
  const documentTheme = useDataTheme();
  const [tone, setTone] = useState<SurfaceTone>(documentTheme);

  useEffect(() => {
    const el = ref.current;
    if (!el) { setTone(documentTheme); return; }
    // 就近的声明优先：谁离元素近，谁决定这块表面的明暗
    const island = el.closest('[data-surface-tone], .surface-tone-dark');
    if (!island) { setTone(documentTheme); return; }
    const declared = island.getAttribute('data-surface-tone');
    setTone(declared === 'light' ? 'light' : 'dark');
  }, [ref, documentTheme]);

  return tone;
}
