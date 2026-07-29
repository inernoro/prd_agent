import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * 前端依赖装在 cds/web/node_modules；tests/ 在 cds/ 下，裸 import 'react' 解析不到。
 * 只把测试文件**直接**用到的这两个包指过去即可——组件内部的 lucide-react 等
 * 由 web/src/ 里的文件发起，Vite 从它们自己的目录向上找，天然命中 web/node_modules。
 * 用正则精确匹配：字符串别名是前缀匹配，'react' 会顺带把 'react-dom' 也劫走。
 */
const requireFromWeb = createRequire(path.join(here, 'web/package.json'));
function tryResolve(specifier: string): string | undefined {
  try {
    return requireFromWeb.resolve(specifier);
  } catch {
    return undefined;
  }
}

const react = tryResolve('react');
const reactDomServer = tryResolve('react-dom/server');
const reactJsxRuntime = tryResolve('react/jsx-runtime');

// 解析不到时别只是「少一条 alias」——渲染冒烟会以 `Failed to load url react` 收场，
// 而那句报错完全没指向真正的原因（cds/web 没装依赖）。这里把原因直接说出来。
// 不 throw：那会让 340+ 条与前端无关的用例陪葬，只想跑后端测试的人不该被拦。
if (!react || !reactDomServer || !reactJsxRuntime) {
  console.warn(
    '[vitest] cds/web/node_modules 里找不到 react，前端渲染冒烟将无法加载。\n' +
    '         先跑 `pnpm run install:web`（CI 在 ci.yml / cds.yml 里已有这一步）。',
  );
}

export default defineConfig({
  resolve: {
    alias: [
      // `@/` 是 cds/web 的路径别名（web/tsconfig.json 的 paths）。配在这里是为了让
      // tests/ 能直接 import 前端组件做渲染冒烟——源码扫描只能证明「调用写在那儿」，
      // 渲染才证明「东西真的出现在屏幕上」。对存量测试是纯增量。
      { find: '@', replacement: path.resolve(here, 'web/src') },
      ...(react ? [{ find: /^react$/, replacement: react }] : []),
      ...(reactJsxRuntime ? [{ find: /^react\/jsx-runtime$/, replacement: reactJsxRuntime }] : []),
      ...(reactDomServer ? [{ find: /^react-dom\/server$/, replacement: reactDomServer }] : []),
    ],
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});
