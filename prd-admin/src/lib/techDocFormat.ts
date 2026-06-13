export type TechDocIssueSeverity = 'error' | 'warning' | 'info';

export interface TechDocIssue {
  id: string;
  severity: TechDocIssueSeverity;
  title: string;
  detail: string;
  fix: string;
}

export interface TechDocValidationResult {
  passed: boolean;
  score: number;
  issues: TechDocIssue[];
  summary: {
    errorCount: number;
    warningCount: number;
    infoCount: number;
  };
}

export interface TechDocDraftInput {
  projectName: string;
  appName: string;
  moduleName: string;
  featureName: string;
  requirementText: string;
  projectLinks: string;
  uiLink?: string;
  showdocLink?: string;
  testCaseLink?: string;
  requirementFiles?: Array<{
    name: string;
    content: string;
  }>;
  githubProject?: {
    fullName: string;
    owner: string;
    repo: string;
    branch?: string;
    path?: string;
    htmlUrl?: string;
    treeSummary?: string;
    files?: Array<{
      path: string;
      content: string;
    }>;
  };
}

const TOP_LEVEL_HEADINGS = [
  '# 一、项目简介',
  '# 二、项目内容',
  '# 三、项目设计',
  '# 四、影响范围',
  '# 五、实施规划',
] as const;

const PROJECT_DESIGN_SECTIONS = [
  '## 配置修改',
  '## 流程设计',
  '## 接口设计',
  '## 任务调度',
  '## 数据库设计',
  '## 前端设计',
  '## 组件化分析',
  '## 其他',
  '## 上线计划和步骤',
] as const;

const REQUIRED_EXACT_LINES = [
  ...TOP_LEVEL_HEADINGS,
  ...PROJECT_DESIGN_SECTIONS,
  '### 1.原有接口',
  '### 2.接口改动',
  '### 3.新增接口',
  '### 1.表设计',
  '### 2.数据字典',
  '### 功能明细',
  '### 实现分析',
  '### 1、这期组件化内容',
  '### 2、这期未组件化内容',
  '### 3、已组件化未能支撑内容',
  '## 项目周期',
  '## 人员安排',
  '### 方案设计工作量',
  '### 后端开发工作量',
  '### 前端开发工作量',
  '### 测试工作量',
] as const;

const REQUIRED_SNIPPETS = [
  '（列出项目涉及范围和对应内容及所有的功能点）',
  '（关键流程实现的方式、设计和算法',
  '<font style="color:#DF2A3F;">方案涉及多个项目，推荐按项目划分，结构更清晰！</font>',
  '> 列举此次项目涉及的模块、功能点明细。',
  '> 基于功能明细，除了一些常规的表单',
  '> <font style="color:#DF2A3F;">上线的计划，上线的步骤以及回滚方案</font>',
  '基准工作量（人/日）为初级人员开发工作量',
  '工时（人/日）换算标准：初级 p1：中级 p2：高级 p3=1:1.5:2',
] as const;

const REQUIRED_TABLE_HEADERS = [
  '| **应用** | **模块** | **功能** | **类型** | **备注** |',
  '| **应用** | **模块** | **功能** | **备注** |',
  '| **监控/告警名称** | **告警级别** | **告警设置描述** | **申请人** | **备注** |',
  '| 内容 | 基准工作量 | 负责人 | 常规工时 | AI工时 | 计划完成时间 |',
] as const;

