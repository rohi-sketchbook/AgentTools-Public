using System.IO;
using System.Text;
using System.Text.Json;
using AgentToolsControlCenter.Models;

namespace AgentToolsControlCenter.Services;

public sealed class StatusCollector
{
    private readonly CommandRunner _runner = new();

    public StatusCollector()
    {
        AgentToolsRoot = LocateAgentToolsRoot();
        GatewayRoot = Path.Combine(AgentToolsRoot, "agenttools-mcp-gateway");
        var local = LoadLocalConfig(AgentToolsRoot);
        ViewerRoot = ResolveOptionalPath(FirstNonBlank(
            Environment.GetEnvironmentVariable("AGENTTOOLS_UNITY_PROJECT"),
            local.UnityProjectRoot));
        DevlogSiteRoot = ResolveOptionalPath(FirstNonBlank(
            Environment.GetEnvironmentVariable("AGENTTOOLS_DEVLOG_SITE_ROOT"),
            local.DevlogSiteRoot));
        DiscordTaskName = FirstNonBlank(
            Environment.GetEnvironmentVariable("AGENTTOOLS_DISCORD_TASK_NAME"),
            local.DiscordTaskName,
            "AgentTools-DiscordBot")!;
    }

    public string AgentToolsRoot { get; }
    public string GatewayRoot { get; }
    public string? ViewerRoot { get; }
    public string? DevlogSiteRoot { get; }
    public string DiscordTaskName { get; }

    public async Task<IReadOnlyList<ServiceStatus>> CollectAsync(CancellationToken cancellationToken = default)
    {
        var tasks = new Task<ServiceStatus>[]
        {
            CollectGatewayAsync(cancellationToken),
            CollectDevSpaceAsync(cancellationToken),
            CollectWatchdogAsync(cancellationToken),
            CollectIdleUiQaAsync(cancellationToken),
            CollectLocalAiAsync(cancellationToken),
            CollectDiscordAsync(cancellationToken),
            CollectUnitySkillsAsync(cancellationToken),
            CollectDevlogAsync(cancellationToken)
        };

        return await Task.WhenAll(tasks);
    }

    public async Task<ProcessResult> RestartAsync(string serviceId, CancellationToken cancellationToken = default)
    {
        return serviceId switch
        {
            "devspace" => await RunDevSpaceControlAsync("restart", cancellationToken),
            "watchdog" => await RestartScheduledTaskAsync("AgentTools-DevSpaceWatchdog", cancellationToken),
            "uiqa" => await RestartScheduledTaskAsync("AgentTools-IdleUiQA", cancellationToken),
            "discord" => await RestartScheduledTaskAsync(DiscordTaskName, cancellationToken),
            _ => new ProcessResult(-1, string.Empty, "このサービスには再起動操作が定義されていません。", false)
        };
    }

    public Task<ProcessResult> StartDevSpaceAsync(CancellationToken cancellationToken = default)
        => RunDevSpaceControlAsync("start", cancellationToken);

    public Task<ProcessResult> StopDevSpaceAsync(CancellationToken cancellationToken = default)
        => RunDevSpaceControlAsync("stop", cancellationToken);

    public Task<ProcessResult> DiagnoseDevSpaceAsync(CancellationToken cancellationToken = default)
        => RunDevSpaceControlAsync("doctor", cancellationToken);

    private Task<ProcessResult> RunDevSpaceControlAsync(string action, CancellationToken cancellationToken)
    {
        var script = Path.Combine(GatewayRoot, "scripts", "devspace-manual-control.js");
        return _runner.RunAsync(
            "node.exe",
            [script, action],
            GatewayRoot,
            TimeSpan.FromSeconds(90),
            cancellationToken);
    }

    private async Task<ProcessResult> RestartScheduledTaskAsync(string taskName, CancellationToken cancellationToken)
    {
        var escaped = EscapePowerShellLiteral(taskName);
        var script = "$name='" + escaped + "'; " +
                     "$task=Get-ScheduledTask -TaskName $name -ErrorAction Stop; " +
                     "if($task.State -eq 'Running'){Stop-ScheduledTask -TaskName $name -ErrorAction Stop; Start-Sleep -Milliseconds 700}; " +
                     "Start-ScheduledTask -TaskName $name -ErrorAction Stop; " +
                     "@{ok=$true;taskName=$name} | ConvertTo-Json -Compress";
        return await RunPowerShellAsync(script, TimeSpan.FromSeconds(20), cancellationToken);
    }

