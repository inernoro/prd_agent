using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 开场问题自动生成：读一遍站点自己的正文，写出访客最可能问的几句，落成站点题库。
///
/// 存在的理由是「上传者什么都不用配」——他点完上传就能走人，题库几秒后自己到位，
/// 从头到尾没被要求做任何配置（minimal-user-input：系统查得到的值不该摆成输入框）。
/// </summary>
public interface IAskOpeningQuestionGenerator
{
    /// <summary>
    /// 排一次生成，**立刻返回**。
    ///
    /// 调用方全都在请求路径上（开启提问、重新上传、访客打开分享页），一次模型调用几秒钟，
    /// 挂在那儿等就是把成本转嫁给正在等页面的人。所以这里只入队：同一个站点同时只跑一次，
    /// 失败只记日志、不冒泡——题库是增值，没有它提问照样能用。
    /// </summary>
    void QueueEnsure(HostedSite site);

    /// <summary>
    /// 同步跑一次并返回结果（true = 这次真的写了新题库）。给测试与手动「重新生成」用。
    /// </summary>
    Task<bool> EnsureAsync(string siteId, CancellationToken ct = default);
}
