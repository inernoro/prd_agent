using MongoDB.Bson;

namespace PrdAgent.Core.DataSync;

/// <summary>
/// 导出前的出口脱敏。
///
/// 位置很关键：这一步发生在**源站**把文档写进响应之前，不是目标站收到之后再删。
/// 若放到目标站，密文已经过了网络、过了目标站的请求日志、失败重试时还会落进临时
/// 文件——「后删」删不掉这些副本。放在出口，被清空的字段从头到尾就没离开过源站。
///
/// 清空而不是移除字段：字段留着但值为空，目标站能看出「这里本来有东西、需要补」，
/// 于是同步页能列出待补清单。整个字段删掉的话，缺什么就只有人脑记得。
/// </summary>
public static class DataSyncRedactor
{
    /// <summary>
    /// 按集合的 RedactFields 就地清空敏感字段，返回被清空的字段名。
    ///
    /// 只认白名单里登记的那个集合的字段表：调用方传错集合名时不脱敏、直接抛，
    /// 而不是「没匹配上就原样放行」——后者会让一次拼写错误变成一次密钥泄漏。
    /// </summary>
    public static IReadOnlyList<string> Redact(BsonDocument document, DataSyncCollection collection)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(collection);
        if (collection.RedactFields.Count == 0) return Array.Empty<string>();

        var cleared = new List<string>();
        foreach (var field in collection.RedactFields)
        {
            if (!document.Contains(field)) continue;
            var current = document[field];
            // 本来就是空的不算「被清空」，否则待补清单会把从来没配过的字段也列进去。
            if (current.IsBsonNull || (current.IsString && current.AsString.Length == 0)) continue;
            document[field] = BsonString.Empty;
            cleared.Add(field);
        }
        return cleared;
    }

    /// <summary>
    /// 给同步过来的用户打上「必须重设密码」。
    ///
    /// 口令散列已经在出口被清空，所以这些账号**本来就登不进来**（散列为空，校验必然
    /// 不通过）——这个标志不是为了拦截登录，是为了让状态可读：管理员在用户列表上
    /// 一眼看出这批账号在等重设，而不是面对一群「看着正常、就是登不上」的用户。
    /// 标志本身是既有字段，`AuthController` 登录响应会原样带给前端。
    /// </summary>
    public static void MarkUserNeedsPasswordReset(BsonDocument userDocument)
    {
        ArgumentNullException.ThrowIfNull(userDocument);
        userDocument["MustResetPassword"] = true;
    }
}
