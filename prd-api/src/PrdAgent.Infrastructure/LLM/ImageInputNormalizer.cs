using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// 生图参考图的格式权威来自实际内容，不来自文件名、data URI 或对象存储的声明。
/// 只校验和规范化元数据，不重新编码，避免损失画质、透明度或动画帧。
/// </summary>
internal static class ImageInputNormalizer
{
    // 与资产上传上限一致；先限制字节和像素，再解码，防止压缩图片耗尽内存。
    internal const int MaxBytes = 15 * 1024 * 1024;
    internal const long MaxPixels = 64 * 1024 * 1024;
    internal const string ErrorCode = "IMAGE_INPUT_INVALID";
    internal const string ErrorMessage = "参考图无法读取或格式不受支持，请重新上传有效的 JPEG、PNG、WebP 或 GIF 图片。";

    internal sealed record Input(byte[] Bytes, string MimeType, string Extension)
    {
        internal string DataUri => $"data:{MimeType};base64,{Convert.ToBase64String(Bytes)}";
        internal string FileName(string stem) => $"{stem}.{Extension}";
    }

    internal static Input Read(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) throw new ImageInputException();
        var raw = value.Trim();
        if (raw.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var comma = raw.IndexOf(',');
            if (comma < 0 || !raw[..comma].EndsWith(";base64", StringComparison.OrdinalIgnoreCase))
                throw new ImageInputException();
            raw = raw[(comma + 1)..];
        }
        if (raw.Length > ((MaxBytes + 2) / 3) * 4)
            throw new ImageInputException("参考图文件过大，请压缩至 15MB 以内后重新上传。");
        try
        {
            return Read(Convert.FromBase64String(raw));
        }
        catch (FormatException)
        {
            throw new ImageInputException();
        }
    }

    internal static Input Read(byte[] bytes)
    {
        if (bytes is null || bytes.Length == 0) throw new ImageInputException();
        if (bytes.Length > MaxBytes)
            throw new ImageInputException("参考图文件过大，请压缩至 15MB 以内后重新上传。");
        try
        {
            var options = new DecoderOptions { MaxFrames = 1, SkipMetadata = true };
            var info = Image.Identify(options, bytes);
            if (info.Width <= 0 || info.Height <= 0 || (long)info.Width * info.Height > MaxPixels)
                throw new ImageInputException("参考图像素尺寸过大，请缩小图片后重新上传。");
            var mime = info.Metadata.DecodedImageFormat?.DefaultMimeType;
            var extension = mime switch
            {
                "image/jpeg" => "jpg",
                "image/png" => "png",
                "image/webp" => "webp",
                "image/gif" => "gif",
                _ => throw new ImageInputException(),
            };
            // Identify 只读头部；实际解码阻止伪造文件头或损坏图继续消耗上游调用。
            using var decoded = Image.Load(options, bytes);
            return new Input(bytes, mime!, extension);
        }
        catch (Exception ex) when (ex is UnknownImageFormatException or InvalidImageContentException or NotSupportedException)
        {
            throw new ImageInputException();
        }
    }
}

internal sealed class ImageInputException(string message = ImageInputNormalizer.ErrorMessage) : Exception(message);
