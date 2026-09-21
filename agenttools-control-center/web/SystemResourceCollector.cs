using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

namespace AgentToolsControlCenter.Web;

public sealed class SystemResourceCollector
{
    private static readonly TimeSpan SnapshotCacheDuration = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan GpuCacheDuration = TimeSpan.FromSeconds(5);

    private readonly object _cpuLock = new();
    private readonly SemaphoreSlim _snapshotGate = new(1, 1);
    private readonly SemaphoreSlim _gpuGate = new(1, 1);

    private CpuTimes? _lastCpuTimes;
    private SystemResourceSnapshot? _snapshot;
    private GpuCacheEntry? _gpuCache;

    public async Task<SystemResourceSnapshot> CollectAsync(CancellationToken cancellationToken)
    {
        var current = _snapshot;
        if (current is not null && DateTimeOffset.Now - current.RefreshedAt < SnapshotCacheDuration)
        {
            return current;
        }

        await _snapshotGate.WaitAsync(cancellationToken);
        try
        {
            current = _snapshot;
            if (current is not null && DateTimeOffset.Now - current.RefreshedAt < SnapshotCacheDuration)
            {
                return current;
            }

            var cpuPercent = TryGetCpuPercent();
            if (cpuPercent is null)
            {
                await Task.Delay(120, cancellationToken);
                cpuPercent = TryGetCpuPercent();
            }

            var memory = ReadMemory();
            var gpu = await GetGpuSnapshotAsync(cancellationToken);
            var snapshot = new SystemResourceSnapshot(
                DateTimeOffset.Now,
                cpuPercent,
                memory,
                gpu.Gpus,
                gpu.Error);
            _snapshot = snapshot;
            return snapshot;
        }
        finally
        {
            _snapshotGate.Release();
        }
    }

    private double? TryGetCpuPercent()
    {
        if (!TryReadCpuTimes(out var current))
        {
            return null;
        }

        lock (_cpuLock)
        {
            if (_lastCpuTimes is not { } previous)
            {
                _lastCpuTimes = current;
                return null;
            }

            _lastCpuTimes = current;
            var idleDelta = current.Idle - previous.Idle;
            var kernelDelta = current.Kernel - previous.Kernel;
            var userDelta = current.User - previous.User;
            var totalDelta = kernelDelta + userDelta;
            if (totalDelta == 0)
            {
                return null;
            }

            var busy = totalDelta > idleDelta ? totalDelta - idleDelta : 0;
            return Math.Round(Math.Clamp(busy * 100d / totalDelta, 0d, 100d), 1);
        }
    }

    private static MemoryResource ReadMemory()
    {
        var status = new MemoryStatusEx
        {
            Length = (uint)Marshal.SizeOf<MemoryStatusEx>()
        };

        if (!GlobalMemoryStatusEx(ref status) || status.TotalPhys == 0)
        {
            return new MemoryResource(0, 0, null);
        }

        var used = status.TotalPhys - status.AvailPhys;
        var percent = Math.Round(Math.Clamp(used * 100d / status.TotalPhys, 0d, 100d), 1);
        return new MemoryResource(used, status.TotalPhys, percent);
    }

