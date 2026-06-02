using PrdAgent.Infrastructure.Services.CcasAgent;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// CcasSqlAiPrompts 系统提示词组装回归测试。
///
/// 目的：每次有人改 prompt 模板 / 增加方言 / 调整关联模式时，
/// 用真断言守住"schema 真的注入了""关联模式真的描述了""字段名出现了"
/// 这三个关键事实，避免静默回退。
/// </summary>
public class CcasSqlAiPromptsTests
{
    [Fact]
    public void ChenzhiMssql_FourLevel_InjectsTableNameAndBagBoxCodeFields()
    {
        var sp = CcasSqlAiPrompts.BuildSystemPrompt(
            CcasSqlAiPrompts.Dialects.ChenzhiMssql,
            CcasSqlAiPrompts.AssociationModes.BottlePackBoxStack);

        Assert.Contains("陈智版", sp);
        Assert.Contains("[TkCode].[dbo].[T_Code]", sp);
        Assert.Contains("BagCode", sp);
        Assert.Contains("BoxCode", sp);
        Assert.Contains("WITH(NOLOCK)", sp);
        Assert.Contains("瓶盒箱垛", sp);
        Assert.Contains("4 级", sp);
        Assert.DoesNotContain("coderelationupload", sp);
    }

    [Fact]
    public void ChenzhiMssql_TwoLevel_DescribesNoNestedSubquery()
    {
        var sp = CcasSqlAiPrompts.BuildSystemPrompt(
            CcasSqlAiPrompts.Dialects.ChenzhiMssql,
            CcasSqlAiPrompts.AssociationModes.BottlePack);

        Assert.Contains("瓶盒", sp);
        Assert.Contains("2 级", sp);
        Assert.Contains("不需要嵌套子查询", sp);
    }

    [Fact]
    public void MiduoMysql_InjectsFlatFieldsAndBacktick()
    {
        var sp = CcasSqlAiPrompts.BuildSystemPrompt(
            CcasSqlAiPrompts.Dialects.MiduoMysql,
            null);

        Assert.Contains("米多版", sp);
        Assert.Contains("coderelationupload", sp);
        Assert.Contains("SmallSerialNumber", sp);
        Assert.Contains("MediumSerialNumber", sp);
        Assert.Contains("BigSerialNumber", sp);
        Assert.Contains("VirtualSerialNumber", sp);
        Assert.Contains("MySQL", sp);
        Assert.Contains("反引号", sp);
        Assert.DoesNotContain("BagCode", sp);
    }

    [Fact]
    public void MiduoMssql_InjectsFlatFieldsButSqlServerSyntaxHints()
    {
        var sp = CcasSqlAiPrompts.BuildSystemPrompt(
            CcasSqlAiPrompts.Dialects.MiduoMssql,
            null);

        Assert.Contains("米多版", sp);
        Assert.Contains("coderelationupload", sp);
        Assert.Contains("SQL Server", sp);
        Assert.Contains("方括号", sp);
        Assert.Contains("TOP N", sp);
    }

    [Fact]
    public void UnknownDialect_IncludesBothSchemasAndAsksForConfirmation()
    {
        var sp = CcasSqlAiPrompts.BuildSystemPrompt("unknown-dialect-key", null);

        Assert.Contains("用户未指定数据库版本", sp);
        Assert.Contains("[TkCode].[dbo].[T_Code]", sp);
        Assert.Contains("coderelationupload", sp);
    }

    [Fact]
    public void OutputContract_AlwaysIncludesSafetyRules()
    {
        var sp = CcasSqlAiPrompts.BuildSystemPrompt(
            CcasSqlAiPrompts.Dialects.ChenzhiMssql,
            CcasSqlAiPrompts.AssociationModes.BottlePackBoxStack);

        Assert.Contains("```sql", sp);
        Assert.Contains("DELETE", sp);
        Assert.Contains("UPDATE", sp);
        Assert.Contains("先 SELECT", sp);
        Assert.Contains("字段名严格白名单", sp);
        Assert.Contains("禁止编造", sp);
        Assert.Contains("不要尝试执行 SQL", sp);
    }

    [Fact]
    public void ChenzhiMssql_UnspecifiedMode_AsksForConfirmation()
    {
        var sp = CcasSqlAiPrompts.BuildSystemPrompt(
            CcasSqlAiPrompts.Dialects.ChenzhiMssql,
            CcasSqlAiPrompts.AssociationModes.Unspecified);

        Assert.Contains("用户未指定关联模式", sp);
        Assert.Contains("先用一句话向用户确认", sp);
    }

    [Fact]
    public void BuildRedactedTag_IncludesDialectAndMode()
    {
        var tag = CcasSqlAiPrompts.BuildRedactedTag(
            CcasSqlAiPrompts.Dialects.MiduoMysql,
            null);
        Assert.Contains("CCAS_SQL_AI", tag);
        Assert.Contains("miduo-mysql", tag);
        Assert.Contains("auto", tag);
    }

    [Fact]
    public void DialectLabels_CoverAllPublicDialectConstants()
    {
        Assert.True(CcasSqlAiPrompts.DialectLabels.ContainsKey(CcasSqlAiPrompts.Dialects.ChenzhiMssql));
        Assert.True(CcasSqlAiPrompts.DialectLabels.ContainsKey(CcasSqlAiPrompts.Dialects.MiduoMysql));
        Assert.True(CcasSqlAiPrompts.DialectLabels.ContainsKey(CcasSqlAiPrompts.Dialects.MiduoMssql));
    }

    [Fact]
    public void AssociationLabels_CoverAllPublicModeConstants()
    {
        Assert.True(CcasSqlAiPrompts.AssociationLabels.ContainsKey(CcasSqlAiPrompts.AssociationModes.BottlePack));
        Assert.True(CcasSqlAiPrompts.AssociationLabels.ContainsKey(CcasSqlAiPrompts.AssociationModes.BottlePackBox));
        Assert.True(CcasSqlAiPrompts.AssociationLabels.ContainsKey(CcasSqlAiPrompts.AssociationModes.BottlePackBoxStack));
        Assert.True(CcasSqlAiPrompts.AssociationLabels.ContainsKey(CcasSqlAiPrompts.AssociationModes.Unspecified));
    }
}
