using System.IO;
using System.Text.Json;

namespace AgentToolsControlCenter.Services;

public sealed record SkillImprovementActionResult(bool Succeeded, string? Error = null, string? ConfirmToken = null);

public sealed class SkillImprovementService : SkillImprovementCollector
{
    private readonly string _gatewayRoot;
    private readonly CommandRunner _runner = new();

    public SkillImprovementService(string agentToolsRoot) : base(agentToolsRoot)
    {
        _gatewayRoot = Path.Combine(agentToolsRoot, "agenttools-mcp-gateway");
    }

    public async Task<SkillImprovementActionResult> ApproveAsync(string id, CancellationToken cancellationToken = default)
        => await RunGatewayActionAsync(["skill", "approve", "--id", id, "--approvedBy", "control-center"], cancellationToken);

    public async Task<SkillImprovementActionResult> RejectAsync(string id, CancellationToken cancellationToken = default)
        => await RunGatewayActionAsync(["skill", "reject", "--id", id, "--rejectedBy", "control-center"], cancellationToken);

    public async Task<SkillImprovementActionResult> PrepareApplyAsync(string id, CancellationToken cancellationToken = default)
        => await RunGatewayActionAsync(
            ["skill", "apply", "--id", id, "--userExplicitlyRequested", "true"],
            cancellationToken,
            expectConfirmation: true);

    public async Task<SkillImprovementActionResult> ApplyAsync(string id, string confirmToken, CancellationToken cancellationToken = default)
        => await RunGatewayActionAsync(
            ["skill", "apply", "--id", id, "--userExplicitlyRequested", "true", "--confirmToken", confirmToken],
            cancellationToken);

    private async Task<SkillImprovementActionResult> RunGatewayActionAsync(
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken,
        bool expectConfirmation = false)
    {
        var cli = Path.Combine(_gatewayRoot, "src", "cli.js");
        var processArgs = new List<string> { cli };
        processArgs.AddRange(arguments);
        var result = await _runner.RunAsync(
            "node.exe",
            processArgs,
            _gatewayRoot,
            TimeSpan.FromSeconds(20),
            cancellationToken);

        if (result.TimedOut) return new SkillImprovementActionResult(false, "Gateway操作がタイムアウトしました。");
        if (string.IsNullOrWhiteSpace(result.StandardOutput))
        {
            return new SkillImprovementActionResult(false,
                string.IsNullOrWhiteSpace(result.StandardError) ? "Gatewayから応答がありません。" : result.StandardError.Trim());
        }

        try
        {
            using var json = JsonDocument.Parse(result.StandardOutput);
            var root = json.RootElement;
            var ok = ReadBool(root, "ok") == true;
            var error = ReadString(root, "error");
            var token = ReadString(root, "confirmToken");
            if (expectConfirmation)
            {
                var requiresConfirmation = ReadBool(root, "requiresConfirmation") == true;
                if (!ok || !requiresConfirmation || string.IsNullOrWhiteSpace(token))
                {
                    return new SkillImprovementActionResult(false, error ?? "適用確認トークンを取得できませんでした。");
                }
                return new SkillImprovementActionResult(true, null, token);
            }

            return ok
                ? new SkillImprovementActionResult(true)
                : new SkillImprovementActionResult(false, error ?? "Skill改善操作に失敗しました。");
        }
        catch (JsonException)
        {
            return new SkillImprovementActionResult(false, "Gateway応答を解析できませんでした。");
        }
    }

    private static string? ReadString(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static bool? ReadBool(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean()
            : null;
    }
}