    private async Task<GpuCacheEntry> GetGpuSnapshotAsync(CancellationToken cancellationToken)
    {
        var current = _gpuCache;
        if (current is not null && DateTimeOffset.Now - current.RefreshedAt < GpuCacheDuration)
        {
            return current;
        }

        await _gpuGate.WaitAsync(cancellationToken);
        try
        {
            current = _gpuCache;
            if (current is not null && DateTimeOffset.Now - current.RefreshedAt < GpuCacheDuration)
            {
                return current;
            }

            var refreshedAt = DateTimeOffset.Now;
            var nvidiaSmi = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "nvidia-smi.exe");
            if (!File.Exists(nvidiaSmi))
            {
                var unavailable = new GpuCacheEntry(refreshedAt, [], "GPU情報を取得できません（nvidia-smi未検出）。");
                _gpuCache = unavailable;
                return unavailable;
            }

            try
            {
                using var process = new Process
                {
                    StartInfo = new ProcessStartInfo
                    {
                        FileName = nvidiaSmi,
                        Arguments = "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits",
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        CreateNoWindow = true,
                    }
                };

                if (!process.Start())
                {
                    var failedToStart = new GpuCacheEntry(refreshedAt, [], "GPU情報の取得を開始できませんでした。");
                    _gpuCache = failedToStart;
                    return failedToStart;
                }

                var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
                var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(2));
                await process.WaitForExitAsync(timeout.Token);
                var stdout = await stdoutTask;
                _ = await stderrTask;

                if (process.ExitCode != 0)
                {
                    var failed = new GpuCacheEntry(refreshedAt, [], "GPU情報の取得に失敗しました。");
                    _gpuCache = failed;
                    return failed;
                }

                var gpus = ParseGpuRows(stdout);
                var entry = gpus.Count > 0
                    ? new GpuCacheEntry(refreshedAt, gpus, null)
                    : new GpuCacheEntry(refreshedAt, [], "GPU情報を取得できませんでした。");
                _gpuCache = entry;
                return entry;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                var failed = new GpuCacheEntry(refreshedAt, [], "GPU情報の取得に失敗しました。");
                _gpuCache = failed;
                return failed;
            }
        }
        finally
        {
            _gpuGate.Release();
        }
    }

    private static IReadOnlyList<GpuResource> ParseGpuRows(string output)
    {
        var result = new List<GpuResource>();
        foreach (var rawLine in output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = rawLine.Split(',', StringSplitOptions.TrimEntries);
            if (parts.Length != 6
                || !int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var index)
                || !double.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var utilization)
                || !double.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out var memoryUsedMiB)
                || !double.TryParse(parts[4], NumberStyles.Float, CultureInfo.InvariantCulture, out var memoryTotalMiB)
                || !double.TryParse(parts[5], NumberStyles.Float, CultureInfo.InvariantCulture, out var temperatureC))
            {
                continue;
            }

            var memoryPercent = memoryTotalMiB > 0
                ? Math.Round(Math.Clamp(memoryUsedMiB * 100d / memoryTotalMiB, 0d, 100d), 1)
                : 0d;
            result.Add(new GpuResource(
                index,
                parts[1],
                Math.Round(Math.Clamp(utilization, 0d, 100d), 1),
                Math.Round(memoryUsedMiB, 0),
                Math.Round(memoryTotalMiB, 0),
                memoryPercent,
                Math.Round(temperatureC, 0)));
        }

        return result;
    }

    private static bool TryReadCpuTimes(out CpuTimes times)
    {
        if (!GetSystemTimes(out var idle, out var kernel, out var user))
        {
            times = default;
            return false;
        }

        times = new CpuTimes(ToUInt64(idle), ToUInt64(kernel), ToUInt64(user));
        return true;
    }

    private static ulong ToUInt64(FileTime value) => ((ulong)value.High << 32) | value.Low;

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemTimes(out FileTime idleTime, out FileTime kernelTime, out FileTime userTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    private readonly record struct CpuTimes(ulong Idle, ulong Kernel, ulong User);
    private sealed record GpuCacheEntry(DateTimeOffset RefreshedAt, IReadOnlyList<GpuResource> Gpus, string? Error);
}

public sealed record SystemResourceSnapshot(
    DateTimeOffset RefreshedAt,
    double? CpuPercent,
    MemoryResource Ram,
    IReadOnlyList<GpuResource> Gpus,
    string? GpuError);

public sealed record MemoryResource(
    ulong UsedBytes,
    ulong TotalBytes,
    double? Percent);

public sealed record GpuResource(
    int Index,
    string Name,
    double UtilizationPercent,
    double MemoryUsedMiB,
    double MemoryTotalMiB,
    double MemoryPercent,
    double TemperatureC);