const FORBIDDEN_PATTERNS: Array<{
  id: string;
  pattern: RegExp;
  title: string;
  detail: string;
  fix: string;
}> = [
  {
    id: 'forbidden-patch-marker',
    pattern: /\*\*\* Begin Patch|\*\*\* End Patch|\*\*\* End of File/m,
    title: '存在补丁标记',
    detail: '输出文档不能包含 ApplyPatch 或 diff 补丁痕迹。',
    fix: '删除补丁标记，只保留最终 Markdown 正文。',
  },
  {
    id: 'forbidden-literal-newline',
    pattern: /\\n/,
    title: '存在字面量换行转义',
    detail: 'Markdown 正文中出现了字面量 \\n，会导致文档渲染异常。',
    fix: '把字面量 \\n 替换为真实换行。',
  },
  {
    id: 'forbidden-sixth-top-heading',
    pattern: /^#\s*六[、.．]/m,
    title: '出现模板外顶层章节',
    detail: 'PM2502 模板只允许一到五个顶层章节。',
    fix: '把额外内容收敛到“## 其他”或“# 四、影响范围”。',
  },
  {
    id: 'forbidden-plan-ssot',
    pattern: /Plan\s+SSOT|第二套正文|更新记录附录/i,
    title: '疑似追加第二套正文',
    detail: 'PM2502 要求文档在“五、实施规划”后结束，不能再追加另一套方案正文。',
    fix: '删除重复正文，必要信息归档到现有章节。',
  },
  {
    id: 'forbidden-heading-emoji',
    pattern: /^#{1,6}\s*\p{Extended_Pictographic}/mu,
    title: '标题含图形符号',
    detail: '模板标题不允许使用图形符号或非 PM2502 标题样式。',
    fix: '改回 PM2502 的固定标题文本与编号。',
  },
];

const BAD_MICRO_FORMATS: Array<{
  pattern: RegExp;
  title: string;
  detail: string;
  fix: string;
}> = [
  {
    pattern: /^### 1\. 原有接口$/m,
    title: '原有接口标题空格错误',
    detail: 'PM2502 固定写法是“### 1.原有接口”，1. 后面不能加空格。',
    fix: '改为“### 1.原有接口”。',
  },
  {
    pattern: /^### 1\. 表设计$/m,
    title: '表设计标题空格错误',
    detail: 'PM2502 固定写法是“### 1.表设计”，1. 后面不能加空格。',
    fix: '改为“### 1.表设计”。',
  },
  {
    pattern: /^### 1、\s+这期组件化内容$/m,
    title: '组件化标题空格错误',
    detail: 'PM2502 固定写法是中文顿号后直接接文字。',
    fix: '改为“### 1、这期组件化内容”。',
  },
];

