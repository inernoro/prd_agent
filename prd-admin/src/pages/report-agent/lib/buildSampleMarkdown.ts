import type { ReportTemplate, ReportTemplateSection } from '@/services/contracts/reportAgent';

/**
 * 按 inputType 给 LLM + 用户一个"填什么"的示例片段。
 * 样本里 H2 标题对齐模板章节名，可显著提高 LLM 导入映射命中率。
 */
function buildSectionSample(section: ReportTemplateSection): string {
  const inputType = section.inputType;
  const hint = section.description ? `> ${section.description}\n\n` : '';
  const autoStatsHint =
    section.sectionType === 'auto-stats'
      ? '> ℹ 此板块数据可能已由系统自动采集；手动导入时按下方示例填写即可，后续会被采集结果合并。\n\n'
      : '';

  switch (inputType) {
    case 'key-value':
      return (
        `${hint}${autoStatsHint}` +
        '<!-- 每行一条 "指标名: 数值或文本值" -->\n' +
        '代码提交: 32 次\n' +
        '需求闭环: 8 / 10\n'
      );
    case 'progress-table':
      return (
        `${hint}${autoStatsHint}` +
        '<!-- 每行一条 "任务名: 进度描述" -->\n' +
        '账户中心重构: 80%\n' +
        '数据看板 v2: 50%\n'
      );
    case 'issue-list':
      return (
        `${hint}` +
        '<!-- 每行一个问题；导入后请在界面手动选择分类/状态 -->\n' +
        '- 登录页偶发 500 错误 #1234\n' +
        '- 图表加载慢于 3s #2210\n'
      );
    case 'rich-text':
      return (
        `${hint}` +
        '（此处写一段完整描述，支持 **加粗** / *斜体* / 列表等 markdown 语法）\n'
      );
    case 'free-text':
      return (
        `${hint}` +
        '（自由描述：本周心得 / 下周重点 / 其它备注）\n'
      );
    case 'bullet-list':
    default:
      return (
        `${hint}` +
        '- 示例条目 1\n' +
        '- 示例条目 2\n' +
        '- 示例条目 3\n'
      );
  }
}

/**
 * 基于当前模板生成一份推荐的 Markdown 周报样本。
 * - H1 = 模板名 · 周期
 * - 每个模板章节对应一个 H2
 * - 每个 H2 下嵌入按 inputType 的示例内容 + 使用说明注释
 */
export function buildSampleMarkdown(
  template: ReportTemplate,
  weekYear: number,
  weekNumber: number,
): string {
  const sections = [...template.sections].sort((a, b) => a.sortOrder - b.sortOrder);

  const header = [
    `# ${template.name} · ${weekYear} 年第 ${weekNumber} 周`,
    '',
    '> 使用说明：',
    '> 1. 每个二级标题 (##) 对应模板一个章节，标题保持不变能提高 AI 映射命中率；',
    '> 2. 无法对应模板的章节会自动归入第一个"心得/备注"类章节；',
    '> 3. issue-list 章节的"分类/状态"请导入后在界面中手动选择；',
    '> 4. 所有内容请基于真实情况填写，禁止编造指标。',
    '',
  ].join('\n');

  const body = sections
    .map((s) => {
      const title = `## ${s.title}`;
      const sample = buildSectionSample(s);
      return `${title}\n${sample}`;
    })
    .join('\n');

  return `${header}\n${body}\n`;
}

/** 浏览器端触发下载 .md 文件 */
export function downloadSampleMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