    private async Task<ServiceStatus> CollectGatewayAsync(CancellationToken cancellationToken)
    {
        var checkedAt = DateTimeOffset.Now;
        try
        {
            using var json = await RunGatewayJsonAsync(["gateway", "health"], cancellationToken);
            if (json is null)
            {
                return ErrorStatus("gateway", "AgentTools Gateway", "応答なし", "Gateway CLIからJSON応答を取得できませんでした。", checkedAt, Path.Combine(GatewayRoot, "logs"));
            }

            var root = json.RootElement;
            var ok = ReadBool(root, "ok") == true;
            var status = ReadString(root, "status") ?? "unknown";
            var version = ReadString(root, "version") ?? "不明";
            var transport = ReadString(root, "transport") ?? "不明";
            var writeEnabled = ReadBool(root, "safety", "writeActionsEnabled") == true;
            var externalEnabled = ReadBool(root, "safety", "externalActionsEnabled") == true;
            var missingFiles = CountArrayWhere(root, "files", item => ReadBool(item, "exists") != true);

            var health = ok && status == "healthy" && missingFiles == 0
                ? ServiceHealth.Healthy
                : ServiceHealth.Warning;

            var details = new StringBuilder()
                .AppendLine($"バージョン: {version}")
                .AppendLine($"Transport: {transport}")
                .AppendLine($"必須ファイル欠落: {missingFiles}")
                .AppendLine($"書込操作: {(writeEnabled ? "有効" : "無効")}")
                .AppendLine($"外部操作: {(externalEnabled ? "有効" : "無効")}")
                .AppendLine($"Root: {GatewayRoot}")
                .ToString().TrimEnd();

            return new ServiceStatus
            {
                Id = "gateway",
                DisplayName = "AgentTools Gateway",
                Health = health,
                StatusText = health == ServiceHealth.Healthy ? "正常" : "警告",
                Summary = $"v{version} / {transport}",
                Details = details,
                CheckedAt = checkedAt,
                LogPath = Path.Combine(GatewayRoot, "logs"),
                CanRecover = false
            };
        }
        catch (Exception ex)
        {
            return ErrorStatus("gateway", "AgentTools Gateway", "確認失敗", ex.Message, checkedAt, Path.Combine(GatewayRoot, "logs"));
        }
    }

    private async Task<ServiceStatus> CollectDevSpaceAsync(CancellationToken cancellationToken)
    {
        var checkedAt = DateTimeOffset.Now;
        try
        {
            using var json = await RunGatewayJsonAsync(["devspace", "health"], cancellationToken);
            if (json is null)
            {
                return ErrorStatus("devspace", "DevSpace", "応答なし", "DevSpace healthを取得できませんでした。", checkedAt, Path.Combine(GatewayRoot, "state", "devspace"), true);
            }

            var root = json.RootElement;
            var status = ReadString(root, "status") ?? "unknown";
            var processRunning = ReadBool(root, "processRunning") == true;
            var healthResponsive = ReadBool(root, "healthResponsive") == true;
            var mcpResponsive = ReadBool(root, "mcpResponsive") == true;
            var pid = ReadInt(root, "pid");
            var version = ReadString(root, "version") ?? "不明";
            var host = ReadString(root, "endpoint", "host") ?? "127.0.0.1";
            var port = ReadInt(root, "endpoint", "port");

            var health = status switch
            {
                "healthy" => ServiceHealth.Healthy,
                "stopped" => ServiceHealth.Stopped,
                "unresponsive" or "degraded" => ServiceHealth.Warning,
                _ => processRunning ? ServiceHealth.Warning : ServiceHealth.Unknown
            };

            var statusText = status switch
            {
                "healthy" => "正常",
                "stopped" => "停止",
                "unresponsive" => "無応答",
                "degraded" => "縮退",
                _ => "不明"
            };

            var details = new StringBuilder()
                .AppendLine($"PID: {(pid?.ToString() ?? "なし")}")
                .AppendLine($"バージョン: {version}")
                .AppendLine($"Endpoint: {host}:{port?.ToString() ?? "?"}")
                .AppendLine($"Process: {(processRunning ? "起動" : "停止")}")
                .AppendLine($"/healthz: {(healthResponsive ? "応答" : "応答なし")}")
                .AppendLine($"MCP route: {(mcpResponsive ? "応答" : "応答なし")}")
                .ToString().TrimEnd();

            return new ServiceStatus
            {
                Id = "devspace",
                DisplayName = "DevSpace",
                Health = health,
                StatusText = statusText,
                Summary = processRunning
                    ? $"PID {pid?.ToString() ?? "?"} / {host}:{port?.ToString() ?? "?"}"
                    : "プロセスが見つかりません",
                Details = details,
                CheckedAt = checkedAt,
                LogPath = Path.Combine(GatewayRoot, "state", "devspace"),
                CanRecover = true
            };
        }
        catch (Exception ex)
        {
            return ErrorStatus("devspace", "DevSpace", "確認失敗", ex.Message, checkedAt, Path.Combine(GatewayRoot, "state", "devspace"), true);
        }
    }

