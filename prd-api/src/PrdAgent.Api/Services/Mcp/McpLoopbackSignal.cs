using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.Api.Services.Mcp;

/// <summary>
/// 网关回环续跳的自证凭据。
///
/// 网关执行一次 tools/call 时会回环 HTTP 打自己的真实接口（复用同一把 sk-ak）。这一跳在下游
/// 看来和「外部客户端直连」长得一模一样，于是两件事会算错：
///   - 用量闸门：直连要计一次，网关续跳不能再计一次（网关那边已经占过坑），否则一次调用扣两回
///   - 全局限流：续跳的对端恒为 127.0.0.1，所有密钥会挤进同一个 IP 桶，一把密钥刷满就把别人一起挡了
///
/// 判据不用「对端是不是回环地址」——那要求我们信任网络拓扑（今天 nginx 走 http://api:8080，
/// 明天换个部署形态就未必）。改用一个**每进程随机生成、只存在于内存**的令牌：外部无从得知，
/// 比拓扑判断硬，且不依赖任何配置。
/// </summary>
public sealed class McpLoopbackSignal
{
    /// <summary>续跳标记头。值是本进程的令牌，只有我们自己填得出来。</summary>
    public const string HeaderName = "X-Map-Mcp-Loopback";

    private readonly byte[] _tokenBytes;

    /// <summary>本进程的令牌。仅用于回环续跳，不落库、不外发。</summary>
    public string Token { get; }

    public McpLoopbackSignal()
    {
        Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        _tokenBytes = Encoding.ASCII.GetBytes(Token);
    }

    /// <summary>这个请求是不是本进程网关自己发起的回环续跳。</summary>
    public bool IsGatewayContinuation(HttpRequest request)
    {
        var given = request.Headers[HeaderName].ToString();
        if (string.IsNullOrEmpty(given)) return false;
        // 定长比较：令牌是进程内秘密，不给计时侧信道留口子
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(given), _tokenBytes);
    }
}
