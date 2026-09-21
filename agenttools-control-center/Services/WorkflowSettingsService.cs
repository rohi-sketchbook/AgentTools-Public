using System.IO;
using System.Text.Json;

namespace AgentToolsControlCenter.Services;

public sealed record ContinuationModeInfo(string Mode, bool Enabled, string Description, string? Model, string? Thinking);

public sealed class WorkflowSettingsService
{
    private readonly string _gatewayRoot;
    private readonly CommandRunner _runner = new();

    public WorkflowSettingsService(string agentToolsRoot)
    {
        _gatewayRoot = Path.Combine(agentToolsRoot, "agenttools-mcp-gateway");
    }

    public Task<ContinuationModeInfo> GetContinuationModeAsync(CancellationToken cancellationToken = default)
        => RunContinuationCommandAsync(null, cancellationToken);

    public Task<ContinuationModeInfo> SetContinuationModeAsync(string mode, CancellationToken cancellationToken = default)
        => RunContinuationCommandAsync(mode, cancellationToken);

    private async Task<ContinuationModeInfo> RunContinuationCommandAsync(string? mode, CancellationToken cancellationToken)
    {
        var arguments = new List<string> { "src/cli.js", "workflow", "continuation" };
        if (!string.IsNullOrWhiteSpace(mode))
        {
            arguments.Add("--mode");
            arguments.Add(mode);
        }

        var result = await _runner.RunAsync(
            "node",
            arguments,
            _gatewayRoot,
            TimeSpan.FromSeconds(10),
            cancellationToken);
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(result.StandardError)
                ? "自動継続設定を取得できませんでした。"
                : result.StandardError.Trim());
        }

        using var document = JsonDocument.Parse(result.StandardOutput);
        var root = document.RootElement;
        if (root.TryGetProperty("ok", out var okElement) && okElement.ValueKind == JsonValueKind.False)
        {
            var error = root.TryGetProperty("error", out var errorElement) ? errorElement.GetString() : null;
            throw new InvalidOperationException(error ?? "自動継続設定の変更に失敗しました。");
        }

        var resolvedMode = root.TryGetProperty("mode", out var modeElement) ? modeElement.GetString() : null;
        var enabled = root.TryGetProperty("enabled", out var enabledElement) && enabledElement.ValueKind == JsonValueKind.True;
        var description = root.TryGetProperty("description", out var descriptionElement) ? descriptionElement.GetString() : null;
        string? model = null;
        string? thinking = null;
        if (root.TryGetProperty("executor", out var executorElement) && executorElement.ValueKind == JsonValueKind.Object)
        {
            model = executorElement.TryGetProperty("model", out var modelElement) ? modelElement.GetString() : null;
            thinking = executorElement.TryGetProperty("thinking", out var thinkingElement) ? thinkingElement.GetString() : null;
        }
        if (string.IsNullOrWhiteSpace(resolvedMode)) throw new InvalidOperationException("自動継続設定の応答にmodeがありません。");
        return new ContinuationModeInfo(resolvedMode, enabled, description ?? string.Empty, model, thinking);
    }
}