    private async Task<ServiceStatus> CollectWatchdogAsync(CancellationToken cancellationToken)
    {
        var checkedAt = DateTimeOffset.Now;
        try
        {
            using var json = await RunGatewayJsonAsync(["watchdog", "status"], cancellationToken);
            if (json is null)
            {
                return ErrorStatus("watchdog", "DevSpace Watchdog", "応答なし", "Watchdog状態を取得できませんでした。", checkedAt, Path.Combine(GatewayRoot, "state", "devspace"), true);
            }

            var root = json.RootElement;
            var enabled = ReadBool(root, "enabled") == true;
            var running = ReadBool(root, "running") == true;
            var pid = ReadInt(root, "pid");
            var lastStatus = ReadString(root, "state", "lastStatus") ?? "unknown";
            var failures = ReadInt(root, "state", "consecutiveFailures") ?? 0;
            var lastCheck = ReadDate(root, "state", "lastCheckAt");
            var lastRecoveryOk = ReadBool(root, "state", "lastRecoveryOk");
            var circuitOpenUntil = ReadDate(root, "state", "circuitOpenUntil");

            var health = !enabled || !running
                ? ServiceHealth.Stopped
                : lastStatus == "healthy" && failures == 0 && circuitOpenUntil is null
                    ? ServiceHealth.Healthy
                    : ServiceHealth.Warning;

            var details = new StringBuilder()
                .AppendLine($"PID: {(pid?.ToString() ?? "なし")}")
                .AppendLine($"監視: {(enabled ? "有効" : "無効")}")
                .AppendLine($"最終判定: {lastStatus}")
                .AppendLine($"連続失敗: {failures}")
                .AppendLine($"最終確認: {FormatLocalDate(lastCheck)}")
                .AppendLine($"最終復旧: {(lastRecoveryOk is null ? "未実行" : lastRecoveryOk == true ? "成功" : "失敗")}")
                .AppendLine($"Circuit breaker: {(circuitOpenUntil is null ? "閉" : $"開 ({FormatLocalDate(circuitOpenUntil)})")}")
                .ToString().TrimEnd();

            return new ServiceStatus
            {
                Id = "watchdog",
                DisplayName = "DevSpace Watchdog",
                Health = health,
                StatusText = health switch
                {
                    ServiceHealth.Healthy => "監視中",
                    ServiceHealth.Stopped => "停止",
                    _ => "警告"
                },
                Summary = running ? $"PID {pid?.ToString() ?? "?"} / 連続失敗 {failures}" : "Watchdogが停止しています",
                Details = details,
                CheckedAt = checkedAt,
                LogPath = Path.Combine(GatewayRoot, "state", "devspace"),
                CanRecover = true
            };
        }
        catch (Exception ex)
        {
            return ErrorStatus("watchdog", "DevSpace Watchdog", "確認失敗", ex.Message, checkedAt, Path.Combine(GatewayRoot, "state", "devspace"), true);
        }
    }

    private async Task<ServiceStatus> CollectIdleUiQaAsync(CancellationToken cancellationToken)
    {
        var checkedAt = DateTimeOffset.Now;
        try
        {
            using var json = await RunGatewayJsonAsync(["uiqa", "status"], cancellationToken, TimeSpan.FromSeconds(15));
            if (json is null)
            {
                return ErrorStatus("uiqa", "Idle UI QA", "応答なし", "Idle UI QA状態を取得できませんでした。", checkedAt, Path.Combine(GatewayRoot, "state", "idle-ui-qa"), true);
            }

            var root = json.RootElement;
            var ok = ReadBool(root, "ok") == true;
            var enabled = ReadBool(root, "enabled") == true;
            var developmentActive = ReadBool(root, "developmentActive") == true;
            var idleMinutes = ReadInt(root, "idleMinutes") ?? 30;
            var openIssues = ReadInt(root, "issues", "open") ?? 0;
            var lastStatus = ReadString(root, "state", "lastRunStatus") ?? "never";
            var lastReason = ReadString(root, "state", "lastRunReason") ?? "未実行";
            var lastRun = ReadDate(root, "state", "lastRunAt");
            var lastCheck = ReadDate(root, "state", "lastCheckAt");
            var lastImages = ReadInt(root, "state", "lastImageCount") ?? 0;
            var lastNewIssues = ReadInt(root, "state", "lastNewIssues") ?? 0;

            var health = !ok || lastStatus == "error"
                ? ServiceHealth.Warning
                : developmentActive
                    ? ServiceHealth.Busy
                    : !enabled
                        ? ServiceHealth.Stopped
                        : ServiceHealth.Healthy;

            var statusText = developmentActive
                ? "開発中・待機"
                : lastStatus switch
                {
                    "issues" => "指摘あり",
                    "passed" => "問題なし",
                    "waiting_idle" => "アイドル待ち",
                    "waiting_images" => "画像待ち",
                    "error" => "警告",
                    _ => enabled ? "待機" : "停止"
                };

            var details = new StringBuilder()
                .AppendLine($"アイドル判定: {idleMinutes}分")
                .AppendLine($"開発中: {(developmentActive ? "はい" : "いいえ")}")
                .AppendLine($"未解決指摘: {openIssues}")
                .AppendLine($"最終状態: {lastStatus}")
                .AppendLine($"理由: {lastReason}")
                .AppendLine($"前回画像: {lastImages}枚 / 新規指摘 {lastNewIssues}件")
                .AppendLine($"最終QA: {FormatLocalDate(lastRun)}")
                .AppendLine($"最終確認: {FormatLocalDate(lastCheck)}")
                .ToString().TrimEnd();

            return new ServiceStatus
            {
                Id = "uiqa",
                DisplayName = "Idle UI QA",
                Health = health,
                StatusText = statusText,
                Summary = developmentActive
                    ? "開発作業が終わるまで待機"
                    : openIssues > 0
                        ? $"未解決 {openIssues}件 / {lastReason}"
                        : lastReason,
                Details = details,
                CheckedAt = checkedAt,
                LogPath = Path.Combine(GatewayRoot, "state", "idle-ui-qa"),
                CanRecover = true
            };
        }
        catch (Exception ex)
        {
            return ErrorStatus("uiqa", "Idle UI QA", "確認失敗", ex.Message, checkedAt, Path.Combine(GatewayRoot, "state", "idle-ui-qa"), true);
        }
    }

