using System.IO;
using System.Text.Json;
using AgentToolsControlCenter.Models;

namespace AgentToolsControlCenter.Services;

// Compatibility name only. The user-visible source of truth is now type=work
// records in Gateway state/tasks.json; legacy Activity Store is no longer read.
public sealed class ActivityCollector
{
    private readonly string _taskStatePath;

    public ActivityCollector(string agentToolsRoot)
    {
        _taskStatePath = Path.Combine(
            agentToolsRoot,
            "agenttools-mcp-gateway",
            "state",
            "tasks.json");
    }

    public string ActivityStatePath => _taskStatePath;

    public async Task<IReadOnlyList<WorkActivity>> CollectAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_taskStatePath)) return [];

        await using var stream = new FileStream(
            _taskStatePath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            4096,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var json = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        if (!json.RootElement.TryGetProperty("tasks", out var tasks) || tasks.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var result = new List<WorkActivity>();
        foreach (var item in tasks.EnumerateArray())
        {
            if (ReadString(item, "type") != "work") continue;
            var status = ReadString(item, "status");
            if (status is not ("running" or "blocked" or "succeeded" or "failed" or "cancelled")) continue;

            var id = ReadString(item, "id");
            var title = ReadString(item, "title");
            if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(title)) continue;
            if (!item.TryGetProperty("work", out var work) || work.ValueKind != JsonValueKind.Object) continue;

            var owner = work.TryGetProperty("owner", out var ownerElement) && ownerElement.ValueKind == JsonValueKind.Object
                ? ownerElement
                : default;
            var ownerLabel = owner.ValueKind == JsonValueKind.Object
                ? ReadString(owner, "label") ?? ReadString(owner, "id") ?? "Unknown"
                : "Unknown";
            var ownerModel = owner.ValueKind == JsonValueKind.Object ? ReadString(owner, "model") : null;

            var contributors = new List<string>();
            if (work.TryGetProperty("contributors", out var contributorsElement) && contributorsElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var contributor in contributorsElement.EnumerateArray())
                {
                    if (contributor.ValueKind != JsonValueKind.Object) continue;
                    var label = ReadString(contributor, "label") ?? ReadString(contributor, "id");
                    if (string.IsNullOrWhiteSpace(label)) continue;
                    var model = ReadString(contributor, "model");
                    var display = string.IsNullOrWhiteSpace(model) ? label : $"{label} ({model})";
                    if (!contributors.Contains(display, StringComparer.OrdinalIgnoreCase)) contributors.Add(display);
                }
            }

            var workers = new List<string>();
            if (work.TryGetProperty("workers", out var workersElement) && workersElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var worker in workersElement.EnumerateArray())
                {
                    if (worker.ValueKind != JsonValueKind.Object) continue;
                    var workerStatus = ReadString(worker, "status");
                    if (workerStatus == "done") continue;
                    if (!worker.TryGetProperty("actor", out var actorElement) || actorElement.ValueKind != JsonValueKind.Object) continue;
                    var label = ReadString(actorElement, "label") ?? ReadString(actorElement, "id") ?? "Unknown";
                    var model = ReadString(actorElement, "model");
                    var actorDisplay = string.IsNullOrWhiteSpace(model) ? label : $"{label} ({model})";
                    var currentWork = ReadString(worker, "message") ?? ReadString(worker, "phase") ?? "作業中";
                    var prefix = workerStatus == "blocked" ? "[待機] " : string.Empty;
                    workers.Add($"{prefix}{actorDisplay}: {currentWork}");
                }
            }

            var workLog = new List<string>();
            if (work.TryGetProperty("workLog", out var workLogElement) && workLogElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var entry in workLogElement.EnumerateArray())
                {
                    if (entry.ValueKind != JsonValueKind.Object) continue;
                    var at = ReadDate(entry, "at");
                    var phase = ReadString(entry, "phase");
                    var message = ReadString(entry, "message");
                    if (string.IsNullOrWhiteSpace(message)) continue;

                    var actorDisplay = "Unknown";
                    if (entry.TryGetProperty("actor", out var logActor) && logActor.ValueKind == JsonValueKind.Object)
                    {
                        var label = ReadString(logActor, "label") ?? ReadString(logActor, "id") ?? "Unknown";
                        var model = ReadString(logActor, "model");
                        actorDisplay = string.IsNullOrWhiteSpace(model) ? label : $"{label} ({model})";
                    }

                    var prefix = at is null ? string.Empty : $"[{at:HH:mm:ss}] ";
                    var phaseText = string.IsNullOrWhiteSpace(phase) ? string.Empty : $" / {phase}";
                    workLog.Add($"{prefix}{actorDisplay}{phaseText}: {message}");
                }
            }

            string? resumeNextStep = null;
            string? autoResumeStatus = null;
            string? autoResumeReason = null;
            string? continuationStatus = null;
            string? continuationProvider = null;
            string? continuationModel = null;
            string? continuationAgentId = null;
            var continuationAttempt = 0;
            var continuationSessionReused = false;
            var continuationSessionReuseCount = 0;
            double? continuationUsedPercent = null;
            double? continuationRemainingPercent = null;
            DateTime? continuationStartedAt = null;
            DateTime? continuationFinishedAt = null;
            string? continuationSummary = null;
            string? continuationError = null;
            if (work.TryGetProperty("resumeContext", out var resumeElement) && resumeElement.ValueKind == JsonValueKind.Object)
            {
                resumeNextStep = ReadString(resumeElement, "nextStep");
                autoResumeStatus = ReadString(resumeElement, "autoResumeStatus");
                autoResumeReason = ReadString(resumeElement, "autoResumeReason");
                if (resumeElement.TryGetProperty("continuation", out var continuationElement) && continuationElement.ValueKind == JsonValueKind.Object)
                {
                    continuationStatus = ReadString(continuationElement, "status");
                    continuationProvider = ReadString(continuationElement, "provider");
                    continuationModel = ReadString(continuationElement, "model");
                    continuationAgentId = ReadString(continuationElement, "agentId");
                    continuationAttempt = ReadInt(continuationElement, "attempt") ?? 0;
                    continuationSessionReused = continuationElement.TryGetProperty("sessionReused", out var reusedElement) && reusedElement.ValueKind == JsonValueKind.True;
                    continuationSessionReuseCount = ReadInt(continuationElement, "sessionReuseCount") ?? 0;
                    continuationStartedAt = ReadDate(continuationElement, "startedAt");
                    continuationFinishedAt = ReadDate(continuationElement, "finishedAt");
                    continuationSummary = ReadString(continuationElement, "summary");
                    continuationError = ReadString(continuationElement, "error");
                    if (continuationElement.TryGetProperty("providerUsage", out var usageElement) && usageElement.ValueKind == JsonValueKind.Object)
                    {
                        continuationUsedPercent = ReadDouble(usageElement, "usedPercent");
                        continuationRemainingPercent = ReadDouble(usageElement, "remainingPercent");
                    }
                }
            }

            result.Add(new WorkActivity
            {
                Id = id,
                Title = title,
                Status = status,
                Phase = ReadString(work, "phase"),
                CurrentWork = ReadString(work, "currentWork"),
                State = ReadString(work, "state"),
                StateReason = ReadString(work, "stateReason"),
                Request = ReadString(work, "request"),
                Project = ReadString(work, "project"),
                WorkspaceRoot = ReadString(work, "workspaceRoot"),
                ResumeNextStep = resumeNextStep,
                AutoResumeStatus = autoResumeStatus,
                AutoResumeReason = autoResumeReason,
                ContinuationStatus = continuationStatus,
                ContinuationProvider = continuationProvider,
                ContinuationModel = continuationModel,
                ContinuationAgentId = continuationAgentId,
                ContinuationAttempt = continuationAttempt,
                ContinuationSessionReused = continuationSessionReused,
                ContinuationSessionReuseCount = continuationSessionReuseCount,
                ContinuationUsedPercent = continuationUsedPercent,
                ContinuationRemainingPercent = continuationRemainingPercent,
                ContinuationStartedAt = continuationStartedAt,
                ContinuationFinishedAt = continuationFinishedAt,
                ContinuationSummary = continuationSummary,
                ContinuationError = continuationError,
                OwnerLabel = ownerLabel,
                OwnerModel = ownerModel,
                ContributorsDisplay = contributors.Count == 0 ? ownerLabel : string.Join(" / ", contributors),
                WorkersDisplay = workers.Count == 0 ? $"{(string.IsNullOrWhiteSpace(ownerModel) ? ownerLabel : $"{ownerLabel} ({ownerModel})")}: {ReadString(work, "currentWork") ?? ReadString(work, "phase") ?? "作業中"}" : string.Join(Environment.NewLine, workers),
                WorkLogDisplay = string.Join(Environment.NewLine, workLog),
                StartedAt = ReadDate(item, "startedAt") ?? ReadDate(item, "createdAt") ?? DateTime.MinValue,
                UpdatedAt = ReadDate(item, "updatedAt") ?? DateTime.MinValue,
            });
        }

        return result
            .OrderBy(item => item.Status is "running" or "blocked" ? 0 : 1)
            .ThenByDescending(item => item.UpdatedAt)
            .Take(30)
            .ToArray();
    }

    private static string? ReadString(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static int? ReadInt(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number) return null;
        return value.TryGetInt32(out var parsed) ? parsed : null;
    }

    private static double? ReadDouble(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number) return null;
        return value.TryGetDouble(out var parsed) ? parsed : null;
    }

    private static DateTime? ReadDate(JsonElement element, string name)
    {
        var value = ReadString(element, name);
        return DateTime.TryParse(value, out var parsed) ? parsed.ToLocalTime() : null;
    }
}
