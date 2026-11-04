import fs from 'node:fs';
import path from 'node:path';

import { AgentWorkspaceRuntimeError } from '../errors.js';
import { OPEN_DESIGN_PRESENTATION_SKILL } from '../prompts.js';

export const OPEN_DESIGN_PRESENTATION_SKILL_DIRECTORY = 'guizang-ppt';

export const OPEN_DESIGN_PRESENTATION_SKILL_FILES = [
  'SKILL.md',
  'open-design.json',
  'assets/template.html',
  'assets/example-slides.html',
  'references/checklist.md',
  'references/components.md',
  'references/layouts.md',
  'references/styles.md',
  'references/themes.md',
] as const;

export function missingPresentationSkillSourceFiles(sourceDir: string): string[] {
  const missing: string[] = OPEN_DESIGN_PRESENTATION_SKILL_FILES
    .filter((relative) => !fs.existsSync(path.join(sourceDir, relative)));
  const skillPath = path.join(sourceDir, 'SKILL.md');
  if (!missing.includes('SKILL.md') && !/^name:\s*magazine-web-ppt\s*$/m.test(fs.readFileSync(skillPath, 'utf8'))) {
    missing.push(`SKILL.md#name=${OPEN_DESIGN_PRESENTATION_SKILL}`);
  }
  return missing;
}

/**
 * 把镜像内 OpenDesign 0.21.1 自带的完整 PPT bundle 原样注册进 design-template catalog。
 * 不预填成品、不修改模板；项目级 `.od-skills` 由 OpenDesign 的 import/folder 自己 stage。
 */
export function registerPresentationSkill(
  input: { sourceDir: string; templatesDir: string },
  chownForEngine: (target: string) => void,
): void {
  const missing = missingPresentationSkillSourceFiles(input.sourceDir);
  if (missing.length > 0) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_design_template_init_failed',
      `OpenDesign presentation skill is incomplete: ${missing.join(', ')}`,
      false,
    );
  }
  const target = path.join(input.templatesDir, OPEN_DESIGN_PRESENTATION_SKILL_DIRECTORY);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  fs.cpSync(input.sourceDir, target, { recursive: true, force: false, errorOnExist: true });
  const copiedMissing = missingPresentationSkillSourceFiles(target);
  if (copiedMissing.length > 0) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_design_template_init_failed',
      `Registered OpenDesign presentation skill is incomplete: ${copiedMissing.join(', ')}`,
      false,
    );
  }
  for (const relative of OPEN_DESIGN_PRESENTATION_SKILL_FILES) {
    const source = fs.readFileSync(path.join(input.sourceDir, relative));
    const copied = fs.readFileSync(path.join(target, relative));
    if (!source.equals(copied)) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_design_template_init_failed',
        `Registered OpenDesign presentation skill changed bytes: ${relative}`,
        false,
      );
    }
  }
  chownForEngine(target);
}