    private async Task<ServiceStatus> CollectLocalAiAsync(CancellationToken cancellationToken)
    {
        var checkedAt = DateTimeOffset.Now;
        var localAiRoot = Path.Combine(AgentToolsRoot, "local-ai");
        try
        {
            using var json = await RunGatewayJsonAsync(["localAi", "status"], cancellationToken, TimeSpan.FromSeconds(12));
            if (json is null)
            {
                return ErrorStatus("localai", "Local AI", "応答なし", "Local AI状態を取得できませんでした。", checkedAt, localAiRoot);
            }

            var root = json.RootElement;
            var state = ReadString(root, "status") ?? "unknown";
            var matrixInstalled = ReadBool(root, "stabilityMatrix", "installed") == true;
            var matrixRunning = ReadBool(root, "stabilityMatrix", "running") == true;
            var comfyInstalled = ReadBool(root, "stabilityMatrix", "comfyUi", "installed") == true;
            var comfyOnline = ReadBool(root, "comfyUi", "online") == true;
            var endpoint = ReadString(root, "comfyUi", "endpoint") ?? "http://127.0.0.1:8188";
            var responseMs = ReadInt(root, "comfyUi", "responseMs");
            var runningJobs = ReadInt(root, "comfyUi", "queue", "running") ?? 0;
            var pendingJobs = ReadInt(root, "comfyUi", "queue", "pending") ?? 0;
            var comfyVersion = ReadString(root, "comfyUi", "system", "comfyUiVersion") ?? "不明";
            var gpuName = "不明";
            long? vramTotal = null;
            long? vramFree = null;
            var devices = Find(root, "comfyUi", "system", "devices");
            if (devices.HasValue && devices.Value.ValueKind == JsonValueKind.Array)
            {
                var first = devices.Value.EnumerateArray().FirstOrDefault();
                if (first.ValueKind == JsonValueKind.Object)
                {
                    gpuName = ReadString(first, "name") ?? "不明";
                    vramTotal = ReadLong(first, "vramTotal");
                    vramFree = ReadLong(first, "vramFree");
                }
            }

            var health = state switch
            {
                "ready" when runningJobs > 0 || pendingJobs > 0 => ServiceHealth.Busy,
                "ready" => ServiceHealth.Healthy,
                "installed" => ServiceHealth.Healthy,
                "degraded" => ServiceHealth.Warning,
                "missing" => ServiceHealth.Warning,
                _ => ServiceHealth.Unknown
            };
            var statusText = state switch
            {
                "ready" when runningJobs > 0 || pendingJobs > 0 => "生成中",
                "ready" => "利用可能",
                "installed" => "待機",
                "degraded" => "警告",
                "missing" => "未構成",
                _ => "不明"
            };

            var details = new StringBuilder()
                .AppendLine($"Stability Matrix: {(matrixInstalled ? matrixRunning ? "起動中" : "インストール済み" : "未検出")}")
                .AppendLine($"ComfyUI package: {(comfyInstalled ? "インストール済み" : "未検出")}")
                .AppendLine($"ComfyUI API: {(comfyOnline ? "online" : "offline")}")
                .AppendLine($"Endpoint: {endpoint}")
                .AppendLine($"ComfyUI version: {comfyVersion}")
                .AppendLine($"応答: {(responseMs?.ToString() ?? "-")} ms")
                .AppendLine($"Queue: running {runningJobs} / pending {pendingJobs}")
                .AppendLine($"GPU: {gpuName}")
                .AppendLine($"VRAM: {FormatBytes(vramFree)} free / {FormatBytes(vramTotal)} total")
                .AppendLine($"AgentTools: {localAiRoot}")
                .ToString().TrimEnd();

            var summary = comfyOnline
                ? $"ComfyUI online / Queue {runningJobs}+{pendingJobs} / {gpuName}"
                : matrixInstalled && comfyInstalled
                    ? "Stability Matrix / ComfyUI 準備済み（オンデマンド起動）"
                    : "Stability Matrix または ComfyUI を確認してください";

            return new ServiceStatus
            {
                Id = "localai",
                DisplayName = "Local AI",
                Health = health,
                StatusText = statusText,
                Summary = summary,
                Details = details,
                CheckedAt = checkedAt,
                LogPath = Directory.Exists(localAiRoot) ? localAiRoot : null,
                CanRecover = false
            };
        }
        catch (Exception ex)
        {
            return ErrorStatus("localai", "Local AI", "確認失敗", ex.Message, checkedAt, localAiRoot);
        }
    }

