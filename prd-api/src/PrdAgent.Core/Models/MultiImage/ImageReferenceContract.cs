namespace PrdAgent.Core.Models.MultiImage;

/// <summary>
/// 参考图数量契约。
///
/// ExpectedCount 表示用户在入口明确选择的图片数量，SubmittedCount 表示真正进入结构化
/// ImageRefs（或单图兼容字段）的数量。两者不一致时必须拒绝请求，不能把缺图请求继续当作
/// 文生图或少图请求执行。
/// </summary>
public static class ImageReferenceContract
{
    public const string InvalidCountCode = "IMAGE_REF_COUNT_INVALID";
    public const string IncompleteCode = "IMAGE_REF_INCOMPLETE";

    public static ImageReferenceValidation Validate(int? expectedCount, int submittedCount, bool hasMask = false)
    {
        if (expectedCount is < 0 || submittedCount < 0)
        {
            return new ImageReferenceValidation(false, InvalidCountCode, expectedCount ?? 0, submittedCount);
        }

        var effectiveExpected = expectedCount ?? submittedCount;
        if (hasMask && effectiveExpected == 0) effectiveExpected = 1;

        return effectiveExpected == submittedCount
            ? new ImageReferenceValidation(true, null, effectiveExpected, submittedCount)
            : new ImageReferenceValidation(false, IncompleteCode, effectiveExpected, submittedCount);
    }
}

public readonly record struct ImageReferenceValidation(
    bool IsValid,
    string? ErrorCode,
    int ExpectedCount,
    int SubmittedCount);
