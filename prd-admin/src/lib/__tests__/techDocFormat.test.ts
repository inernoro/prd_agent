import { describe, expect, it } from 'vitest';
import {
  buildPm2502Draft,
  buildTechDocGenerationPrompt,
  PM2502_TECH_DOC_TEMPLATE,
  validateTechDocContentQuality,
  validateTechDocFormat,
} from '../techDocFormat';

describe('techDocFormat', () => {
  it('accepts the bundled PM2502 template', () => {
    const result = validateTechDocFormat(PM2502_TECH_DOC_TEMPLATE);

    expect(result.passed).toBe(true);
    expect(result.summary.errorCount).toBe(0);
  });

  it('rejects common heading micro-format drift', () => {
    const drifted = PM2502_TECH_DOC_TEMPLATE
      .replace('### 1.原有接口', '### 1. 原有接口')
      .replace('# 五、实施规划', '# 六、实施规划');

    const result = validateTechDocFormat(drifted);

    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.id === 'top-heading-order')).toBe(true);
    expect(result.issues.some((issue) => issue.title === '原有接口标题空格错误')).toBe(true);
  });

  it('builds a draft that still follows PM2502', () => {
    const draft = buildPm2502Draft({
      projectName: '技术分析文档格式校验 Agent',
      appName: '米多总后台',
      moduleName: '百宝箱',
      featureName: '技术分析文档格式校验',
      requirementText: '支持根据功能和项目链接生成 PM2502 技术分析文档，也支持上传技术分析文档后检查格式。',
      projectLinks: 'https://example.com/project',
      uiLink: 'https://example.com/ui',
      showdocLink: 'https://example.com/showdoc',
      testCaseLink: 'https://example.com/testcase',
    });

    const result = validateTechDocFormat(draft);

    expect(draft).toContain('技术分析文档格式校验 Agent');
    expect(result.passed).toBe(true);
  });

  it('embeds strict generation constraints into the prompt', () => {
    const prompt = buildTechDocGenerationPrompt({
      projectName: '技术分析文档格式校验 Agent',
      appName: '米多总后台',
      moduleName: '百宝箱',
      featureName: '技术分析文档格式校验',
      requirementText: '按 PM2502 模板生成或检查技术分析文档。',
      projectLinks: 'https://example.com/project',
    });

    expect(prompt).toContain('只能输出 Markdown 正文');
    expect(prompt).toContain('# 一、项目简介');
    expect(prompt).toContain('### 1.原有接口');
    expect(prompt).toContain('内容事实来源优先级');
    expect(prompt).toContain('禁止只复制模板');
  });

  it('rejects a template-only generated document when requirements are concrete', () => {
    const result = validateTechDocContentQuality(PM2502_TECH_DOC_TEMPLATE, {
      projectName: 'DDD Harness 渐进式项目架构',
      appName: 'miduo-backend',
      moduleName: '文档中枢',
      featureName: 'DDD Harness 架构初始化',
      requirementText: '请根据 DDD+Harness 渐进式新项目架构指南生成技术分析文档，包含 miduo-md 文档中枢、技能门禁、领域分层和 P0 阶段交付。',
      projectLinks: 'https://github.com/MiDouTech/miduo-backend',
      requirementFiles: [
        {
          name: 'DDD+Harness-渐进式新项目架构指南.md',
          content: 'P0 阶段需要建立 miduo-md 文档中枢，补齐 .cursor/skills 技能门禁，并明确领域分层。',
        },
      ],
      githubProject: {
        fullName: 'MiDouTech/miduo-backend',
        owner: 'MiDouTech',
        repo: 'miduo-backend',
        path: '/',
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.id === 'content-template-example-leftover')).toBe(true);
  });
});
