// 原生 web-prototype 技能按原字节拷贝。这里只守资源完整与工作区归属，不改写或审判其样例文案。
// 新建页不预种 index.html，以免模板被误认成最终交付；成品仍由 OpenDesign 写入。
import fs from 'node:fs';
import path from 'node:path';

import { AgentWorkspaceRuntimeError } from '../errors.js';

export interface WebPrototypeLayout {
  /** 镜像里官方 web-prototype 技能的只读源目录。 */
  sourceDir: string;
  /** 平台侧那份拷贝的父目录（生产为 /app/design-templates）。 */
  templatesDir: string;
  /** 工作区根目录（生产为 /workspace）。 */
  workspaceDir: string;
}

const REQUIRED_SKILL_FILES = ['SKILL.md', 'assets/template.html', 'references/layouts.md', 'references/checklist.md'];
const REQUIRED_WORKSPACE_SKILL_FILES = ['assets/template.html', 'references/layouts.md', 'references/checklist.md'];

/**
 * 把官方 web-prototype 技能原样拷两份，只确认必要资源完整。
 * 任何一步不成立都以 `workspace_design_template_init_failed` 失败，不静默放过。
 * `chown` 由调用方传入：服务以 root 运行、引擎以 open-design 运行时，拷贝要交还给引擎用户。
 */
export function prepareWebPrototypeResources(
  layout: WebPrototypeLayout,
  chown: (target: string) => void,
): void {
  const fail = (reason: string): never => {
    throw new AgentWorkspaceRuntimeError(
      'workspace_design_template_init_failed',
      'OpenDesign web prototype resources could not be prepared',
      false,
      { stage: 'design_template_init', reason },
    );
  };
  const platformCopy = path.join(layout.templatesDir, 'web-prototype');
  const workspaceCopy = path.join(layout.workspaceDir, '.od-skills', 'web-prototype');
  try {
    for (const target of [platformCopy, workspaceCopy]) {
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(layout.sourceDir, target, { recursive: true, force: true, preserveTimestamps: true });
    }
  } catch (error) {
    return fail(`copy failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
  }
  for (const relative of REQUIRED_SKILL_FILES) {
    if (!fs.existsSync(path.join(platformCopy, relative))) return fail(`missing web-prototype/${relative}`);
  }
  for (const relative of REQUIRED_WORKSPACE_SKILL_FILES) {
    if (!fs.existsSync(path.join(workspaceCopy, relative))) return fail(`missing .od-skills/web-prototype/${relative}`);
  }
  // 编辑路径的 index.html 由输入包带来，缺了就是传输坏了，必须当场发现；
  // 新建路径本来就没有，不在这里断言它存在。
  if (
    fs.existsSync(path.join(layout.workspaceDir, 'current', 'index.html'))
    && !fs.existsSync(path.join(layout.workspaceDir, 'index.html'))
  ) {
    return fail('editable index.html is missing although current/index.html exists');
  }
  chown(platformCopy);
  chown(path.join(layout.workspaceDir, '.od-skills'));
}

/** 能力自检用：镜像里官方技能的四个文件是否都在（原 CDS 能力探针里的 test -f 四连）。 */
export function missingWebPrototypeSourceFiles(sourceDir: string): string[] {
  return REQUIRED_SKILL_FILES.filter((relative) => !fs.existsSync(path.join(sourceDir, relative)));
}
