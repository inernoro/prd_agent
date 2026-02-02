import * as Babel from '@babel/standalone';
import React from 'react';
import * as Remotion from 'remotion';

/**
 * 编译结果
 */
export interface CompileResult {
  success: boolean;
  component?: React.FC<Record<string, unknown>>;
  error?: string;
  code?: string;
}

/**
 * 从生成的代码中提取纯代码（移除 markdown 标记）
 */
function extractCode(raw: string): string {
  // 移除 markdown 代码块标记
  let code = raw.trim();

  // 移除 ```typescript 或 ```tsx 或 ``` 开头
  code = code.replace(/^```(?:typescript|tsx|jsx|js)?\s*\n?/i, '');
  // 移除结尾的 ```
  code = code.replace(/\n?```\s*$/i, '');

  return code.trim();
}

/**
 * 动态编译 React/Remotion 组件代码
 */
export function compileRemotionCode(sourceCode: string): CompileResult {
  try {
    const cleanCode = extractCode(sourceCode);

    // 使用 Babel 转换代码
    const transformed = Babel.transform(cleanCode, {
      presets: ['react', 'typescript'],
      filename: 'component.tsx',
    });

    if (!transformed.code) {
      return { success: false, error: '编译失败：无输出代码' };
    }

    // 创建模块作用域
    const moduleExports: { default?: React.FC } = {};

    // 注入依赖
    const scope = {
      React,
      ...Remotion,
      // React hooks
      useState: React.useState,
      useEffect: React.useEffect,
      useMemo: React.useMemo,
      useCallback: React.useCallback,
      useRef: React.useRef,
      // Remotion APIs
      useCurrentFrame: Remotion.useCurrentFrame,
      useVideoConfig: Remotion.useVideoConfig,
      interpolate: Remotion.interpolate,
      spring: Remotion.spring,
      Sequence: Remotion.Sequence,
      AbsoluteFill: Remotion.AbsoluteFill,
      Img: Remotion.Img,
      Audio: Remotion.Audio,
      Video: Remotion.Video,
      // 模块导出
      exports: moduleExports,
      module: { exports: moduleExports },
    };

    // 转换 import 语句为变量声明
    let executableCode = transformed.code;

    // 移除 import 语句（我们已经注入了依赖）
    executableCode = executableCode.replace(
      /import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*/g,
      ''
    );

    // 转换 export default 为 module.exports.default
    executableCode = executableCode.replace(
      /export\s+default\s+/g,
      'module.exports.default = '
    );

    // 创建函数执行代码
    const fn = new Function(
      ...Object.keys(scope),
      `"use strict";\n${executableCode}\nreturn module.exports.default;`
    );

    // 执行并获取组件
    const Component = fn(...Object.values(scope));

    if (typeof Component !== 'function') {
      return {
        success: false,
        error: '编译失败：组件必须是一个函数',
        code: cleanCode,
      };
    }

    return {
      success: true,
      component: Component as React.FC<Record<string, unknown>>,
      code: cleanCode,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `编译错误：${errorMessage}`,
      code: extractCode(sourceCode),
    };
  }
}

/**
 * 验证代码是否看起来像有效的 Remotion 组件
 */
export function validateRemotionCode(code: string): { valid: boolean; reason?: string } {
  const cleanCode = extractCode(code);

  if (!cleanCode.includes('export default') && !cleanCode.includes('module.exports')) {
    return { valid: false, reason: '缺少默认导出 (export default)' };
  }

  if (!cleanCode.includes('useCurrentFrame') && !cleanCode.includes('useVideoConfig')) {
    return { valid: false, reason: '建议使用 useCurrentFrame 或 useVideoConfig 实现动画' };
  }

  // 检查是否有不支持的 import
  const unsupportedImports = cleanCode.match(/import\s+.*from\s+['"](?!remotion|react)[^'"]+['"]/g);
  if (unsupportedImports) {
    return {
      valid: false,
      reason: `不支持的依赖：${unsupportedImports.join(', ')}`
    };
  }

  return { valid: true };
}
