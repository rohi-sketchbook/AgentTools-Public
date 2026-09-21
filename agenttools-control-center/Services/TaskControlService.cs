using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AgentToolsControlCenter.Services;

public sealed record TaskInspectionResult(
    string TaskId,
    string? Status,
    string? State,
    string? StateReason,
    string? Phase,
    string? CurrentWork,
    DateTimeOffset? UpdatedAt,
    DateTimeOffset? LatestChatGptAt,
    string? LatestChatGptPhase,
    string? LatestChatGptMessage,
    DateTimeOffset? ContinueRequestedAt,
    string? ContinueRequestStatus,
    string? ContinueRequestedBy,
    string? ResumeNextStep,
    string? ResumeImpact,
    bool ResumeRequiresUserConfirmation,
    bool DevSpaceFound,
    bool DevSpaceReusable,
    string? DevSpaceStatus,
    string? DevSpaceWorkspaceId,
    DateTimeOffset? DevSpaceLastUsedAt,
    string? DevSpaceError,
    bool GitAvailable,
    string? GitBranch,
    int GitChangeCount,
    string? GitSummary,
    string Note)
{
    public string ToDisplayText(bool includeWorkspaceId = true)
    {
        var lines = new List<string>
        {
            $"Task状態: {Status ?? "不明"}{(string.IsNullOrWhiteSpace(State) ? string.Empty : $" / {State}")}",
            $"Phase: {Phase ?? "—"}",
            $"現在の進行: {CurrentWork ?? "—"}",
        };
        if (!string.IsNullOrWhiteSpace(StateReason)) lines.Add($"停止・待機理由: {StateReason}");
        if (UpdatedAt is not null) lines.Add($"Task更新: {UpdatedAt:yyyy-MM-dd HH:mm:ss}");
        if (ContinueRequestedAt is not null)
        {
            var continueLabel = ContinueRequestStatus switch
            {
                "waiting_host" => "再開待ち",
                "requested" => "続行要求済み",
                _ => ContinueRequestStatus ?? "続行要求済み",
            };
            lines.Add($"続行要求: {continueLabel} / {ContinueRequestedAt:yyyy-MM-dd HH:mm:ss}{(string.IsNullOrWhiteSpace(ContinueRequestedBy) ? string.Empty : $" / {ContinueRequestedBy}")}");
        }

        lines.Add(string.Empty);
        lines.Add("Task記録上の最新ChatGPT進捗:");
        if (LatestChatGptMessage is null)
        {
            lines.Add("記録なし");
        }
        else
        {
            var prefix = LatestChatGptAt is null ? string.Empty : $"[{LatestChatGptAt:yyyy-MM-dd HH:mm:ss}] ";
            var phase = string.IsNullOrWhiteSpace(LatestChatGptPhase) ? string.Empty : $"{LatestChatGptPhase}: ";
            lines.Add($"{prefix}{phase}{LatestChatGptMessage}");
        }

        lines.Add(string.Empty);
        lines.Add("DevSpace:");
        lines.Add(DevSpaceFound
            ? $"{DevSpaceStatus ?? "検出"} / {(DevSpaceReusable ? "既存Workspace再利用可能" : "Workspace履歴あり")}" 
            : $"Workspace未検出{(string.IsNullOrWhiteSpace(DevSpaceError) ? string.Empty : $" / {DevSpaceError}")}");
        if (includeWorkspaceId && !string.IsNullOrWhiteSpace(DevSpaceWorkspaceId)) lines.Add($"Workspace ID: {DevSpaceWorkspaceId}");
        if (DevSpaceLastUsedAt is not null) lines.Add($"最終利用: {DevSpaceLastUsedAt:yyyy-MM-dd HH:mm:ss}");

        lines.Add(string.Empty);
        lines.Add("Git:");
        lines.Add(GitAvailable
            ? $"Branch: {GitBranch ?? "—"} / 変更 {GitChangeCount}件\n{GitSummary ?? "—"}"
            : GitSummary ?? "Git状態を取得できませんでした。");

        if (!string.IsNullOrWhiteSpace(ResumeNextStep))
        {
            lines.Add(string.Empty);
            lines.Add($"再開候補: {ResumeNextStep}");
            lines.Add($"次操作: {ResumeImpact ?? "不明"}{(ResumeRequiresUserConfirmation ? " / ユーザー確認必須" : string.Empty)}");
        }

        lines.Add(string.Empty);
        lines.Add("※ ChatGPT製品の完全な会話履歴ではなく、Work Taskへ記録された最新のChatGPT進捗です。");
        return string.Join(Environment.NewLine, lines);
    }
}

