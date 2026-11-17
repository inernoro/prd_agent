using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Net.Http.Headers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;

namespace PrdAgent.Api.Services.Channels;

/// <summary>
/// SendGrid Inbound Parse security policy verification. Verify bytes, never decoded form values.
/// https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks
/// </summary>
public static class SendGridInboundAuthentication
{
    public const string SignatureHeader = "X-Twilio-Email-Event-Webhook-Signature";
    public const string TimestampHeader = "X-Twilio-Email-Event-Webhook-Timestamp";
    public const int MaxBodyBytes = 32 * 1024 * 1024;
    public sealed record VerifiedRequest(string Recipient, string OwnerUserId, string BodyHash);

    public static async Task<VerifiedRequest?> ValidateAsync(
        HttpRequest request, IConfiguration configuration, CancellationToken ct, DateTimeOffset? now = null)
    {
        var settings = configuration.GetSection("Channels:Email:SendGrid");
        // Deliberately do not fall back to the old Event WebhookSigningKey setting.
        var publicKey = settings["ParsePublicKey"];
        var recipient = settings["Recipient"]?.Trim().ToLowerInvariant();
        var owner = settings["OwnerUserId"]?.Trim();
        if (string.IsNullOrWhiteSpace(publicKey) || string.IsNullOrWhiteSpace(recipient)
            || string.IsNullOrWhiteSpace(owner)) return null;
        if (request.Headers[SignatureHeader].Count != 1 || request.Headers[TimestampHeader].Count != 1)
            return null;
        var timestamp = request.Headers[TimestampHeader].ToString();
        if (timestamp.Length is < 1 or > 12 || timestamp.Any(c => c < '0' || c > '9')
            || !long.TryParse(timestamp, NumberStyles.None, CultureInfo.InvariantCulture, out var seconds)
            || Math.Abs((now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds() - seconds) > 300)
            return null;
        if (request.ContentLength > MaxBodyBytes || !request.HasFormContentType) return null;
        if (!MediaTypeHeaderValue.TryParse(request.ContentType, out var contentType)) return null;
        // The HTTP charset is not signed either; URL-encoded Parse fields use UTF-8.
        var charset = HeaderUtilities.RemoveQuotes(contentType.Charset).Value;
        if (!string.IsNullOrEmpty(charset) && !charset.Equals("utf-8", StringComparison.OrdinalIgnoreCase))
            return null;
        byte[]? openingBoundary = null;
        if (contentType.MediaType.Equals("multipart/form-data", StringComparison.OrdinalIgnoreCase))
        {
            var boundary = HeaderUtilities.RemoveQuotes(contentType.Boundary).Value;
            if (string.IsNullOrEmpty(boundary) || boundary.Length > 128) return null;
            openingBoundary = Encoding.ASCII.GetBytes("--" + boundary + "\r\n");
        }

        try
        {
            using var key = ECDsa.Create();
            var keyBytes = Convert.FromBase64String(publicKey);
            key.ImportSubjectPublicKeyInfo(keyBytes, out var read);
            if (read != keyBytes.Length || key.KeySize != 256) return null;
            var signature = Convert.FromBase64String(request.Headers[SignatureHeader].ToString());
            request.EnableBuffering(bufferThreshold: 64 * 1024, bufferLimit: MaxBodyBytes);
            request.Body.Position = 0;
            using var signedHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using var bodyHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            signedHash.AppendData(Encoding.ASCII.GetBytes(timestamp));
            var buffer = new byte[64 * 1024];
            var total = 0;
            using var prefix = new MemoryStream();
            int count;
            while ((count = await request.Body.ReadAsync(buffer, ct)) > 0)
            {
                if (prefix.Length < 132)
                    prefix.Write(buffer, 0, Math.Min(count, 132 - (int)prefix.Length));
                total += count;
                if (total > MaxBodyBytes) return null;
                signedHash.AppendData(buffer, 0, count);
                bodyHash.AppendData(buffer, 0, count);
            }
            // Content-Type is not signed. Bind its boundary to the signed opening delimiter
            // so an unsigned header cannot select a different subsection of the multipart body.
            var firstBytes = prefix.ToArray();
            if (openingBoundary != null && !firstBytes.AsSpan().StartsWith(openingBoundary)) return null;
            if (openingBoundary == null && firstBytes.AsSpan().StartsWith("--"u8)) return null;
            if (!key.VerifyHash(signedHash.GetHashAndReset(), signature, DSASignatureFormat.Rfc3279DerSequence))
                return null;
            return new VerifiedRequest(recipient, owner, Convert.ToHexString(bodyHash.GetHashAndReset()));
        }
        catch (Exception ex) when (ex is FormatException or CryptographicException or IOException or ArgumentException)
        {
            return null;
        }
        finally
        {
            if (request.Body.CanSeek) request.Body.Position = 0;
        }
    }
}

/// <summary>Prevent MVC value providers from consuming multipart data before authentication.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class VerifyRawEmailBodyAttribute : Attribute, IResourceFilter
{
    public void OnResourceExecuting(ResourceExecutingContext context)
    {
        for (var i = context.ValueProviderFactories.Count - 1; i >= 0; i--)
            if (context.ValueProviderFactories[i] is FormValueProviderFactory
                or FormFileValueProviderFactory or JQueryFormValueProviderFactory)
                context.ValueProviderFactories.RemoveAt(i);
    }

    public void OnResourceExecuted(ResourceExecutedContext context) { }
}