    private async Task<ServiceStatus> CollectDiscordAsync(CancellationToken cancellationToken)
    {
        var checkedAt = DateTimeOffset.Now;
        var logPath = Path.Combine(AgentToolsRoot, "discord-bot", "discord-chatgpt-bridge", "logs");
        try
        {
            using var taskJson = await GetScheduledTaskJsonAsync(DiscordTaskName, cancellationToken);
            using var processJson = await GetProcessProbeJsonAsync(["codex-discord-connector", "discord-chatgpt-bridge", "discord-codex-bridge"], cancellationToken);

            var taskExists = taskJson is not null && ReadBool(taskJson.RootElement, "exists") == true;
            var taskState = taskJson is null ? "unknown" : ReadString(taskJson.RootElement, "state") ?? "unknown";
            var lastTaskResult = taskJson is null ? null : ReadInt(taskJson.RootElement, "lastTaskResult");
            var lastRun = taskJson is null ? null : ReadDate(taskJson.RootElement, "lastRunTime");
            var processCount = processJson is null ? 0 : ReadInt(processJson.RootElement, "count") ?? 0;

            var health = processCount > 0
                ? ServiceHealth.Healthy
                : taskExists && taskState is "Ready" or "Running"
                    ? ServiceHealth.Warning
                    : ServiceHealth.Stopped;

            var details = new StringBuilder()
                .AppendLine($"Scheduled Task: {(taskExists ? "登録済み" : "未登録")}")
                .AppendLine($"Task状態: {taskState}")
                .AppendLine($"検出プロセス: {processCount}")
                .AppendLine($"最終実行: {FormatLocalDate(lastRun)}")
                .AppendLine($"最終結果コード: {(lastTaskResult?.ToString() ?? "不明")}")
                .AppendLine($"Root: {Path.Combine(AgentToolsRoot, "discord-bot")}")
                .ToString().TrimEnd();

            return new ServiceStatus
            {
                Id = "discord",
                DisplayName = "Discord Bot",
                Health = health,
                StatusText = health == ServiceHealth.Healthy ? "起動中" : health == ServiceHealth.Warning ? "要確認" : "停止",
                Summary = processCount > 0 ? $"{processCount}プロセスを検出" : $"Task: {taskState}",
                Details = details,
                CheckedAt = checkedAt,
                LogPath = Directory.Exists(logPath) ? logPath : Path.Combine(AgentToolsRoot, "discord-bot"),
                CanRecover = taskExists
            };
        }
        catch (Exception ex)
        {
            return ErrorStatus("discord", "Discord Bot", "確認失敗", ex.Message, checkedAt, logPath, true);
        }
    }