public sealed record TaskResumePromptResult(bool Succeeded, string Action, string Prompt, string Message);
public sealed record TaskControlActionResult(bool Succeeded, string Action, string Message);

public sealed class TaskControlService
{
    private static readonly Regex TaskIdPattern = new("^task_[A-Za-z0-9_-]+$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private readonly string _gatewayRoot;
    private readonly string _cliPath;
    private readonly CommandRunner _runner = new();

    public TaskControlService(string agentToolsRoot)
    {
        _gatewayRoot = Path.Combine(agentToolsRoot, "agenttools-mcp-gateway");
        _cliPath = Path.Combine(_gatewayRoot, "src", "cli.js");
    }

    public async Task<TaskInspectionResult> InspectAsync(string taskId, CancellationToken cancellationToken = default)
    {
        ValidateTaskId(taskId);
        using var json = await RunAsync(["task", "inspect", "--id", taskId], TimeSpan.FromSeconds(12), cancellationToken);
        var root = json.RootElement;
        EnsureOk(root);
        var inspection = root.GetProperty("inspection");
        var latest = inspection.TryGetProperty("latestChatGpt", out var latestElement) && latestElement.ValueKind == JsonValueKind.Object ? latestElement : default;
        var continueRequest = inspection.TryGetProperty("continueRequest", out var continueElement) && continueElement.ValueKind == JsonValueKind.Object ? continueElement : default;
        var resume = inspection.TryGetProperty("resume", out var resumeElement) && resumeElement.ValueKind == JsonValueKind.Object ? resumeElement : default;
        var devspace = inspection.TryGetProperty("devspace", out var devspaceElement) && devspaceElement.ValueKind == JsonValueKind.Object ? devspaceElement : default;
        var git = inspection.TryGetProperty("git", out var gitElement) && gitElement.ValueKind == JsonValueKind.Object ? gitElement : default;

        return new TaskInspectionResult(
            ReadString(inspection, "taskId") ?? taskId,
            ReadString(inspection, "status"),
            ReadString(inspection, "state"),
            ReadString(inspection, "stateReason"),
            ReadString(inspection, "phase"),
            ReadString(inspection, "currentWork"),
            ReadDate(inspection, "updatedAt"),
            latest.ValueKind == JsonValueKind.Object ? ReadDate(latest, "at") : null,
            latest.ValueKind == JsonValueKind.Object ? ReadString(latest, "phase") : null,
            latest.ValueKind == JsonValueKind.Object ? ReadString(latest, "message") : null,
            continueRequest.ValueKind == JsonValueKind.Object ? ReadDate(continueRequest, "requestedAt") : null,
            continueRequest.ValueKind == JsonValueKind.Object ? ReadString(continueRequest, "status") : null,
            continueRequest.ValueKind == JsonValueKind.Object ? ReadString(continueRequest, "requestedBy") : null,
            resume.ValueKind == JsonValueKind.Object ? ReadString(resume, "nextStep") : null,
            resume.ValueKind == JsonValueKind.Object ? ReadString(resume, "nextActionImpact") : null,
            resume.ValueKind == JsonValueKind.Object && ReadBool(resume, "requiresUserConfirmation"),
            devspace.ValueKind == JsonValueKind.Object && ReadBool(devspace, "found"),
            devspace.ValueKind == JsonValueKind.Object && ReadBool(devspace, "reusable"),
            devspace.ValueKind == JsonValueKind.Object ? ReadString(devspace, "status") : null,
            devspace.ValueKind == JsonValueKind.Object ? ReadString(devspace, "workspaceId") : null,
            devspace.ValueKind == JsonValueKind.Object ? ReadDate(devspace, "lastUsedAt") : null,
            devspace.ValueKind == JsonValueKind.Object ? ReadString(devspace, "error") : null,
            git.ValueKind == JsonValueKind.Object && ReadBool(git, "available"),
            git.ValueKind == JsonValueKind.Object ? ReadString(git, "branch") : null,
            git.ValueKind == JsonValueKind.Object ? ReadInt(git, "changeCount") : 0,
            git.ValueKind == JsonValueKind.Object ? ReadString(git, "summary") : null,
            ReadString(inspection, "note") ?? string.Empty);
    }

    public async Task<TaskResumePromptResult> GetResumePromptAsync(string taskId, CancellationToken cancellationToken = default)
    {
        using var json = await RunAsync(["task", "resumePrompt", "--id", ValidateTaskId(taskId)], TimeSpan.FromSeconds(12), cancellationToken, allowFailureJson: true);
        var root = json.RootElement;
        var ok = ReadBool(root, "ok");
        return new TaskResumePromptResult(
            ok,
            ReadString(root, "action") ?? (ok ? "resume-prompt" : "failed"),
            ReadString(root, "prompt") ?? string.Empty,
            ReadString(root, "message") ?? ReadString(root, "error") ?? (ok ? "ChatGPT再開用プロンプトを生成しました。" : "再開プロンプトの生成に失敗しました。"));
    }

    public Task<TaskControlActionResult> ContinueWithCodexAsync(string taskId, CancellationToken cancellationToken = default)
        => RunActionAsync([
            "task", "continueRequest",
            "--id", ValidateTaskId(taskId),
            "--actor", "control-center",
            "--actorLabel", "Control Center",
            "--manualModelRole", "implementation"
        ], TimeSpan.FromSeconds(30), cancellationToken);

    public Task<TaskControlActionResult> CompleteForgottenAsync(string taskId, DateTime updatedAt, CancellationToken cancellationToken = default)
        => RunActionAsync([
            "task", "finishForgottenTask",
            "--id", ValidateTaskId(taskId),
            "--actor", "control-center",
            "--actorLabel", "Control Center",
            "--expectedUpdatedAt", updatedAt.ToUniversalTime().ToString("O"),
            "--userExplicitlyRequested", "true"
        ], TimeSpan.FromSeconds(12), cancellationToken);

    private async Task<TaskControlActionResult> RunActionAsync(string[] arguments, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var json = await RunAsync(arguments, timeout, cancellationToken, allowFailureJson: true);
        var root = json.RootElement;
        var ok = ReadBool(root, "ok");
        return new TaskControlActionResult(
            ok,
            ReadString(root, "action") ?? (ok ? "ok" : "failed"),
            ReadString(root, "message") ?? ReadString(root, "error") ?? (ok ? "操作を受け付けました。" : "操作に失敗しました。"));
    }

    private async Task<JsonDocument> RunAsync(string[] arguments, TimeSpan timeout, CancellationToken cancellationToken, bool allowFailureJson = false)
    {
        var result = await _runner.RunAsync("node.exe", [_cliPath, .. arguments], _gatewayRoot, timeout, cancellationToken);
        if (string.IsNullOrWhiteSpace(result.StandardOutput))
            throw new InvalidOperationException(result.TimedOut ? "Task操作がタイムアウトしました。" : result.StandardError.Trim());

        JsonDocument json;
        try
        {
            json = JsonDocument.Parse(result.StandardOutput);
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException($"Gatewayから不正なJSON応答を受信しました: {ex.Message}");
        }

        if (!allowFailureJson && (!result.Succeeded || !ReadBool(json.RootElement, "ok")))
        {
            var message = ReadString(json.RootElement, "error") ?? result.StandardError.Trim();
            json.Dispose();
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(message) ? "Task操作に失敗しました。" : message);
        }
        return json;
    }

    private static string ValidateTaskId(string taskId)
    {
        if (!TaskIdPattern.IsMatch(taskId ?? string.Empty)) throw new ArgumentException("不正なTask IDです。", nameof(taskId));
        return taskId!;
    }

    private static void EnsureOk(JsonElement root)
    {
        if (ReadBool(root, "ok")) return;
        throw new InvalidOperationException(ReadString(root, "error") ?? "Task操作に失敗しました。");
    }

    private static string? ReadString(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool ReadBool(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private static int ReadInt(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.TryGetInt32(out var result) ? result : 0;

    private static DateTimeOffset? ReadDate(JsonElement element, string name)
        => DateTimeOffset.TryParse(ReadString(element, name), out var result) ? result.ToLocalTime() : null;
}
