using System.Diagnostics;
using System.Text.Json;

namespace AgentToolsControlCenter.Services;

public sealed record PlanUsageWindow(
    double UsedPercent,
    double RemainingPercent,
    int? WindowDurationMinutes,
    DateTimeOffset? ResetsAt);

public sealed record PlanUsageSnapshot(
    string Provider,
    string? PlanType,
    PlanUsageWindow? Primary,
    PlanUsageWindow? Secondary,
    int? ResetCreditsAvailable,
    DateTimeOffset RefreshedAt,
    bool Stale,
    string? Error)
{
    public static PlanUsageSnapshot Unavailable(string message) => new(
        "codex",
        null,
        null,
        null,
        null,
        DateTimeOffset.Now,
        false,
        message);
}

public sealed class PlanUsageCollector
{
    private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(10);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private PlanUsageSnapshot? _snapshot;

    public async Task<PlanUsageSnapshot> CollectAsync(
        bool force = false,
        CancellationToken cancellationToken = default)
    {
        var current = _snapshot;
        if (!force && IsFresh(current)) return current!;

        await _gate.WaitAsync(cancellationToken);
        try
        {
            current = _snapshot;
            if (!force && IsFresh(current)) return current!;

            try
            {
                var refreshed = await ProbeAsync(cancellationToken);
                _snapshot = refreshed;
                return refreshed;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                var safeMessage = ex is TimeoutException
                    ? "Codex利用枠の取得がタイムアウトしました。"
                    : "Codex利用枠を取得できませんでした。";

                if (current is not null)
                {
                    var stale = current with
                    {
                        RefreshedAt = DateTimeOffset.Now,
                        Stale = true,
                        Error = safeMessage
                    };
                    _snapshot = stale;
                    return stale;
                }

                var unavailable = PlanUsageSnapshot.Unavailable(safeMessage);
                _snapshot = unavailable;
                return unavailable;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private static bool IsFresh(PlanUsageSnapshot? snapshot)
        => snapshot is not null
            && DateTimeOffset.Now - snapshot.RefreshedAt < CacheDuration;

    private static async Task<PlanUsageSnapshot> ProbeAsync(CancellationToken cancellationToken)
    {
        var commandProcessor = Environment.GetEnvironmentVariable("ComSpec");
        if (string.IsNullOrWhiteSpace(commandProcessor)) commandProcessor = "cmd.exe";

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = commandProcessor,
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            }
        };
        process.StartInfo.ArgumentList.Add("/d");
        process.StartInfo.ArgumentList.Add("/s");
        process.StartInfo.ArgumentList.Add("/c");
        process.StartInfo.ArgumentList.Add("codex app-server --stdio");

        if (!process.Start()) throw new InvalidOperationException("Codex app-serverを開始できませんでした。");

        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(ProbeTimeout);

        try
        {
            await WriteMessageAsync(process, new
            {
                id = 1,
                method = "initialize",
                @params = new
                {
                    clientInfo = new
                    {
                        name = "agenttools-control-center",
                        title = "AgentTools Control Center",
                        version = "1.0.0"
                    },
                    capabilities = new { }
                }
            }, timeoutCts.Token);

            while (true)
            {
                var line = await process.StandardOutput.ReadLineAsync(timeoutCts.Token);
                if (line is null)
                {
                    var stderr = await SafeReadAsync(stderrTask);
                    throw new InvalidOperationException(string.IsNullOrWhiteSpace(stderr)
                        ? "Codex app-serverが応答を返さず終了しました。"
                        : "Codex app-serverが利用枠取得前に終了しました。");
                }
                if (string.IsNullOrWhiteSpace(line)) continue;

                using var json = JsonDocument.Parse(line);
                var root = json.RootElement;
                if (!root.TryGetProperty("id", out var idElement)) continue;
                var id = idElement.ValueKind switch
                {
                    JsonValueKind.Number when idElement.TryGetInt32(out var numeric) => numeric,
                    JsonValueKind.String when int.TryParse(idElement.GetString(), out var parsed) => parsed,
                    _ => -1
                };

                if (id == 1)
                {
                    if (root.TryGetProperty("error", out _))
                    {
                        throw new InvalidOperationException("Codex app-serverの初期化に失敗しました。");
                    }
                    await WriteMessageAsync(process, new { method = "initialized" }, timeoutCts.Token);
                    await WriteMessageAsync(process, new
                    {
                        id = 2,
                        method = "account/rateLimits/read",
                        @params = new { }
                    }, timeoutCts.Token);
                    continue;
                }

                if (id != 2) continue;
                if (root.TryGetProperty("error", out _))
                {
                    throw new InvalidOperationException("Codex利用枠APIがエラーを返しました。");
                }
                if (!root.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Object)
                {
                    throw new InvalidOperationException("Codex利用枠APIの応答形式が不正です。");
                }

                return ParseResult(result, DateTimeOffset.Now);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("Codex利用枠の取得がタイムアウトしました。");
        }
        finally
        {
            try { process.StandardInput.Close(); } catch { }
            try
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
            }
            catch
            {
                // Best-effort cleanup only.
            }
        }
    }

    private static async Task WriteMessageAsync(Process process, object payload, CancellationToken cancellationToken)
    {
        var json = JsonSerializer.Serialize(payload);
        await process.StandardInput.WriteLineAsync(json.AsMemory(), cancellationToken);
        await process.StandardInput.FlushAsync(cancellationToken);
    }

    private static PlanUsageSnapshot ParseResult(JsonElement result, DateTimeOffset refreshedAt)
    {
        JsonElement limits = default;
        var found = false;
        if (result.TryGetProperty("rateLimitsByLimitId", out var byId)
            && byId.ValueKind == JsonValueKind.Object
            && byId.TryGetProperty("codex", out var codex)
            && codex.ValueKind == JsonValueKind.Object)
        {
            limits = codex;
            found = true;
        }
        else if (result.TryGetProperty("rateLimits", out var direct) && direct.ValueKind == JsonValueKind.Object)
        {
            limits = direct;
            found = true;
        }

        if (!found) throw new InvalidOperationException("Codex利用枠が応答に含まれていません。");

        var planType = ReadString(limits, "planType");
        var primary = ReadWindow(limits, "primary");
        var secondary = ReadWindow(limits, "secondary");
        var resetCredits = result.TryGetProperty("rateLimitResetCredits", out var credits)
            && credits.ValueKind == JsonValueKind.Object
            ? ReadInt(credits, "availableCount")
            : null;

        if (primary is null && secondary is null)
        {
            throw new InvalidOperationException("Codex利用枠の時間窓を取得できませんでした。");
        }

        return new PlanUsageSnapshot(
            "codex",
            planType,
            primary,
            secondary,
            resetCredits,
            refreshedAt,
            false,
            null);
    }

    private static PlanUsageWindow? ReadWindow(JsonElement parent, string propertyName)
    {
        if (!parent.TryGetProperty(propertyName, out var window) || window.ValueKind != JsonValueKind.Object)
        {
            return null;
        }
        var used = ReadDouble(window, "usedPercent");
        if (used is null) return null;
        var clampedUsed = Math.Max(0, Math.Min(100, used.Value));
        var resetsAtSeconds = ReadLong(window, "resetsAt");
        DateTimeOffset? resetsAt = resetsAtSeconds is > 0
            ? DateTimeOffset.FromUnixTimeSeconds(resetsAtSeconds.Value).ToLocalTime()
            : null;
        return new PlanUsageWindow(
            clampedUsed,
            Math.Max(0, 100 - clampedUsed),
            ReadInt(window, "windowDurationMins"),
            resetsAt);
    }

    private static string? ReadString(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? ReadInt(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var parsed)
            ? parsed
            : null;

    private static long? ReadLong(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var parsed)
            ? parsed
            : null;

    private static double? ReadDouble(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var parsed)
            ? parsed
            : null;

    private static async Task<string> SafeReadAsync(Task<string> task)
    {
        try { return await task; }
        catch { return string.Empty; }
    }
}
