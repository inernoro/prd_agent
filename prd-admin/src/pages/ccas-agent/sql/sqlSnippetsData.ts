/**
 * CCAS SQL 常用语句预设数据。
 *
 * 这里只放"内置 / 团队公认"的 SQL 片段，纯前端常量，无后端依赖。
 *
 * 后续扩展指南：
 *   - 加新片段：在对应分组的 `snippets` 数组追加一项
 *   - 加新分组：在 `SQL_SNIPPET_GROUPS` 数组追加一项（id 唯一）
 *   - 暂不计划持久化用户自定义；如果未来要做"用户片段"，
 *     再走后端 collection，禁止落 localStorage（CLAUDE.md 强制规则）。
 */

export type SqlDialect = 'mssql' | 'mysql' | 'mssql+mysql';

export interface SqlSnippet {
  id: string;
  title: string;
  /** 业务场景 / 适用条件说明（可选） */
  note?: string;
  /** 数据库方言，用于卡片右上角徽章 */
  dialect: SqlDialect;
  sql: string;
}

export interface SqlSnippetGroup {
  id: string;
  /** 分组显示名 */
  name: string;
  /** 分组说明（一句话） */
  description?: string;
  snippets: SqlSnippet[];
}

export const DIALECT_LABEL: Record<SqlDialect, string> = {
  mssql: 'SQL Server',
  mysql: 'MySQL',
  'mssql+mysql': 'SQL Server / MySQL',
};

/**
 * 内置预设：陈智版 + 米多版两套数据库的常用排查语句。
 *
 * 关键术语对照（保留原文以便业务方搜索）：
 *   - 陈智版：BagCode = 小标 / BoxCode = 中标；BagCode = 中标 / BoxCode = 大标；BagCode = 大标 / BoxCode = 虚拟垛标
 *   - 米多版：层级拍平 —— SmallSerialNumber 小标 / MediumSerialNumber 中标 / BigSerialNumber 大标 / VirtualSerialNumber 虚拟垛标
 */
export const SQL_SNIPPET_GROUPS: SqlSnippetGroup[] = [
  {
    id: 'chenzhi',
    name: '陈智版数据库',
    description:
      '使用 SQL Server。BagCode/BoxCode 嵌套使用：BagCode=小标，BoxCode=中标；BagCode=中标，BoxCode=大标；BagCode=大标，BoxCode=虚拟垛标',
    snippets: [
      {
        id: 'chenzhi-nested-lookup',
        title: '套标查询',
        dialect: 'mssql',
        note: '通过中标 BoxCode 找出下面挂的所有小标记录',
        sql: `select * from [TkCode].[dbo].[T_Code] where BoxCode in (SELECT BagCode
  FROM [TkCode].[dbo].[T_Code] where  BoxCode='11090700161100')`,
      },
      {
        id: 'chenzhi-duplicate-box',
        title: '重复箱码',
        dialect: 'mssql',
        note: '找出 8 位箱码且关联超过 4 个盒码的异常箱',
        sql: `SELECT BoxCode as 箱码,
       COUNT(1) AS 盒数,
       MIN(BagTime) AS 最早采集时间,
       MAX(BagTime) AS 最晚采集时间
FROM [TkCode].[dbo].[T_Code] WITH(NOLOCK)
WHERE LEN(BoxCode) = 8
GROUP BY BoxCode
HAVING COUNT(1) > 4`,
      },
    ],
  },
  {
    id: 'miduo',
    name: '米多版数据库',
    description:
      '新版采集软件主要使用 MySQL，特殊/兼容使用 SQL Server。层级拍平：SmallSerialNumber 小标 / MediumSerialNumber 中标 / BigSerialNumber 大标 / VirtualSerialNumber 虚拟垛标。MySQL：石湾 2 号机；SQL Server：致美斋。',
    snippets: [
      {
        id: 'miduo-relation-list',
        title: '码关系查询',
        dialect: 'mysql',
        sql: 'SELECT * FROM `coderelationupload`',
      },
      {
        id: 'miduo-relation-reset',
        title: '码关系重置',
        dialect: 'mysql',
        note: '石湾场景：瓶盒采集时没有导入码包，提示 xx 不在码包范围内。先查 Status 再按需重置，避免一刀切。',
        sql: `-- 先查有问题的数据，看 Msg 和 Status。4=待剔除、5=重码
SELECT * FROM \`coderelationupload\` WHERE \`Status\` in (4,5)

-- 再重置状态，可以重新过龙门架。Status 按实际状态调整，避免全部重置
UPDATE coderelationupload SET \`Status\`=0 WHERE \`Status\` in (4,5) and msg='xx'`,
      },
    ],
  },
];

/** 计算预设总条数（用于子 tab 标签的角标） */
export const SQL_SNIPPET_TOTAL = SQL_SNIPPET_GROUPS.reduce(
  (acc, g) => acc + g.snippets.length,
  0
);
