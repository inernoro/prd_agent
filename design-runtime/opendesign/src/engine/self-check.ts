// 启动自检：镜像是否带着本服务钉住的 Codex CLI 与 web-prototype 技能资源，以及有哪些设计系统可选。
// 对应原 CDS 能力探针里那段 `docker run ... codex --version && test -f ...`：判据相同，只是现在
// 服务就在镜像里，直接执行、直接查文件。结果在启动时算一次（镜像不可变），能力接口复用。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DESIGN_SYSTEM_ID_RE, OPEN_DESIGN_CODEX_VERSION } from '../prompts.js';
import { missingWebPrototypeSourceFiles } from './web-prototype.js';

export interface EngineSelfCheck {
  codexVersion: string | null;
  codexMatches: boolean;
  codexObservation: string;
  missingSkillFiles: string[];
  designSystems: string[];
}

/** 列出可选的设计系统：目录名合规（与任务书 designSystemId 同一个正则）且带 DESIGN.md。 */
export function listDesignSystems(designSystemsDir: string): string[] {
  try {
    return fs.readdirSync(designSystemsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && DESIGN_SYSTEM_ID_RE.test(entry.name))
      .filter((entry) => fs.existsSync(path.join(designSystemsDir, entry.name, 'DESIGN.md')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function readCodexVersion(codexBin: string): Promise<{ version: string | null; observation: string }> {
  return new Promise((resolve) => {
    execFile(codexBin, ['--version'], { timeout: 15_000, env: { PATH: process.env.PATH || '' } }, (error, stdout) => {
      if (error) {
        resolve({ version: null, observation: error.message.slice(0, 200) });
        return;
      }
      const version = stdout.trim();
      resolve({ version, observation: version });
    });
  });
}

export async function runEngineSelfCheck(input: {
  codexBin: string;
  webPrototypeSourceDir: string;
  designSystemsDir: string;
}): Promise<EngineSelfCheck> {
  const codex = await readCodexVersion(input.codexBin);
  return {
    codexVersion: codex.version,
    codexMatches: codex.version === `codex-cli ${OPEN_DESIGN_CODEX_VERSION}`,
    codexObservation: codex.observation,
    missingSkillFiles: missingWebPrototypeSourceFiles(input.webPrototypeSourceDir),
    designSystems: listDesignSystems(input.designSystemsDir),
  };
}