export const PM2502_TECH_DOC_TEMPLATE = `# 一、项目简介
## 项目背景
见方案

## 项目目的
见方案

## 参考资料
+ 方案地址：
+ UI设计图：
+ 前后端对接之编程约定：[https://miduo1031.yuque.com/xbe40z/vut4hx/mo1cb3w9ggmr5zcg](https://miduo1031.yuque.com/xbe40z/vut4hx/mo1cb3w9ggmr5zcg?singleDoc#)
+ 前端项目优化记录：[https://miduo1031.yuque.com/xbe40z/manual/ubtr3btv7lqglvqz](https://miduo1031.yuque.com/xbe40z/manual/ubtr3btv7lqglvqz)
+ showdoc地址：[http://showdoc.miduonet.com/web/#/item/index](http://showdoc.miduonet.com/web/#/item/index)
+ 测试用例：

# 二、项目内容
（列出项目涉及范围和对应内容及所有的功能点）

| **应用** | **模块** | **功能** | **类型** | **备注** |
| --- | --- | --- | :---: | :---: |
| 会员小程序 | 首页 | 每日任务装修 | 新增 | |
| | | 升级礼包弹窗 | 修改 | |


# 三、项目设计
## 配置修改
（项目所涉及的配置修改，包括配置文件。没有则可删除这项）

## 流程设计
（关键流程实现的方式、设计和算法，可采用:（1）标准流程图；（2）PDL语言；（3）N-S图；（4）PAD；（5）判定表等图表）

## 接口设计
（项目所涉及的新增、修改接口，接口需要描述：接口请求方式、请求参数、返回结果是否清晰，修改的接口需要做好兼容兼容旧接口。<font style="color:#DF2A3F;">方案涉及多个项目，推荐按项目划分，结构更清晰！</font>）

### 1.原有接口
如果是原有的接口，这期需要重复用到并且无改动，把原有的接口贴进来

#### bd
##### 码包文件上传-预检
接口地址：\`/v1/code/package/execute-upload\`

请求方式：GET

请求参数：不变

### 2.接口改动
如果是原有接口，这一期需要修改

#### bd
##### 码关系数据存储
接口地址：\`/v1/code/code-relation/validate-add\`

请求方式：POST

请求参数：

\`\`\`json
{
  "order_id": "12345",
  "order_amount": 100.00,
  "currency": "CNY",
  "items": [
    {
      "item_id": "item_001",
      "quantity": 2,
      "price": 50.00
    }
  ]
}
\`\`\`

返回结果：

\`\`\`json
{
\t"return_code": "0",
\t"return_msg": "success",
\t"return_data": {
\t\t"user_id": "12345",
\t\t"user_name": "",
\t\t"age": 0,
\t\t"vip": false,
\t\t"balance": "0.00",
\t\t"register_time": "",
\t\t"tags": [],
\t\t"extends": {}
\t}
}
\`\`\`

### 3.新增接口
如果是新增接口

## 任务调度
（具体说明任务调度自身的含义以及任务调度的流程，重要的调度，需要考虑补偿机制）

## 数据库设计
### 1.表设计
（项目所涉及的数据库修改，详细描述数据库涉及修改的表文档并标红修改字段，编写出对应修改的SQL语句）

### 2.数据字典
（引用数据字典文档链接）

## 前端设计
### 功能明细
> 列举此次项目涉及的模块、功能点明细。
>

| **应用** | **模块** | **功能** | **备注** |
| --- | --- | --- | :---: |
| 会员小程序 | 首页 | 1. 每日任务装修<br/>2. 升级礼包弹窗 |  |


### 实现分析
> 基于功能明细，除了一些常规的表单（列表筛选、简单填写资料）、数据展示（表格、图文修改）外，**详细分析UI交互多、模块设计复杂的功能**，包括但不限于：1. 引用第三方模块、插件； 2. 封装组件、内部模块；3. 实现思路和逻辑等；4. 对其他应用造成影响的特别标明。
>

1. 项目地址及开发分支
+ 互动营销后台：[http://192.168.5.254/svn/ui/activity/admin/](http://192.168.5.254/svn/ui/activity/admin/tap-branch)trunk
+ 会员小程序：[https://e.coding.net/miduoyanfa/bigdataengine/md-user-mp.git](https://e.coding.net/miduoyanfa/bigdataengine/md-user-mp.git)，develop分支
2. 升级礼包弹窗  
升级为会员，进入小程序自动弹窗，展示对应会员礼包。弹窗封装成组件，动态传参\`info\`显示升级礼包数据，其中升级图标有动画效果，可以用\`CSS3 animation\`实现，代码xxx；
3. xx



## 组件化分析
（基于当前项目分析，哪些模板本应该组件化的内容，在这一期进行了组件化；哪些模块本应该组件化的内容，在这一期项目没有进行组件化，或已经组件化未能支撑这期项目需求。更多参考 [前端项目优化记录](https://miduo1031.yuque.com/xbe40z/manual/ubtr3btv7lqglvqz)）

### 1、这期组件化内容


### 2、这期未组件化内容


### 3、已组件化未能支撑内容
## 其他
（没有可删除）

## 上线计划和步骤
> <font style="color:#DF2A3F;">上线的计划，上线的步骤以及回滚方案</font>
>

### 运维监控需求：
按规则填写《监控告警需求设置文档》，并通知运维。如：

| **监控/告警名称** | **告警级别** | **告警设置描述** | **申请人** | **备注** |
| --- | --- | --- | --- | --- |
| <font style="color:rgb(38, 38, 38);">业务资产接口请求超时</font> | P1-严重 | <font style="color:rgb(38, 38, 38);">APPLOG日志：站点"10.66.199.20:2025"30分钟内出现100个超过7s的请求</font> | 李四 | 同时通知张三 |


[https://miduo1031.yuque.com/xbe40z/plh143/hl5zimpuyzqkoniu?singleDoc#cG9L](https://miduo1031.yuque.com/xbe40z/plh143/hl5zimpuyzqkoniu?singleDoc#cG9L) 《监控告警需求设置文档》

# 四、影响范围
（项目修改所影响的范围点，用于测试覆盖以及产品发上线预告）

# 五、实施规划
## 项目周期
开发周期：待排期

测试周期：

验收上线：

## 人员安排
基准工作量（人/日）为初级人员开发工作量

工时（人/日）换算标准：初级 p1：中级 p2：高级 p3=1:1.5:2

### 方案设计工作量
| 内容 | 基准工作量 | 负责人 | 常规工时 | AI工时 | 计划完成时间 |
| --- | --- | --- | --- | --- | --- |
| 主题分析及方案设计 | 2 | xxx | 1 | 0.5 | |


### 后端开发工作量
| 内容 | 基准工作量 | 负责人 | 常规工时 | AI工时 | 计划完成时间 |
| --- | --- | --- | --- | --- | --- |
| xxxxx | 2 | xxx | 1 | 0.5 | |


### 前端开发工作量
| 内容 | 基准工作量 | 负责人 | 常规工时 | AI工时 | 计划完成时间 |
| --- | --- | --- | --- | --- | --- |
| xxxxx | 2 | xxx | 1 | 0.5 | |
| 合计 | | | | | |


### 测试工作量
（包括用例编写与执行用例）

| 内容 | 基准工作量 | 负责人 | 常规工时 | AI工时 | 计划完成时间 |
| --- | --- | --- | --- | --- | --- |
| xxxxx | 2 | xxx | 1 | 0.5 | |
`;