    private async Task<ServiceStatus> CollectUnitySkillsAsync(CancellationToken cancellationToken)
    {
        var checkedAt = DateTimeOffset.Now;
        var viewerRoot = ViewerRoot;
        if (string.IsNullOrWhiteSpace(viewerRoot))
        {
            return new ServiceStatus
            {
                Id = "unityskills",
                DisplayName = "UnitySkills",
                Health = ServiceHealth.Unknown,
                StatusText = "未設定",
                Summary = "Unity Projectはlocal設定で指定できます",
                Details = "agenttools-control-center/config.local.json の unityProjectRoot、または AGENTTOOLS_UNITY_PROJECT を設定してください。",
                CheckedAt = checkedAt,
                CanRecover = false
            };
        }

        var configPath = Path.Combine(viewerRoot, "Library", "UnitySkills", "cli_config.json");
        try
        {
            if (!File.Exists(configPath))
            {
                return new ServiceStatus
                {
                    Id = "unityskills",
                    DisplayName = "UnitySkills",
                    Health = ServiceHealth.Unknown,
                    StatusText = "未設定",
                    Summary = "cli_config.jsonが見つかりません",
                    Details = configPath,
                    CheckedAt = checkedAt,
                    LogPath = Path.Combine(viewerRoot, "Logs"),
                    CanRecover = false
                };
            }

            using var config = JsonDocument.Parse(await File.ReadAllTextAsync(configPath, cancellationToken));
            using var processJson = await GetProcessProbeJsonAsync(["Unity.exe"], cancellationToken, processNameOnly: true);
            var root = config.RootElement;
            var enabled = ReadBool(root, "enabled") == true;
            var cliVersion = ReadString(root, "cliVersion") ?? "不明";
            var editorVersion = ReadString(root, "editorVersion") ?? "不明";
            var boundAt = ReadDate(root, "boundAt");
            var processCount = processJson is null ? 0 : ReadInt(processJson.RootElement, "count") ?? 0;

            var health = !enabled
                ? ServiceHealth.Stopped
                : processCount > 0
                    ? ServiceHealth.Healthy
                    : ServiceHealth.Stopped;

            var details = new StringBuilder()
                .AppendLine($"設定: {(enabled ? "有効" : "無効")}")
                .AppendLine($"Unityプロセス: {processCount}")
                .AppendLine($"Unity CLI: {cliVersion}")
                .AppendLine($"Editor: {editorVersion}")
                .AppendLine($"Cold Start: {(ReadBool(root, "features", "coldStart") == true ? "対応" : "非対応")}")
                .AppendLine($"Binding更新: {FormatLocalDate(boundAt)}")
                .AppendLine($"設定ファイル: {configPath}")
                .ToString().TrimEnd();

            return new ServiceStatus
            {
                Id = "unityskills",
                DisplayName = "UnitySkills",
                Health = health,
                StatusText = processCount > 0 ? "接続可能" : "Unity停止中",
                Summary = processCount > 0 ? $"Unity {editorVersion}" : $"設定済み / CLI {cliVersion}",
                Details = details,
                CheckedAt = checkedAt,
                LogPath = Path.Combine(viewerRoot, "Logs"),
                CanRecover = false
            };
        }
        catch (Exception ex)
        {
            return ErrorStatus("unityskills", "UnitySkills", "確認失敗", ex.Message, checkedAt, Path.Combine(viewerRoot, "Logs"));
        }
    }

    private async Task<ServiceStatus> CollectDevlogAsync(CancellationToken cancellationToken)
    {
        var checkedAt = DateTimeOffset.Now;
        var logs = Path.Combine(AgentToolsRoot, "devlog-codex-runner", "logs");
        var devlogSiteRoot = DevlogSiteRoot;
        if (string.IsNullOrWhiteSpace(devlogSiteRoot))
        {
            return new ServiceStatus
            {
                Id = "devlog",
                DisplayName = "開発日記Runner",
                Health = ServiceHealth.Unknown,
                StatusText = "未設定",
                Summary = "開発日記サイトはoptionalです",
                Details = "agenttools-control-center/config.local.json の devlogSiteRoot、または AGENTTOOLS_DEVLOG_SITE_ROOT を設定してください。",
                CheckedAt = checkedAt,
                LogPath = Directory.Exists(logs) ? logs : null,
                CanRecover = false
            };
        }

        try
        {
            using var processJson = await GetProcessProbeJsonAsync(["run-devlog-pipeline.mjs", "start-devlog-pipeline.mjs"], cancellationToken);
            var processCount = processJson is null ? 0 : ReadInt(processJson.RootElement, "count") ?? 0;
            var workRoot = Path.Combine(devlogSiteRoot, ".devlog-work");
            var latestStatusPath = Directory.Exists(workRoot)
                ? Directory.GetDirectories(workRoot)
                    .Select(path => Path.Combine(path, "status.json"))
                    .Where(File.Exists)
                    .OrderByDescending(path => Path.GetFileName(Path.GetDirectoryName(path)))
                    .FirstOrDefault()
                : null;

            if (latestStatusPath is null)
            {
                return new ServiceStatus
                {
                    Id = "devlog",
                    DisplayName = "開発日記Runner",
                    Health = processCount > 0 ? ServiceHealth.Busy : ServiceHealth.Unknown,
                    StatusText = processCount > 0 ? "実行中" : "履歴なし",
                    Summary = "status.jsonが見つかりません",
                    Details = $"Work root: {workRoot}",
                    CheckedAt = checkedAt,
                    LogPath = logs,
                    CanRecover = false
                };
            }

            using var statusJson = JsonDocument.Parse(await File.ReadAllTextAsync(latestStatusPath, cancellationToken));
            var root = statusJson.RootElement;
            var date = ReadString(root, "date") ?? "不明";
            var stage = ReadString(root, "stage") ?? "unknown";
            var published = ReadBool(root, "published") == true;
            var error = ReadString(root, "error");
            var updatedAt = ReadDate(root, "updated_at");

            var health = processCount > 0
                ? ServiceHealth.Busy
                : published && stage == "published"
                    ? ServiceHealth.Healthy
                    : error is not null || stage.Contains("failed", StringComparison.OrdinalIgnoreCase)
                        ? ServiceHealth.Warning
                        : ServiceHealth.Warning;

            var details = new StringBuilder()
                .AppendLine($"対象日: {date}")
                .AppendLine($"Stage: {stage}")
                .AppendLine($"公開済み: {(published ? "はい" : "いいえ")}")
                .AppendLine($"実行プロセス: {processCount}")
                .AppendLine($"更新日時: {FormatLocalDate(updatedAt)}")
                .AppendLine($"Error: {error ?? "なし"}")
                .AppendLine($"Status: {latestStatusPath}")
                .ToString().TrimEnd();

            return new ServiceStatus
            {
                Id = "devlog",
                DisplayName = "開発日記Runner",
                Health = health,
                StatusText = processCount > 0 ? "実行中" : published ? "公開完了" : "要確認",
                Summary = $"{date} / {stage}",
                Details = details,
                CheckedAt = checkedAt,
                LogPath = logs,
                CanRecover = false
            };
        }
        catch (Exception ex)
        {
            return ErrorStatus("devlog", "開発日記Runner", "確認失敗", ex.Message, checkedAt, logs);
        }
    }

