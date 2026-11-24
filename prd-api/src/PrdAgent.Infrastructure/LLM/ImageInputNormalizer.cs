using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;
using SixLabors.ImageSharp.PixelFormats;

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
    internal const int MaxMaskDimension = 4096;
    internal const string ErrorCode = "IMAGE_INPUT_INVALID";
    internal const string ErrorMessage = "参考图无法读取或格式不受支持，请重新上传有效的 JPEG、PNG、WebP 或 GIF 图片。";

    internal sealed record Input(byte[] Bytes, string MimeType, string Extension)
    {
        internal string DataUri => $"data:{MimeType};base64,{Convert.ToBase64String(Bytes)}";
        internal string FileName(string stem) => $"{stem}.{Extension}";
    }

    internal static Input Read(string? value) => Read(value, forMask: false);

    internal static Input Read(string? value, bool forMask)
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
            return Read(Convert.FromBase64String(raw), forMask);
        }
        catch (FormatException)
        {
            throw new ImageInputException();
        }
    }

    /// <summary>业务黑白蒙版的白色代表重绘；OpenAI edits 使用透明像素代表重绘。</summary>
    internal static Input ToOpenAiMask(Input input)
    {
        var options = new DecoderOptions { MaxFrames = 1, SkipMetadata = true };
        var info = Image.Identify(options, input.Bytes);
        ValidateMaskDimensions(info.Width, info.Height);
        using var image = Image.Load<Rgba32>(options, input.Bytes);
        // 已经是供应商原生透明蒙版时保留原字节和透明度，不反转第二次。
        for (var y = 0; y < image.Height; y++)
            for (var x = 0; x < image.Width; x++)
                if (image[x, y].A < 255) return input;

        for (var y = 0; y < image.Height; y++)
            for (var x = 0; x < image.Width; x++)
            {
                var pixel = image[x, y];
                if (pixel.R != pixel.G || pixel.G != pixel.B)
                    throw new ImageInputException("蒙版应为黑白图片或带透明区域的 PNG，请重新绘制蒙版。");
                image[x, y] = new Rgba32(0, 0, 0, (byte)(255 - pixel.R));
            }
        using var output = new MaskEncodingStream(MaxBytes);
        image.SaveAsPng(output);
        return new Input(output.ToArray(), "image/png", "png");
    }

    internal static Input Read(byte[] bytes) => Read(bytes, forMask: false);

    internal static Input Read(byte[] bytes, bool forMask)
    {
        if (bytes is null || bytes.Length == 0) throw new ImageInputException();
        if (bytes.Length > MaxBytes)
            throw new ImageInputException("参考图文件过大，请压缩至 15MB 以内后重新上传。");
        try
        {
            var options = new DecoderOptions { MaxFrames = 1, SkipMetadata = true };
            var info = Image.Identify(options, bytes);
            if (forMask) ValidateMaskDimensions(info.Width, info.Height);
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

    private static void ValidateMaskDimensions(int width, int height)
    {
        if (width <= 0 || height <= 0 || width > MaxMaskDimension || height > MaxMaskDimension)
            throw new ImageInputException("蒙版尺寸过大，请将图片宽高缩小至 4096 像素以内后重新绘制蒙版。");
    }

    // 编码器写入前检查长度并限制扩容，不能先生成大 PNG 再检查 ToArray 的结果。
    internal sealed class MaskEncodingStream(int maxBytes) : MemoryStream
    {
        private void EnsureBoundedLength(long length)
        {
            if (length > maxBytes)
                throw new ImageInputException("蒙版转换后的文件超过 15MB，请缩小图片后重新绘制蒙版。");
            if (length > Capacity)
                Capacity = (int)Math.Min(maxBytes, Math.Max(length, Math.Max(256L, (long)Capacity * 2)));
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            EnsureBoundedLength(Math.Max(Length, Position + count));
            base.Write(buffer, offset, count);
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            EnsureBoundedLength(Math.Max(Length, Position + buffer.Length));
            base.Write(buffer);
        }

        public override void WriteByte(byte value)
        {
            EnsureBoundedLength(Math.Max(Length, Position + 1));
            base.WriteByte(value);
        }

        public override void SetLength(long value)
        {
            EnsureBoundedLength(value);
            base.SetLength(value);
        }
    }
}

internal sealed class ImageInputException(string message = ImageInputNormalizer.ErrorMessage) : Exception(message);
