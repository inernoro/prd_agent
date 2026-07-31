/**
 * 配置页签：发布脚本原文、服务器与目录、项目身份、回滚策略。
 *
 * 脚本原文从首屏搬到这里是本次改版的重点之一——旧版首屏被十个等权重字段方框
 * 加一整段 shell 占满，而用户真正关心的三个问题（线上跑哪一版 / 健不健康 / 坏了退哪）
 * 反倒埋着。脚本是低频内容，属于「要看的时候能翻到」，不属于「一进来就糊脸」。
 */

import { Archive, ExternalLink, Settings, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InfoBlock, SectionLabel } from './shared';
import type { CenterRow } from './types';

export interface ConfigTabProps {
  row: CenterRow;
  publicUrl: string;
  onConfigure: () => void;
  onArchive: () => void;
}

export function ConfigTab({ row, publicUrl, onConfigure, onArchive }: ConfigTabProps): JSX.Element {
  const ssh = row.target.ssh;
  const strategy = row.target.strategy;
  const scripts = deployScriptLines(row);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="cds-surface-raised cds-hairline rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">站点与服务器</h3>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onConfigure}>
              <Settings />
              修改配置
            </Button>
            <Button size="sm" variant="outline" onClick={onArchive}>
              <Archive />
              归档
            </Button>
          </div>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <InfoBlock label="所属项目">
            {row.target.projectIdentity?.repository
              ? `${row.target.projectIdentity.projectSlug} · ${row.target.projectIdentity.repository}`
              : row.target.projectIdentity?.projectSlug || row.target.projectId}
          </InfoBlock>
          <InfoBlock label="服务器">
            <span className="font-mono text-xs">
              {ssh ? `${ssh.user}@${ssh.host}:${ssh.port}` : '-'}
            </span>
          </InfoBlock>
          <InfoBlock label="远端项目仓库">
            <span className="font-mono text-xs">{ssh?.appPath || '-'}</span>
          </InfoBlock>
          <InfoBlock label="上线地址">
            {publicUrl ? (
              <a href={publicUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-primary hover:underline">
                <span className="truncate">{publicUrl}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </a>
            ) : '-'}
          </InfoBlock>
          <InfoBlock label="健康检查">
            <span className="font-mono text-xs">{ssh?.healthcheckUrl || '-'}</span>
          </InfoBlock>
          <InfoBlock label="回滚策略">
            {ssh?.rollbackCommand?.trim() ? `执行 ${ssh.rollbackCommand.trim()}` : '重新发布历史成功版本'}
          </InfoBlock>
        </div>
      </section>

      <section className="cds-surface-raised cds-hairline rounded-lg p-4">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">发布脚本原文</h3>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">{strategyDescription(row)}</p>
        <pre
          className="mt-3 max-h-[46vh] overflow-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 font-mono text-[11.5px] leading-6"
          style={{ overscrollBehavior: 'contain' }}
        >
          {scripts.join('\n')}
        </pre>
      </section>

      {strategy?.detectedFrom && strategy.detectedFrom.length > 0 ? (
        <section className="cds-surface-raised cds-hairline rounded-lg p-4">
          <SectionLabel>探测依据</SectionLabel>
          <ul className="mt-2 flex flex-col gap-1 text-[12.5px] text-muted-foreground">
            {strategy.detectedFrom.map((item) => (
              <li key={item} className="font-mono">{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * 脚本原文。按 `&&` / `;` 拆行只为可读，不改写任何一个字符——
 * 这一栏的价值就在于「和远端真正执行的一模一样」。
 */
export function deployScriptLines(row: CenterRow): string[] {
  const strategy = row.target.strategy;
  if (strategy?.mode === 'generated-compose') {
    return [
      `# CDS 动态生成，不写回项目仓库；每次发布固化脚本哈希`,
      `docker compose -f ${strategy.composeFile || 'compose.yml'} -p ${strategy.composeProject || '-'} up -d --build`,
    ];
  }
  if (strategy?.mode === 'generated-static') {
    return [
      `# CDS 动态生成，不写回项目仓库；保留 previous，入口探测失败自动恢复`,
      strategy.buildCommand || '# 未配置构建命令',
      `# 产物目录：${strategy.artifactDirectory || '-'}`,
      `# 原子切换：${strategy.publicDirectory || '-'}/current`,
    ];
  }
  const command = (strategy?.command || row.target.ssh?.deployCommand || '').trim();
  if (!command) return ['# 未配置发布命令'];
  return command
    .replace(/&&/g, '\n')
    .replace(/;/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function strategyDescription(row: CenterRow): string {
  const mode = row.target.strategy?.mode || 'existing-script';
  if (mode === 'generated-compose') return 'CDS 动态 Compose 发布：为指定 commit 建隔离 worktree，动态生成执行脚本。';
  if (mode === 'generated-static') return 'CDS 动态静态站发布：离线验证入口资源、归一权限、原子切换 current 并保留 previous。';
  return '项目现有脚本：CDS 只负责预检、日志、入口探测和版本记录，命令本身由项目仓库维护。';
}