    private async Task<JsonDocument?> RunGatewayJsonAsync(
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken,
        TimeSpan? timeout = null)
    {
        var args = new List<string> { "src/cli.js" };
        args.AddRange(arguments);
        var result = await _runner.RunAsync("node.exe", args, GatewayRoot, timeout ?? TimeSpan.FromSeconds(15), cancellationToken);
        return ParseJson(result.StandardOutput);
    }

    private async Task<JsonDocument?> GetScheduledTaskJsonAsync(string taskName, CancellationToken cancellationToken)
    {
        var escaped = EscapePowerShellLiteral(taskName);
        var script = "$name='" + escaped + "'; " +
                     "$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; " +
                     "if($null -eq $task){@{exists=$false;taskName=$name}|ConvertTo-Json -Compress;exit}; " +
                     "$info=Get-ScheduledTaskInfo -TaskName $name; " +
                     "@{exists=$true;taskName=$name;state=$task.State.ToString();lastRunTime=$info.LastRunTime;nextRunTime=$info.NextRunTime;lastTaskResult=$info.LastTaskResult}|ConvertTo-Json -Compress";
        var result = await RunPowerShellAsync(script, TimeSpan.FromSeconds(10), cancellationToken);
        return ParseJson(result.StandardOutput);
    }

    private async Task<JsonDocument?> GetProcessProbeJsonAsync(
        IReadOnlyList<string> patterns,
        CancellationToken cancellationToken,
        bool processNameOnly = false)
    {
        string predicate;
        if (processNameOnly)
        {
            var conditions = patterns.Select(pattern => "$_.Name -like '*" + EscapePowerShellWildcard(pattern) + "*'");
            predicate = string.Join(" -or ", conditions);
        }
        else
        {
            var conditions = patterns.Select(pattern => "$line -like '*" + EscapePowerShellWildcard(pattern) + "*'");
            predicate = string.Join(" -or ", conditions);
        }

        var script = processNameOnly
            ? "$items=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (" + predicate + ") } | Select-Object ProcessId,Name); " +
              "@{count=$items.Count;pids=@($items|ForEach-Object{$_.ProcessId})}|ConvertTo-Json -Compress"
            : "$items=@(Get-CimInstance Win32_Process | Where-Object { $line=$_.CommandLine; $_.ProcessId -ne $PID -and $line -and (" + predicate + ") } | Select-Object ProcessId,Name); " +
              "@{count=$items.Count;pids=@($items|ForEach-Object{$_.ProcessId})}|ConvertTo-Json -Compress";

        var result = await RunPowerShellAsync(script, TimeSpan.FromSeconds(12), cancellationToken);
        return ParseJson(result.StandardOutput);
    }

    private Task<ProcessResult> RunPowerShellAsync(string script, TimeSpan timeout, CancellationToken cancellationToken)
    {
        return _runner.RunAsync(
            "powershell.exe",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            AgentToolsRoot,
            timeout,
            cancellationToken);
    }

    private static JsonDocument? ParseJson(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var trimmed = text.Trim().TrimStart('\uFEFF');
        try
        {
            return JsonDocument.Parse(trimmed);
        }
        catch
        {
            var objectStart = trimmed.IndexOf('{');
            var objectEnd = trimmed.LastIndexOf('}');
            if (objectStart >= 0 && objectEnd > objectStart)
            {
                try
                {
                    return JsonDocument.Parse(trimmed[objectStart..(objectEnd + 1)]);
                }
                catch
                {
                    return null;
                }
            }

            return null;
        }
    }

    private static ServiceStatus ErrorStatus(
        string id,
        string name,
        string statusText,
        string error,
        DateTimeOffset checkedAt,
        string? logPath,
        bool canRecover = false)
    {
        return new ServiceStatus
        {
            Id = id,
            DisplayName = name,
            Health = ServiceHealth.Unknown,
            StatusText = statusText,
            Summary = "状態を取得できませんでした",
            Details = error,
            CheckedAt = checkedAt,
            LogPath = logPath,
            CanRecover = canRecover
        };
    }

