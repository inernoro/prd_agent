using Xunit;

namespace PrdAgent.Tests;

public sealed class DeploymentStorageProviderContractTests
{
    [Fact]
    public void DeploymentFiles_ShouldKeepStorageProvidersSeparatedByEnvironment()
    {
        var localDevelopment = ReadRepoFile("docker-compose.dev.yml");
        var cdsRoot = ReadRepoFile("cds-compose.yml");
        var cdsNested = ReadRepoFile("cds/cds-compose.yaml");
        var production = ReadRepoFile("docker-compose.yml");

        Assert.Contains("ASSETS_PROVIDER=${ASSETS_PROVIDER:-local}", localDevelopment);
        Assert.Contains(
            "ASSETS_EXPECTED_PROVIDER=${ASSETS_EXPECTED_PROVIDER:-${ASSETS_PROVIDER:-local}}",
            localDevelopment);
        Assert.Contains("ASSETS_LOCAL_DIR=${ASSETS_LOCAL_DIR:-/tmp/prdagent-assets}", localDevelopment);
        Assert.Contains(
            "AssetStorageReadiness__PublicBaseUrl=${ASSET_STORAGE_READINESS_PUBLIC_BASE_URL:-http://web}",
            localDevelopment);
        Assert.Contains("location ^~ /local-assets/", ReadRepoFile("deploy/nginx/nginx.conf"));
        Assert.DoesNotContain("ASSETS_PROVIDER=${ASSETS_PROVIDER:-tencentCos}", localDevelopment);

        Assert.Contains("ASSETS_PROVIDER: cloudflareR2", cdsRoot);
        Assert.Contains("ASSETS_EXPECTED_PROVIDER: cloudflareR2", cdsRoot);
        Assert.Contains("cds.readiness-path: \"/health/ready\"", cdsRoot);
        Assert.DoesNotContain("TENCENT_COS_", cdsRoot);
        Assert.DoesNotContain("ASSETS_PROVIDER: tencentCos", cdsRoot);

        Assert.Contains("ASSETS_PROVIDER: \"cloudflareR2\"", cdsNested);
        Assert.Contains("ASSETS_EXPECTED_PROVIDER: \"cloudflareR2\"", cdsNested);
        Assert.DoesNotContain("TENCENT_COS_", cdsNested);
        Assert.DoesNotContain("ASSETS_PROVIDER: \"tencentCos\"", cdsNested);

        Assert.Contains("ASSETS_PROVIDER=tencentCos", production);
        Assert.Contains("ASSETS_EXPECTED_PROVIDER=tencentCos", production);
        Assert.DoesNotContain("ASSETS_PROVIDER=${ASSETS_PROVIDER:-", production);
        Assert.DoesNotContain("ASSETS_PROVIDER=cloudflareR2", production);
        Assert.DoesNotContain("R2_", production);
    }

    [Fact]
    public void ApplicationDefaults_ShouldNotSilentlyTreatUnknownEnvironmentAsTencentCos()
    {
        var files = new[]
        {
            "prd-api/src/PrdAgent.Api/Services/AvatarUrlBuilder.cs",
            "prd-api/src/PrdAgent.Api/Controllers/Api/AuthzController.cs",
            "prd-api/src/PrdAgent.Api/Controllers/Api/StorageSyncController.cs",
            "prd-api/src/PrdAgent.Infrastructure/Services/WatermarkFontRegistry.cs",
            "prd-api/src/PrdAgent.Api/appsettings.json",
            "prd-api/src/PrdAgent.Api/appsettings.Development.json",
        };

        foreach (var file in files)
        {
            var source = ReadRepoFile(file);
            Assert.DoesNotContain("?? \"tencentCos\"", source);
            Assert.DoesNotContain("\"Provider\": \"tencentCos\"", source);
        }
    }

    private static string ReadRepoFile(string relativePath)
    {
        var root = LocateRepoRoot();
        var fullPath = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(fullPath), $"找不到部署文件: {fullPath}");
        return File.ReadAllText(fullPath);
    }

    private static string LocateRepoRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "AGENTS.md"))
                && Directory.Exists(Path.Combine(directory.FullName, "prd-api")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("无法定位仓库根目录");
    }
}
