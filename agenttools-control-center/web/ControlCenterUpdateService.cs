using System.Diagnostics;

namespace AgentToolsControlCenter.Web;

public sealed class ControlCenterUpdateService
{
    private static readonly string[] RelevantExtensions =
    [
        ".cs", ".xaml", ".csproj", ".ps1", ".bat", ".html", ".js", ".css", ".json"
    ];

    private readonly string _controlCenterRoot;
    private readonly string _desktopExe;
    private readonly string _webExe;
    private readonly string _restartScript;
    private readonly string _updateLockPath;
    private readonly int _webPort;

    public ControlCenterUpdateService(string agentToolsRoot, int webPort = 47832)
    {
        _controlCenterRoot = Path.Combine(agentToolsRoot, "agenttools-control-center");
        _desktopExe = Path.Combine(_controlCenterRoot, "dist", "AgentToolsControlCenter.exe");
        _webExe = Path.Combine(_controlCenterRoot, "web", "dist", "AgentToolsControlCenter.Web.exe");
        _restartScript = Path.Combine(_controlCenterRoot, "Apply-Update-And-Restart.ps1");
        _updateLockPath = Path.Combine(_controlCenterRoot, "state", "control-center-update.lock");
        _webPort = webPort;
    }

    public ControlCenterUpdateStatus GetStatus()
    {
        var latestSource = GetLatestSourceWriteUtc();
        var desktopPublished = GetWriteTimeUtc(_desktopExe);
        var webPublished = GetWriteTimeUtc(_webExe);
        var published = MinNullable(desktopPublished, webPublished);
        var updateAvailable = published is null || latestSource is null || latestSource.Value > published.Value.AddMilliseconds(500);

        return new ControlCenterUpdateStatus(
            UpdateAvailable: updateAvailable,
            LatestSourceAt: latestSource,
            PublishedAt: published,
            DesktopPublished: desktopPublished is not null,
            WebPublished: webPublished is not null);
    }

    public ControlCenterRestartResult RequestApplyAndRestart(bool confirm)
    {
        if (!confirm)
        {
            return new ControlCenterRestartResult(false, "明示確認が必要です。");
        }

        var status = GetStatus();
        if (!status.UpdateAvailable)
        {
            return new ControlCenterRestartResult(false, "反映待ちのControl Center更新はありません。");
        }

        if (!File.Exists(_restartScript))
        {
            return new ControlCenterRestartResult(false, "更新反映スクリプトが見つかりません。");
        }

        if (!TryAcquireUpdateLock())
        {
            return new ControlCenterRestartResult(false, "Control Centerの更新反映はすでに実行中です。");
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            WorkingDirectory = _controlCenterRoot,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-ExecutionPolicy");
        startInfo.ArgumentList.Add("Bypass");
        startInfo.ArgumentList.Add("-File");
        startInfo.ArgumentList.Add(_restartScript);
        startInfo.ArgumentList.Add("-CallerWebPid");
        startInfo.ArgumentList.Add(Environment.ProcessId.ToString());
        startInfo.ArgumentList.Add("-LockPath");
        startInfo.ArgumentList.Add(_updateLockPath);
        startInfo.ArgumentList.Add("-WebPort");
        startInfo.ArgumentList.Add(_webPort.ToString());

        try
        {
            var process = Process.Start(startInfo);
            if (process is null)
            {
                ReleaseUpdateLock();
                return new ControlCenterRestartResult(false, "更新反映プロセスを開始できませんでした。");
            }

            return new ControlCenterRestartResult(true, "更新反映と再起動を開始しました。接続は一時的に切れますが、自動で復帰します。");
        }
        catch
        {
            ReleaseUpdateLock();
            return new ControlCenterRestartResult(false, "更新反映プロセスを開始できませんでした。");
        }
    }

    private bool TryAcquireUpdateLock()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_updateLockPath)!);
        for (var attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                using var stream = new FileStream(_updateLockPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                using var writer = new StreamWriter(stream);
                writer.Write(DateTimeOffset.UtcNow.ToString("O"));
                return true;
            }
            catch (IOException)
            {
                try
                {
                    if (File.Exists(_updateLockPath) && DateTime.UtcNow - File.GetLastWriteTimeUtc(_updateLockPath) > TimeSpan.FromMinutes(10))
                    {
                        File.Delete(_updateLockPath);
                        continue;
                    }
                }
                catch
                {
                    // Treat an unreadable/unremovable lock as active.
                }
                return false;
            }
        }
        return false;
    }

    private void ReleaseUpdateLock()
    {
        try { if (File.Exists(_updateLockPath)) File.Delete(_updateLockPath); }
        catch { }
    }

    private DateTimeOffset? GetLatestSourceWriteUtc()
    {
        if (!Directory.Exists(_controlCenterRoot)) return null;

        DateTimeOffset? latest = null;
        foreach (var file in EnumerateSourceFiles(_controlCenterRoot))
        {
            if (!RelevantExtensions.Contains(Path.GetExtension(file), StringComparer.OrdinalIgnoreCase)) continue;

            DateTimeOffset write;
            try { write = File.GetLastWriteTimeUtc(file); }
            catch { continue; }
            if (latest is null || write > latest.Value) latest = write;
        }
        return latest;
    }

    private static IEnumerable<string> EnumerateSourceFiles(string root)
    {
        var pending = new Stack<string>();
        pending.Push(root);

        while (pending.Count > 0)
        {
            var directory = pending.Pop();
            string[] files;
            string[] directories;
            try
            {
                files = Directory.GetFiles(directory);
                directories = Directory.GetDirectories(directory);
            }
            catch
            {
                continue;
            }

            foreach (var file in files) yield return file;
            foreach (var child in directories)
            {
                if (!ShouldIgnoreDirectory(Path.GetFileName(child))) pending.Push(child);
            }
        }
    }

    private static bool ShouldIgnoreDirectory(string name)
        => name.Equals("bin", StringComparison.OrdinalIgnoreCase)
            || name.Equals("obj", StringComparison.OrdinalIgnoreCase)
            || name.Equals("dist", StringComparison.OrdinalIgnoreCase)
            || name.Equals("state", StringComparison.OrdinalIgnoreCase)
            || name.Equals("tests", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("dist.update-backup-", StringComparison.OrdinalIgnoreCase);

    private static DateTimeOffset? GetWriteTimeUtc(string path)
    {
        try { return File.Exists(path) ? File.GetLastWriteTimeUtc(path) : null; }
        catch { return null; }
    }

    private static DateTimeOffset? MinNullable(DateTimeOffset? left, DateTimeOffset? right)
    {
        if (left is null || right is null) return null;
        return left.Value <= right.Value ? left : right;
    }
}

public sealed record ControlCenterUpdateStatus(
    bool UpdateAvailable,
    DateTimeOffset? LatestSourceAt,
    DateTimeOffset? PublishedAt,
    bool DesktopPublished,
    bool WebPublished);

public sealed record ControlCenterRestartResult(bool Accepted, string Message);
