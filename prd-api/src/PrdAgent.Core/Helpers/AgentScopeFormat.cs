using System.Text.RegularExpressions;

namespace PrdAgent.Core.Helpers;

/// <summary>
/// Agent scope 标识（`agent.{key}:{action}`）格式规范。
///
/// 两个 Controller 都需要校验这个格式：
///   - <c>AgentApiKeysController</c> 创建 Key 时验证请求里的 scopes 数组
///   - <c>AgentOpenEndpointsController</c> 登记开放接口时验证 requiredScopes 数组
///
/// 集中到这里后，改规则（比如允许 key 更长）只要改一处，两边自然对齐。
/// 避免"endpoint 登记时通过、创建 Key 时拒绝"那种 hidden schema drift。
/// </summary>
public static class AgentScopeFormat
{
    /// <summary>
    /// 合法的 agent scope 正则。
    ///
    /// 格式：<c>agent.{agent-key}:{action}</c>
    /// - agent-key：1-64 字符，小写字母开头、只允许小写字母/数字/短横线
    /// - action：   1-32 字符，小写字母开头、只允许小写字母/数字/短横线/下划线
    /// 例：<c>agent.report-agent:call</c>、<c>agent.defect-share:read</c>。
    /// </summary>
    public static readonly Regex Pattern =
        new(@"^agent\.[a-z0-9][a-z0-9\-]{0,63}:[a-z0-9][a-z0-9\-_]{0,31}$", RegexOptions.Compiled);

    public static bool IsValid(string scope) =>
        !string.IsNullOrWhiteSpace(scope) && Pattern.IsMatch(scope);
}