    private static JsonElement? Find(JsonElement root, params string[] path)
    {
        var current = root;
        foreach (var segment in path)
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
            {
                return null;
            }
        }
        return current;
    }

    private static string? ReadString(JsonElement root, params string[] path)
    {
        var value = Find(root, path);
        if (value is null || value.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
        return value.Value.ValueKind == JsonValueKind.String ? value.Value.GetString() : value.Value.ToString();
    }

    private static bool? ReadBool(JsonElement root, params string[] path)
    {
        var value = Find(root, path);
        if (value is null) return null;
        return value.Value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String when bool.TryParse(value.Value.GetString(), out var parsed) => parsed,
            _ => null
        };
    }

    private static int? ReadInt(JsonElement root, params string[] path)
    {
        var value = Find(root, path);
        if (value is null) return null;
        if (value.Value.ValueKind == JsonValueKind.Number && value.Value.TryGetInt32(out var number)) return number;
        return int.TryParse(value.Value.ToString(), out number) ? number : null;
    }

    private static long? ReadLong(JsonElement root, params string[] path)
    {
        var value = Find(root, path);
        if (value is null) return null;
        if (value.Value.ValueKind == JsonValueKind.Number && value.Value.TryGetInt64(out var number)) return number;
        return long.TryParse(value.Value.ToString(), out number) ? number : null;
    }

    private static DateTimeOffset? ReadDate(JsonElement root, params string[] path)
    {
        var text = ReadString(root, path);
        if (string.IsNullOrWhiteSpace(text)) return null;
        return DateTimeOffset.TryParse(text, out var value) ? value : null;
    }

    private static int CountArrayWhere(JsonElement root, string property, Func<JsonElement, bool> predicate)
    {
        var value = Find(root, property);
        if (value is null || value.Value.ValueKind != JsonValueKind.Array) return 0;
        return value.Value.EnumerateArray().Count(predicate);
    }

    private static string FormatLocalDate(DateTimeOffset? value)
    {
        return value is null ? "不明" : value.Value.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");
    }

    private static string FormatBytes(long? value)
    {
        if (value is null || value < 0) return "不明";
        var bytes = (double)value.Value;
        if (bytes >= 1024d * 1024d * 1024d) return $"{bytes / (1024d * 1024d * 1024d):0.0} GB";
        if (bytes >= 1024d * 1024d) return $"{bytes / (1024d * 1024d):0.0} MB";
        if (bytes >= 1024d) return $"{bytes / 1024d:0.0} KB";
        return $"{bytes:0} B";
    }

    private static string EscapePowerShellLiteral(string value) => value.Replace("'", "''", StringComparison.Ordinal);

    private static string EscapePowerShellWildcard(string value)
    {
        return value
            .Replace("`", "``", StringComparison.Ordinal)
            .Replace("'", "''", StringComparison.Ordinal)
            .Replace("[", "`[", StringComparison.Ordinal)
            .Replace("]", "`]", StringComparison.Ordinal);
    }

    private sealed class LocalConfig
    {
        public string? UnityProjectRoot { get; init; }
        public string? DevlogSiteRoot { get; init; }
        public string? DiscordTaskName { get; init; }
    }

    private static LocalConfig LoadLocalConfig(string agentToolsRoot)
    {
        var configuredPath = Environment.GetEnvironmentVariable("AGENTTOOLS_CONTROL_CENTER_CONFIG");
        var configPath = !string.IsNullOrWhiteSpace(configuredPath)
            ? Path.GetFullPath(Environment.ExpandEnvironmentVariables(configuredPath))
            : Path.Combine(agentToolsRoot, "agenttools-control-center", "config.local.json");

        if (!File.Exists(configPath)) return new LocalConfig();

        try
        {
            var json = File.ReadAllText(configPath);
            return JsonSerializer.Deserialize<LocalConfig>(
                json,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? new LocalConfig();
        }
        catch (Exception ex)
        {
            throw new InvalidDataException($"Control Center local configを読み込めません: {configPath}", ex);
        }
    }

    private static string? FirstNonBlank(params string?[] values)
    {
        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value)) return value;
        }
        return null;
    }

    private static string? ResolveOptionalPath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        return Path.GetFullPath(Environment.ExpandEnvironmentVariables(value));
    }

    private static string LocateAgentToolsRoot()
    {
        var environmentRoot = Environment.GetEnvironmentVariable("AGENTTOOLS_ROOT");
        if (IsAgentToolsRoot(environmentRoot)) return Path.GetFullPath(environmentRoot!);

        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (IsAgentToolsRoot(current.FullName)) return current.FullName;
            current = current.Parent;
        }

        throw new DirectoryNotFoundException("AgentTools rootを特定できません。AgentTools配下から起動するか、AGENTTOOLS_ROOT環境変数を設定してください。");
    }

    private static bool IsAgentToolsRoot(string? path)
    {
        return !string.IsNullOrWhiteSpace(path) &&
               File.Exists(Path.Combine(path, "agenttools-mcp-gateway", "src", "cli.js"));
    }
}
