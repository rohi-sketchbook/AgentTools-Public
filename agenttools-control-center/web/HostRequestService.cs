using System.Text.Json;
using System.Text.RegularExpressions;
using AgentToolsControlCenter.Services;

namespace AgentToolsControlCenter.Web;

public sealed record HostRequestListItem(
    string RequestId,
    string Type,
    string Status,
    string TaskId,
    string TaskTitle,
    string? ResultSummary,
    string? Failure,
    DateTimeOffset? CreatedAt,
    DateTimeOffset? UpdatedAt,
    DateTimeOffset? ClaimedAt,
    DateTimeOffset? CompletedAt,
    int ReportCharCount,
    int ReportHeadingCount);

public sealed record HostRequestDetail(
    HostRequestListItem Item,
    string? ReportContent);

public sealed record HostRequestEnqueueResult(
    bool Succeeded,
    bool Duplicate,
    HostRequestListItem? Request,
    string Message);

public sealed class HostRequestService
{
    private static readonly Regex TaskIdPattern = new("^task_[A-Za-z0-9_-]+$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex RequestIdPattern = new("^hostreq_[A-Za-z0-9_-]+$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private readonly string _gatewayRoot;
    private readonly string _cliPath;
    private readonly string _hostRequestRoot;
    private readonly CommandRunner _runner = new();

    public HostRequestService(string agentToolsRoot)
    {
        _gatewayRoot = Path.Combine(agentToolsRoot, "agenttools-mcp-gateway");
        _cliPath = Path.Combine(_gatewayRoot, "src", "cli.js");
        var stateRoot = Environment.GetEnvironmentVariable("AGENTTOOLS_STATE_ROOT");
        _hostRequestRoot = Path.Combine(string.IsNullOrWhiteSpace(stateRoot) ? Path.Combine(_gatewayRoot, "state") : stateRoot, "host-requests");
    }

    public async Task<HostRequestEnqueueResult> EnqueueDetailedInspectionAsync(string taskId, CancellationToken cancellationToken = default)
    {
        ValidateTaskId(taskId);
        using var json = await RunAsync([
            "hostRequest", "enqueueDetailedInspection",
            "--taskId", taskId,
            "--source", "control-center-web",
            "--requestedBy", "Web Control Center"
        ], TimeSpan.FromSeconds(12), cancellationToken);
        var root = json.RootElement;
        var ok = ReadBool(root, "ok");
        var request = root.TryGetProperty("request", out var requestElement) && requestElement.ValueKind == JsonValueKind.Object
            ? ParseListItem(requestElement)
            : null;
        return new HostRequestEnqueueResult(
            ok,
            ReadBool(root, "duplicate"),
            request,
            ReadString(root, "message") ?? ReadString(root, "error") ?? (ok ? "詳細状況確認を登録しました。" : "詳細状況確認の登録に失敗しました。"));
    }

    public async Task<HostRequestEnqueueResult> EnqueueTaskContinuationAsync(string taskId, CancellationToken cancellationToken = default)
    {
        ValidateTaskId(taskId);
        using var json = await RunAsync([
            "hostRequest", "enqueueContinue",
            "--taskId", taskId,
            "--source", "control-center-web",
            "--requestedBy", "Web Control Center"
        ], TimeSpan.FromSeconds(12), cancellationToken);
        var root = json.RootElement;
        var ok = ReadBool(root, "ok");
        var request = root.TryGetProperty("request", out var requestElement) && requestElement.ValueKind == JsonValueKind.Object
            ? ParseListItem(requestElement)
            : null;
        return new HostRequestEnqueueResult(
            ok,
            ReadBool(root, "duplicate"),
            request,
            ReadString(root, "message") ?? ReadString(root, "error") ?? (ok ? "作業続行を登録しました。" : "作業続行の登録に失敗しました。"));
    }

    public Task<IReadOnlyList<HostRequestListItem>> ListAsync(int limit = 40, string? taskId = null, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var bounded = Math.Clamp(limit, 1, 100);
        var validatedTaskId = string.IsNullOrWhiteSpace(taskId) ? null : ValidateTaskId(taskId);
        var items = new List<HostRequestListItem>();
        foreach (var status in new[] { "pending", "processing", "completed", "failed" })
        {
            var directory = Path.Combine(_hostRequestRoot, status);
            if (!Directory.Exists(directory)) continue;
            foreach (var file in Directory.EnumerateFiles(directory, "*.json", SearchOption.TopDirectoryOnly))
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    using var json = JsonDocument.Parse(File.ReadAllText(file));
                    var item = ParseListItem(json.RootElement);
                    if (validatedTaskId is null || string.Equals(item.TaskId, validatedTaskId, StringComparison.Ordinal))
                        items.Add(item);
                }
                catch (IOException) { }
                catch (JsonException) { }
            }
        }
        IReadOnlyList<HostRequestListItem> result = items
            .OrderByDescending(item => item.UpdatedAt ?? item.CreatedAt ?? DateTimeOffset.MinValue)
            .Take(bounded)
            .ToArray();
        return Task.FromResult(result);
    }

    public Task<HostRequestDetail> GetAsync(string requestId, CancellationToken cancellationToken = default)
    {
        ValidateRequestId(requestId);
        cancellationToken.ThrowIfCancellationRequested();
        foreach (var status in new[] { "pending", "processing", "completed", "failed" })
        {
            var file = Path.Combine(_hostRequestRoot, status, $"{requestId}.json");
            if (!File.Exists(file)) continue;
            using var json = JsonDocument.Parse(File.ReadAllText(file));
            var item = ParseListItem(json.RootElement);
            string? reportContent = null;
            if (string.Equals(item.Status, "completed", StringComparison.OrdinalIgnoreCase)
                && json.RootElement.TryGetProperty("report", out var report)
                && report.ValueKind == JsonValueKind.Object)
            {
                var relativePath = ReadString(report, "relativePath");
                if (!string.IsNullOrWhiteSpace(relativePath))
                {
                    var reportsRoot = Path.GetFullPath(Path.Combine(_hostRequestRoot, "reports"));
                    var reportPath = Path.GetFullPath(Path.Combine(_hostRequestRoot, relativePath.Replace('/', Path.DirectorySeparatorChar)));
                    if (reportPath.StartsWith(reportsRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && File.Exists(reportPath))
                        reportContent = File.ReadAllText(reportPath);
                }
            }
            return Task.FromResult(new HostRequestDetail(item, reportContent));
        }
        throw new FileNotFoundException("Host request not found.");
    }

    private async Task<JsonDocument> RunAsync(string[] arguments, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var result = await _runner.RunAsync("node.exe", [_cliPath, .. arguments], _gatewayRoot, timeout, cancellationToken);
        if (string.IsNullOrWhiteSpace(result.StandardOutput))
            throw new InvalidOperationException(result.TimedOut ? "Host Request操作がタイムアウトしました。" : result.StandardError.Trim());
        try
        {
            var json = JsonDocument.Parse(result.StandardOutput);
            if (!result.Succeeded && !ReadBool(json.RootElement, "ok"))
            {
                var error = ReadString(json.RootElement, "error") ?? result.StandardError.Trim();
                json.Dispose();
                throw new InvalidOperationException(string.IsNullOrWhiteSpace(error) ? "Host Request操作に失敗しました。" : error);
            }
            return json;
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException($"Gatewayから不正なHost Request JSONを受信しました: {ex.Message}");
        }
    }

    private static HostRequestListItem ParseListItem(JsonElement request)
    {
        var report = request.TryGetProperty("report", out var reportElement) && reportElement.ValueKind == JsonValueKind.Object
            ? reportElement
            : default;
        return new HostRequestListItem(
            ReadString(request, "requestId") ?? string.Empty,
            ReadString(request, "type") ?? string.Empty,
            ReadString(request, "status") ?? "unknown",
            ReadString(request, "taskId") ?? string.Empty,
            ReadString(request, "taskTitle") ?? ReadString(request, "taskId") ?? "詳細状況確認",
            ReadString(request, "resultSummary"),
            ReadString(request, "failure"),
            ReadDate(request, "createdAt"),
            ReadDate(request, "updatedAt"),
            ReadDate(request, "claimedAt"),
            ReadDate(request, "completedAt"),
            report.ValueKind == JsonValueKind.Object ? ReadInt(report, "charCount") : 0,
            report.ValueKind == JsonValueKind.Object ? ReadInt(report, "headingCount") : 0);
    }

    private static string ValidateTaskId(string taskId)
    {
        if (!TaskIdPattern.IsMatch(taskId ?? string.Empty)) throw new ArgumentException("不正なTask IDです。", nameof(taskId));
        return taskId!;
    }

    private static string ValidateRequestId(string requestId)
    {
        if (!RequestIdPattern.IsMatch(requestId ?? string.Empty)) throw new ArgumentException("不正なHost Request IDです。", nameof(requestId));
        return requestId!;
    }

    private static void EnsureOk(JsonElement root)
    {
        if (ReadBool(root, "ok")) return;
        throw new InvalidOperationException(ReadString(root, "error") ?? "Host Request操作に失敗しました。");
    }

    private static string? ReadString(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool ReadBool(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private static int ReadInt(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out var result)
            ? result
            : 0;

    private static DateTimeOffset? ReadDate(JsonElement element, string name)
        => DateTimeOffset.TryParse(ReadString(element, name), out var result) ? result.ToLocalTime() : null;
}