function normalizeDoc(doc: string): string {
  return doc.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function lineExists(doc: string, line: string): boolean {
  return new RegExp(`^${escapeRegExp(line)}$`, 'm').test(doc);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function positionsInOrder(doc: string, lines: readonly string[]): boolean {
  let cursor = -1;
  for (const line of lines) {
    const index = doc.indexOf(line);
    if (index < 0 || index <= cursor) return false;
    cursor = index;
  }
  return true;
}

function pushIssue(issues: TechDocIssue[], issue: TechDocIssue): void {
  if (!issues.some((item) => item.id === issue.id)) {
    issues.push(issue);
  }
}

export function validateTechDocFormat(markdown: string): TechDocValidationResult {
  const doc = normalizeDoc(markdown);
  const issues: TechDocIssue[] = [];

  if (!doc) {
    pushIssue(issues, {
      id: 'empty-doc',
      severity: 'error',
      title: '文档为空',
      detail: '需要上传或粘贴一份 Markdown 技术分析文档。',
      fix: '粘贴技术分析文档正文，或先使用生成模式生成 PM2502 底稿。',
    });
  }

  for (const heading of REQUIRED_EXACT_LINES) {
    if (!lineExists(doc, heading)) {
      pushIssue(issues, {
        id: `missing-line-${heading}`,
        severity: 'error',
        title: `缺少固定标题：${heading}`,
        detail: 'PM2502 模板要求固定标题文本、编号和空格完全一致。',
        fix: `补齐并使用精确写法“${heading}”。`,
      });
    }
  }

  if (!positionsInOrder(doc, TOP_LEVEL_HEADINGS)) {
    pushIssue(issues, {
      id: 'top-heading-order',
      severity: 'error',
      title: '顶层章节顺序不符合 PM2502',
      detail: '顶层章节必须按一、二、三、四、五排列，不能新增或调换。',
      fix: '按“项目简介、项目内容、项目设计、影响范围、实施规划”顺序重排。',
    });
  }

  if (!positionsInOrder(doc, PROJECT_DESIGN_SECTIONS)) {
    pushIssue(issues, {
      id: 'project-design-section-order',
      severity: 'error',
      title: '项目设计二级章节顺序错误',
      detail: '三、项目设计下 9 个二级标题必须按 PM2502 固定顺序排列。',
      fix: '依次调整为配置修改、流程设计、接口设计、任务调度、数据库设计、前端设计、组件化分析、其他、上线计划和步骤。',
    });
  }

  for (const snippet of REQUIRED_SNIPPETS) {
    if (!doc.includes(snippet)) {
      pushIssue(issues, {
        id: `missing-snippet-${snippet}`,
        severity: 'warning',
        title: '模板脚手架提示缺失',
        detail: `缺少模板固定提示：${snippet}`,
        fix: '从 PM2502 模板复制该提示，保留括号说明、引用块或红字 HTML。',
      });
    }
  }

  for (const header of REQUIRED_TABLE_HEADERS) {
    if (!doc.includes(header)) {
      pushIssue(issues, {
        id: `missing-table-${header}`,
        severity: 'error',
        title: '缺少固定表格表头',
        detail: `PM2502 要求保留表格表头：${header}`,
        fix: '按模板补齐表头与对齐行，内容不足时用“暂无/待定”占位。',
      });
    }
  }

  for (const item of FORBIDDEN_PATTERNS) {
    if (item.pattern.test(doc)) {
      pushIssue(issues, {
        id: item.id,
        severity: 'error',
        title: item.title,
        detail: item.detail,
        fix: item.fix,
      });
    }
  }

  for (const item of BAD_MICRO_FORMATS) {
    if (item.pattern.test(doc)) {
      pushIssue(issues, {
        id: `bad-format-${item.title}`,
        severity: 'error',
        title: item.title,
        detail: item.detail,
        fix: item.fix,
      });
    }
  }

  const fenceCount = (doc.match(/```/g) ?? []).length;
  if (fenceCount % 2 !== 0) {
    pushIssue(issues, {
      id: 'unbalanced-code-fence',
      severity: 'error',
      title: '代码块围栏未闭合',
      detail: '检测到三个反引号数量为奇数，可能破坏 JSON、SQL 或 Mermaid 内容。',
      fix: '检查所有代码块，补齐成对的 ``` 围栏。',
    });
  }

  const endOfPlanIndex = doc.indexOf('### 测试工作量');
  const lastTopHeading = doc.match(/^#\s+/gm)?.length ?? 0;
  if (endOfPlanIndex >= 0 && lastTopHeading > TOP_LEVEL_HEADINGS.length) {
    pushIssue(issues, {
      id: 'too-many-top-headings',
      severity: 'error',
      title: '顶层章节数量超出模板',
      detail: 'PM2502 只允许 5 个顶层章节。',
      fix: '删除额外顶层章节，或归档到既有二级章节内。',
    });
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const infoCount = issues.filter((issue) => issue.severity === 'info').length;
  const score = Math.max(0, 100 - errorCount * 12 - warningCount * 4 - infoCount);

  return {
    passed: errorCount === 0,
    score,
    issues,
    summary: {
      errorCount,
      warningCount,
      infoCount,
    },
  };
}

export function validateTechDocContentQuality(
  markdown: string,
  input: TechDocDraftInput,
): TechDocValidationResult {
  const doc = normalizeDoc(markdown);
  const issues: TechDocIssue[] = [];
  const hasConcreteInput =
    input.requirementText.trim().length > 20
    || (input.requirementFiles ?? []).some((file) => file.content.trim().length > 20)
    || !!input.githubProject?.fullName;

  if (!doc || !hasConcreteInput) {
    return {
      passed: true,
      score: 100,
      issues: [],
      summary: { errorCount: 0, warningCount: 0, infoCount: 0 },
    };
  }

  const placeholderMatches = doc.match(/暂无|待定|待填写|不涉及|xxxxx|xxx/g) ?? [];
  if (placeholderMatches.length >= 12) {
    pushIssue(issues, {
      id: 'content-too-many-placeholders',
      severity: 'error',
      title: '内容仍以占位为主',
      detail: `检测到 ${placeholderMatches.length} 个“暂无/待定/待填写/xxx”类占位。需求明确时不能只输出模板占位。`,
      fix: '重新读取上传需求和 GitHub 项目上下文，把背景、目的、功能点、流程、接口/数据库影响、测试范围和工时填成具体内容。',
    });
  }

  const templateExampleHits = [
    '会员小程序',
    '升级礼包弹窗',
    '码包文件上传-预检',
    '/v1/code/package/execute-upload',
    '/v1/code/code-relation/validate-add',
  ].filter((text) => doc.includes(text));
  if (templateExampleHits.length > 0) {
    pushIssue(issues, {
      id: 'content-template-example-leftover',
      severity: 'error',
      title: '残留 PM2502 示例内容',
      detail: `检测到模板示例内容残留：${templateExampleHits.join('、')}。`,
      fix: '删除模板示例业务，替换为当前需求和项目中的真实模块、接口、流程和影响范围。',
    });
  }

  const requirementKeywords = extractKeywords([
    input.requirementText,
    ...(input.requirementFiles ?? []).map((file) => `${file.name}\n${file.content}`),
  ].join('\n'));
  const matchedKeywords = requirementKeywords.filter((keyword) => doc.includes(keyword));
  if (requirementKeywords.length >= 3 && matchedKeywords.length < Math.min(3, requirementKeywords.length)) {
    pushIssue(issues, {
      id: 'content-not-grounded-in-requirement',
      severity: 'error',
      title: '未充分引用需求关键信息',
      detail: `需求中可识别的关键词较多，但输出只命中 ${matchedKeywords.length} 个。`,
      fix: `至少围绕这些需求关键词展开：${requirementKeywords.slice(0, 8).join('、')}。`,
    });
  }

  const project = input.githubProject;
  if (project?.fullName && !doc.includes(project.repo) && !doc.includes(project.fullName)) {
    pushIssue(issues, {
      id: 'content-missing-selected-repo',
      severity: 'warning',
      title: '未体现所选 GitHub 项目',
      detail: `已选择 ${project.fullName}，但输出未明确引用该仓库或项目路径。`,
      fix: '在参考资料、前端设计/实现分析或影响范围中写明所选仓库和项目路径。',
    });
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const infoCount = issues.filter((issue) => issue.severity === 'info').length;
  const score = Math.max(0, 100 - errorCount * 20 - warningCount * 6 - infoCount);

  return {
    passed: errorCount === 0,
    score,
    issues,
    summary: { errorCount, warningCount, infoCount },
  };
}

function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    '需求', '文档', '项目', '功能', '生成', '技术', '分析', '模板', '需要', '进行',
    '支持', '对应', '上传', '用户', '根据', '以及', '一个', '这个',
  ]);
  const matches = text.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{3,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const raw of matches) {
    const word = raw.trim();
    if (word.length < 3 || stopwords.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([word]) => word)
    .slice(0, 12);
}

function withFallback(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function buildPm2502Draft(input: TechDocDraftInput): string {
  const projectName = withFallback(input.projectName, '待填写项目');
  const appName = withFallback(input.appName, '待填写应用');
  const moduleName = withFallback(input.moduleName, '待填写模块');
  const featureName = withFallback(input.featureName, '待填写功能');
  const requirementText = withFallback(input.requirementText, '见方案');
  const projectLinks = withFallback(input.projectLinks, '待补充');
  const uiLink = withFallback(input.uiLink, '待补充');
  const showdocLink = withFallback(input.showdocLink, 'http://showdoc.miduonet.com/web/#/item/index');
  const testCaseLink = withFallback(input.testCaseLink, '待补充');

  return PM2502_TECH_DOC_TEMPLATE
    .replace('见方案\n\n## 项目目的', `${projectName}\n\n${requirementText}\n\n## 项目目的`)
    .replace('见方案\n\n## 参考资料', `输出一份严格按 PM2502 模板排版的技术分析文档。\n\n## 参考资料`)
    .replace('+ 方案地址：', `+ 方案地址：${projectLinks}`)
    .replace('+ UI设计图：', `+ UI设计图：${uiLink}`)
    .replace('+ showdoc地址：[http://showdoc.miduonet.com/web/#/item/index](http://showdoc.miduonet.com/web/#/item/index)', `+ showdoc地址：${showdocLink}`)
    .replace('+ 测试用例：', `+ 测试用例：${testCaseLink}`)
    .replace('| 会员小程序 | 首页 | 每日任务装修 | 新增 | |', `| ${appName} | ${moduleName} | ${featureName} | 新增 | 待细化 |`)
    .replace('| | | 升级礼包弹窗 | 修改 | |', '| | | 待补充 | 修改 | 可按实际删除 |')
    .replace('| 会员小程序 | 首页 | 1. 每日任务装修<br/>2. 升级礼包弹窗 |  |', `| ${appName} | ${moduleName} | 1. ${featureName}<br/>2. 待补充 |  |`)
    .replace('1. 项目地址及开发分支\n+ 互动营销后台：[http://192.168.5.254/svn/ui/activity/admin/](http://192.168.5.254/svn/ui/activity/admin/tap-branch)trunk\n+ 会员小程序：[https://e.coding.net/miduoyanfa/bigdataengine/md-user-mp.git](https://e.coding.net/miduoyanfa/bigdataengine/md-user-mp.git)，develop分支', `1. 项目地址及开发分支\n+ ${appName}：${projectLinks}`)
    .replace('2. 升级礼包弹窗  \n升级为会员，进入小程序自动弹窗，展示对应会员礼包。弹窗封装成组件，动态传参`info`显示升级礼包数据，其中升级图标有动画效果，可以用`CSS3 animation`实现，代码xxx；', `2. ${featureName}  \n${requirementText}`)
    .replace('开发周期：待排期', '开发周期：待排期');
}

export function buildTechDocGenerationPrompt(input: TechDocDraftInput): string {
  const uploadedFiles = (input.requirementFiles ?? [])
    .filter((file) => file.content.trim())
    .map((file, index) => `### 上传需求文件 ${index + 1}：${file.name}\n${file.content.trim()}`)
    .join('\n\n');
  const github = input.githubProject;
  const projectFiles = (github?.files ?? [])
    .filter((file) => file.content.trim())
    .map((file, index) => `### 项目文件 ${index + 1}：${file.path}\n${file.content.trim()}`)
    .join('\n\n');
  const githubContext = github
    ? `- GitHub 仓库：${github.fullName}\n- GitHub 项目路径：${github.path || '/'}\n- 默认分支：${github.branch || '默认分支'}\n- 仓库链接：${github.htmlUrl || '未提供'}\n- 当前路径文件/目录摘要：\n${github.treeSummary || '暂无'}`
    : '未选择 GitHub 项目路径';

  return `你是技术分析文档格式校验与生成 Agent。请根据用户提供的功能说明和项目链接，生成一份技术分析 Markdown 文档。

硬性要求：
1. 只能输出 Markdown 正文，不要包裹代码块，不要解释过程。
2. 默认且唯一模板为 PM2502，必须严格保留模板的标题、编号、空格、表格列、括号说明、引用块、红字 HTML、<br/>。
3. 内容事实来源优先级：上传需求文件 > 用户手写需求说明 > GitHub 项目文件内容 > GitHub 目录摘要 > 表单字段。必须先读事实源再填模板。
4. 禁止只复制模板或大量写“暂无/待定/不涉及”。只有事实源确实没有的信息才允许占位。
5. 不得保留 PM2502 示例业务（会员小程序、升级礼包、码包上传、码关系等），必须替换为当前需求和当前项目的真实内容。
6. 顶层章节只能是：
${TOP_LEVEL_HEADINGS.join('\n')}
7. “# 三、项目设计”下二级标题顺序必须是：
${PROJECT_DESIGN_SECTIONS.join('\n')}
8. 技术细节必须放入模板已有栏目，不能新建 PM2502 外的顶层章节。
9. 输出前自检：项目背景/目的、项目内容表、流程设计、实现分析、影响范围、实施规划至少 6 处必须包含当前需求或 GitHub 项目的具体信息。

用户输入：
- 项目名称：${withFallback(input.projectName, '待填写')}
- 应用：${withFallback(input.appName, '待填写')}
- 模块：${withFallback(input.moduleName, '待填写')}
- 功能：${withFallback(input.featureName, '待填写')}
- 方案/项目链接：${withFallback(input.projectLinks, '待补充')}
- UI 设计图：${withFallback(input.uiLink, '待补充')}
- showdoc 地址：${withFallback(input.showdocLink, '待补充')}
- 测试用例：${withFallback(input.testCaseLink, '待补充')}

GitHub 项目上下文：
${githubContext}

功能与需求说明：
${withFallback(input.requirementText, '暂无')}

上传需求文件内容：
${uploadedFiles || '暂无'}

GitHub 项目关键文件内容：
${projectFiles || '暂无'}

PM2502 模板全文如下。它只提供格式骨架，不是内容答案；必须复制结构并替换示例/占位内容：
${PM2502_TECH_DOC_TEMPLATE}`;
}

export function buildTechDocRepairPrompt(markdown: string, issues: TechDocIssue[]): string {
  const issueText = issues
    .filter((issue) => issue.severity === 'error' || issue.severity === 'warning')
    .slice(0, 30)
    .map((issue, index) => `${index + 1}. ${issue.title}：${issue.fix}`)
    .join('\n');

  return `请修复下面技术分析文档的 PM2502 格式问题，只输出修复后的 Markdown 正文，不要解释。

必须修复的问题：
${issueText}

PM2502 模板全文：
${PM2502_TECH_DOC_TEMPLATE}

待修复文档：
${markdown}`;
}
