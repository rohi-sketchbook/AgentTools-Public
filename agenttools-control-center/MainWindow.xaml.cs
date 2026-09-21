using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using AgentToolsControlCenter.Models;
using AgentToolsControlCenter.Services;
using Forms = System.Windows.Forms;
using Application = System.Windows.Application;
using Clipboard = System.Windows.Clipboard;
using ColorConverter = System.Windows.Media.ColorConverter;
using MessageBox = System.Windows.MessageBox;

namespace AgentToolsControlCenter;

public partial class MainWindow : Window
{
    private readonly StatusCollector _collector;
    private readonly ActivityCollector _activityCollector;
    private readonly PlanUsageCollector _planUsageCollector;
    private readonly SkillImprovementService _skillImprovementService;
    private readonly WorkflowSettingsService _workflowSettingsService;
    private readonly TaskControlService _taskControlService;
    private readonly ObservableCollection<ServiceStatus> _services = [];
    private readonly ObservableCollection<WorkActivity> _activities = [];
    private List<WorkActivity> _allActivities = [];
    private bool _showTaskHistory;
    private readonly DispatcherTimer _activityTimer;
    private readonly DispatcherTimer _planUsageTimer;
    private Forms.NotifyIcon? _notifyIcon;
    private CancellationTokenSource? _refreshCancellation;
    private bool _isRefreshing;
    private bool _isRefreshingActivities;
    private bool _isUpdatingContinuationMode;
    private DateTime _lastSkillImprovementRefreshAt = DateTime.MinValue;
    private string? _inspectedTaskId;
    private string? _inspectionDetailText;
    private bool _allowClose;

    public MainWindow()
    {
        InitializeComponent();
        _collector = new StatusCollector();
        _activityCollector = new ActivityCollector(_collector.AgentToolsRoot);
        _planUsageCollector = new PlanUsageCollector();
        _skillImprovementService = new SkillImprovementService(_collector.AgentToolsRoot);
        _workflowSettingsService = new WorkflowSettingsService(_collector.AgentToolsRoot);
        _taskControlService = new TaskControlService(_collector.AgentToolsRoot);
        _activityTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        _activityTimer.Tick += ActivityTimer_Tick;
        _planUsageTimer = new DispatcherTimer { Interval = TimeSpan.FromMinutes(1) };
        _planUsageTimer.Tick += PlanUsageTimer_Tick;
        ServicesList.ItemsSource = _services;
        ActivityList.ItemsSource = _activities;
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        InitializeTrayIcon();
        FooterStatus.Text = $"AgentTools: {_collector.AgentToolsRoot}";
        await RefreshStatusesAsync(showOverlay: true);
        await RefreshContinuationModeAsync();
        await RefreshPlanUsageAsync();
        await RefreshActivitiesAsync();
        await RefreshSkillImprovementCountAsync(force: true);
        _activityTimer.Start();
        _planUsageTimer.Start();
    }

    private void InitializeTrayIcon()
    {
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("開く", null, (_, _) => Dispatcher.Invoke(ShowFromTray));
        menu.Items.Add("再確認", null, (_, _) => Dispatcher.Invoke(async () => await RefreshStatusesAsync(showOverlay: false)));
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("終了", null, (_, _) => Dispatcher.Invoke(ExitApplication));

        _notifyIcon = new Forms.NotifyIcon
        {
            Text = "AgentTools Control Center",
            Icon = System.Drawing.SystemIcons.Application,
            Visible = true,
            ContextMenuStrip = menu
        };
        _notifyIcon.DoubleClick += (_, _) => Dispatcher.Invoke(ShowFromTray);
    }

    private async Task RefreshStatusesAsync(bool showOverlay)
    {
        if (_isRefreshing) return;
        _isRefreshing = true;
        RefreshButton.IsEnabled = false;
        if (showOverlay) BusyOverlay.Visibility = Visibility.Visible;

        _refreshCancellation?.Cancel();
        _refreshCancellation?.Dispose();
        _refreshCancellation = new CancellationTokenSource(TimeSpan.FromSeconds(40));

        var selectedId = (ServicesList.SelectedItem as ServiceStatus)?.Id;
        try
        {
            FooterStatus.Text = "各サービスの状態を確認中…";
            var statuses = await _collector.CollectAsync(_refreshCancellation.Token);

            _services.Clear();
            foreach (var status in statuses)
            {
                _services.Add(status);
            }

            UpdateOverallStatus();
            FooterStatus.Text = $"最終更新: {DateTime.Now:yyyy-MM-dd HH:mm:ss}  |  AgentTools: {_collector.AgentToolsRoot}";

            var selected = selectedId is null
                ? _services.FirstOrDefault()
                : _services.FirstOrDefault(service => service.Id == selectedId) ?? _services.FirstOrDefault();
            ServicesList.SelectedItem = selected;
            UpdateDetailPanel(selected);
        }
        catch (OperationCanceledException)
        {
            FooterStatus.Text = "状態確認がタイムアウトしました。";
            OverallText.Text = "一部の確認がタイムアウトしました";
            OverallIndicator.Fill = new SolidColorBrush((System.Windows.Media.Color)ColorConverter.ConvertFromString("#F2C56B"));
        }
        catch (Exception ex)
        {
            FooterStatus.Text = $"確認失敗: {ex.Message}";
            OverallText.Text = "状態確認に失敗しました";
            OverallIndicator.Fill = new SolidColorBrush((System.Windows.Media.Color)ColorConverter.ConvertFromString("#F06B73"));
        }
        finally
        {
            _isRefreshing = false;
            RefreshButton.IsEnabled = true;
            BusyOverlay.Visibility = Visibility.Collapsed;
        }
    }

    private async void ActivityTimer_Tick(object? sender, EventArgs e)
    {
        await RefreshActivitiesAsync();
        await RefreshSkillImprovementCountAsync(force: false);
    }

    private async void PlanUsageTimer_Tick(object? sender, EventArgs e)
    {
        await RefreshPlanUsageAsync();
    }

    private async Task RefreshPlanUsageAsync(bool force = false)
    {
        try
        {
            var usage = await _planUsageCollector.CollectAsync(force);
            var plan = string.IsNullOrWhiteSpace(usage.PlanType) ? "不明" : usage.PlanType.ToUpperInvariant();
            var windows = new List<string>();
            if (usage.Primary is not null) windows.Add(FormatUsageWindow(usage.Primary, "短期枠"));
            if (usage.Secondary is not null) windows.Add(FormatUsageWindow(usage.Secondary, "長期枠"));
            var creditText = usage.ResetCreditsAvailable is int credits ? $" / Full reset {credits}回" : string.Empty;
            var staleText = usage.Stale ? " / 前回値" : string.Empty;
            PlanUsageText.Text = windows.Count > 0
                ? $"Codex {plan}: {string.Join("  |  ", windows)}{creditText}{staleText}"
                : $"Codex利用枠: {usage.Error ?? "未取得"}";
            PlanUsageText.ToolTip = "ChatGPTプランに紐づくCodexの利用枠です。割合は現在の瞬間使用量ではなく、各5時間/週次枠内での累積です。\n取得は5分キャッシュで低負荷に更新します。";
        }
        catch (Exception ex)
        {
            PlanUsageText.Text = $"Codex利用枠: 取得失敗 ({ex.Message})";
        }
    }

    private static string FormatUsageWindow(PlanUsageWindow window, string fallbackLabel)
    {
        var label = window.WindowDurationMinutes switch
        {
            int minutes when minutes > 0 && minutes % 1440 == 0 => $"{minutes / 1440}日枠",
            int minutes when minutes > 0 && minutes % 60 == 0 => $"{minutes / 60}時間枠",
            int minutes when minutes > 0 => $"{minutes}分枠",
            _ => fallbackLabel
        };
        var reset = window.ResetsAt is DateTimeOffset at
            ? at.LocalDateTime.ToString("MM/dd HH:mm")
            : "—";
        return $"{label} 累積 {window.UsedPercent:0.#}%使用 / {window.RemainingPercent:0.#}%残り → {reset}";
    }

    private async Task RefreshActivitiesAsync()
    {
        if (_isRefreshingActivities) return;
        _isRefreshingActivities = true;
        try
        {
            var selectedId = (ActivityList.SelectedItem as WorkActivity)?.Id;
            _allActivities = [.. await _activityCollector.CollectAsync()];
            ApplyActivityFilter(selectedId);
        }
        catch (Exception ex)
        {
            ActivityCountText.Text = "取得失敗";
            ActivityEmptyText.Text = $"作業状況を取得できません: {ex.Message}";
            ActivityEmptyText.Visibility = Visibility.Visible;
            ActivityList.Visibility = Visibility.Collapsed;
            ResetActivityDetailPanel();
        }
        finally
        {
            _isRefreshingActivities = false;
        }
    }

    private void ApplyActivityFilter(string? selectedId = null)
    {
        var activeActivities = _allActivities
            .Where(activity => activity.Status is "running" or "blocked")
            .ToList();
        var displayedActivities = _showTaskHistory ? _allActivities : activeActivities;
        var historyCount = Math.Max(0, _allActivities.Count - activeActivities.Count);

        _activities.Clear();
        foreach (var activity in displayedActivities)
        {
            _activities.Add(activity);
        }

        ActivityCountText.Text = _allActivities.Count == 0
            ? "タスクなし"
            : _showTaskHistory
                ? $"アクティブ {activeActivities.Count} / 全 {_allActivities.Count}件"
                : $"アクティブ {activeActivities.Count}件";
        TaskHistoryToggleButton.Content = _showTaskHistory
            ? "アクティブのみ"
            : historyCount > 0 ? $"履歴を表示 ({historyCount})" : "履歴なし";
        TaskHistoryToggleButton.IsEnabled = _showTaskHistory || historyCount > 0;
        ActivityEmptyText.Text = _showTaskHistory
            ? "表示できるユーザータスクはありません。"
            : "アクティブなタスクはありません。";
        ActivityEmptyText.Visibility = _activities.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        ActivityList.Visibility = _activities.Count == 0 ? Visibility.Collapsed : Visibility.Visible;

        if (selectedId is not null)
        {
            var selected = _activities.FirstOrDefault(activity => activity.Id == selectedId);
            ActivityList.SelectedItem = selected;
            if (selected is null)
            {
                ResetActivityDetailPanel();
            }
        }
        else if (_activities.Count == 0)
        {
            ResetActivityDetailPanel();
        }
    }

    private void TaskHistoryToggleButton_Click(object sender, RoutedEventArgs e)
    {
        var selectedId = (ActivityList.SelectedItem as WorkActivity)?.Id;
        _showTaskHistory = !_showTaskHistory;
        ApplyActivityFilter(selectedId);
    }

    private void UpdateOverallStatus()
    {
        var warningCount = _services.Count(service => service.Health is ServiceHealth.Warning or ServiceHealth.Unknown);
        var stoppedCount = _services.Count(service => service.Health == ServiceHealth.Stopped);
        var busyCount = _services.Count(service => service.Health == ServiceHealth.Busy);

        string color;
        if (warningCount == 0 && stoppedCount == 0)
        {
            OverallText.Text = busyCount > 0 ? $"正常稼働中（{busyCount}件処理中）" : "すべて正常です";
            color = "#65D4B6";
        }
        else if (warningCount > 0)
        {
            OverallText.Text = $"要確認 {warningCount}件 / 停止 {stoppedCount}件";
            color = "#F2C56B";
        }
        else
        {
            OverallText.Text = $"停止中のサービスが{stoppedCount}件あります";
            color = "#F06B73";
        }

        OverallIndicator.Fill = new SolidColorBrush((System.Windows.Media.Color)ColorConverter.ConvertFromString(color));
        UpdateTrayText(warningCount, stoppedCount, busyCount);
    }

    private void UpdateTrayText(int warningCount, int stoppedCount, int busyCount)
    {
        if (_notifyIcon is null) return;
        var text = warningCount == 0 && stoppedCount == 0
            ? busyCount > 0 ? $"AgentTools: 正常 / {busyCount}件処理中" : "AgentTools: すべて正常"
            : $"AgentTools: 要確認 {warningCount} / 停止 {stoppedCount}";
        _notifyIcon.Text = text.Length <= 63 ? text : text[..63];
    }

    private void UpdateDetailPanel(ServiceStatus? service)
    {
        if (service is null)
        {
            DetailGlyph.Text = "?";
            DetailGlyph.Foreground = BrushFromHex("#8A96A3");
            DetailTitle.Text = "サービスを選択してください";
            DetailStatus.Text = string.Empty;
            DetailText.Text = "一覧から確認対象を選択すると、疎通・PID・最終実行などの詳細を表示します。";
            OpenLogsButton.IsEnabled = false;
            DevSpaceStartButton.IsEnabled = false;
            DevSpaceStopButton.IsEnabled = false;
            DevSpaceDoctorButton.IsEnabled = false;
            RestartButton.IsEnabled = false;
            return;
        }

        DetailGlyph.Text = service.StatusGlyph;
        DetailGlyph.Foreground = BrushFromHex(service.StatusColor);
        DetailTitle.Text = service.DisplayName;
        DetailStatus.Text = service.StatusText;
        DetailStatus.Foreground = BrushFromHex(service.StatusColor);
        DetailText.Text = service.Details;
        OpenLogsButton.IsEnabled = !string.IsNullOrWhiteSpace(service.LogPath) && Directory.Exists(service.LogPath);
        var isDevSpace = service.Id == "devspace";
        DevSpaceStartButton.IsEnabled = isDevSpace && service.Health == ServiceHealth.Stopped;
        DevSpaceStopButton.IsEnabled = isDevSpace && service.Health != ServiceHealth.Stopped;
        DevSpaceDoctorButton.IsEnabled = isDevSpace;
        RestartButton.IsEnabled = service.CanRecover;
    }

    private void UpdateActivityDetailPanel(WorkActivity activity)
    {
        TaskDetailGlyph.Text = "●";
        TaskDetailGlyph.Foreground = BrushFromHex(activity.StatusColor);
        TaskDetailTitle.Text = activity.Title;
        TaskDetailStatus.Text = string.IsNullOrWhiteSpace(activity.Phase)
            ? activity.StatusText
            : $"{activity.StatusText} / {activity.Phase}";
        TaskDetailStatus.Foreground = BrushFromHex(activity.StatusColor);
        TaskDetailText.Text = activity.Id == _inspectedTaskId && !string.IsNullOrWhiteSpace(_inspectionDetailText)
            ? $"{activity.Details}{Environment.NewLine}{Environment.NewLine}--- 状況確認 ---{Environment.NewLine}{_inspectionDetailText}"
            : activity.Details;
        SetTaskActionButtons(activity);
    }

    private void ResetActivityDetailPanel()
    {
        TaskDetailGlyph.Text = "?";
        TaskDetailGlyph.Foreground = BrushFromHex("#8A96A3");
        TaskDetailTitle.Text = "タスクを選択してください";
        TaskDetailStatus.Text = string.Empty;
        TaskDetailText.Text = "一覧からタスクを選択すると、依頼内容・担当・進捗・作業ログを表示します。";
        SetTaskActionButtons(null);
        _inspectedTaskId = null;
        _inspectionDetailText = null;
    }

    private void SetTaskActionButtons(WorkActivity? activity)
    {
        var visibility = activity is null ? Visibility.Collapsed : Visibility.Visible;
        TaskInspectButton.Visibility = visibility;
        TaskContinueButton.Visibility = visibility;
        TaskCodexContinueButton.Visibility = visibility;
        TaskCompleteButton.Visibility = visibility;
        TaskInspectButton.IsEnabled = activity is not null;
        TaskContinueButton.IsEnabled = activity is not null && activity.Status == "blocked";
        TaskCodexContinueButton.IsEnabled = activity is not null && activity.Status == "blocked";
        TaskCompleteButton.IsEnabled = activity is not null && activity.Status is "running" or "blocked";
    }

    private static System.Windows.Media.Brush BrushFromHex(string hex)
    {
        return new SolidColorBrush((System.Windows.Media.Color)ColorConverter.ConvertFromString(hex));
    }

    private async void RefreshButton_Click(object sender, RoutedEventArgs e)
    {
        await RefreshStatusesAsync(showOverlay: false);
        await RefreshContinuationModeAsync();
        await RefreshPlanUsageAsync(force: true);
        await RefreshActivitiesAsync();
        await RefreshSkillImprovementCountAsync(force: true);
    }

    private async Task RefreshContinuationModeAsync()
    {
        if (_isUpdatingContinuationMode) return;
        _isUpdatingContinuationMode = true;
        ContinuationModeComboBox.IsEnabled = false;
        try
        {
            var info = await _workflowSettingsService.GetContinuationModeAsync();
            foreach (var item in ContinuationModeComboBox.Items.OfType<ComboBoxItem>())
            {
                if (string.Equals(item.Tag as string, info.Mode, StringComparison.OrdinalIgnoreCase))
                {
                    ContinuationModeComboBox.SelectedItem = item;
                    break;
                }
            }
            ContinuationModeComboBox.ToolTip = string.IsNullOrWhiteSpace(info.Model)
                ? info.Description
                : $"{info.Description}\nModel: {info.Model}{(string.IsNullOrWhiteSpace(info.Thinking) ? string.Empty : $" / thinking={info.Thinking}")}";
        }
        catch (Exception ex)
        {
            ContinuationModeComboBox.ToolTip = $"自動継続設定を取得できません: {ex.Message}";
        }
        finally
        {
            ContinuationModeComboBox.IsEnabled = true;
            _isUpdatingContinuationMode = false;
        }
    }

    private async void ContinuationModeComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_isUpdatingContinuationMode || ContinuationModeComboBox.SelectedItem is not ComboBoxItem selected) return;
        var mode = selected.Tag as string;
        if (string.IsNullOrWhiteSpace(mode)) return;

        _isUpdatingContinuationMode = true;
        ContinuationModeComboBox.IsEnabled = false;
        try
        {
            var info = await _workflowSettingsService.SetContinuationModeAsync(mode);
            var modelText = string.IsNullOrWhiteSpace(info.Model)
                ? string.Empty
                : $" | Model: {info.Model}{(string.IsNullOrWhiteSpace(info.Thinking) ? string.Empty : $" / thinking={info.Thinking}")}";
            ContinuationModeComboBox.ToolTip = $"{info.Description}{modelText}";
            FooterStatus.Text = $"自動継続: {selected.Content}  |  {info.Description}{modelText}";
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"自動継続設定を変更できませんでした。\n\n{ex.Message}", "AgentTools Control Center", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            ContinuationModeComboBox.IsEnabled = true;
            _isUpdatingContinuationMode = false;
        }
    }

    private async Task RefreshSkillImprovementCountAsync(bool force)
    {
        if (!force && DateTime.Now - _lastSkillImprovementRefreshAt < TimeSpan.FromSeconds(15)) return;
        _lastSkillImprovementRefreshAt = DateTime.Now;
        try
        {
            var proposals = await _skillImprovementService.CollectAsync();
            var pending = proposals.Count(item => item.Status is "pending" or "approved" or "stale");
            SkillImprovementButton.Content = pending == 0 ? "Skill改善候補" : $"Skill改善候補 ({pending})";
        }
        catch
        {
            SkillImprovementButton.Content = "Skill改善候補 (?)";
        }
    }

    private async void SkillImprovementButton_Click(object sender, RoutedEventArgs e)
    {
        var window = new SkillImprovementsWindow(_skillImprovementService) { Owner = this };
        window.ShowDialog();
        await RefreshSkillImprovementCountAsync(force: true);
    }

    private void ServicesList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ServicesList.SelectedItem is not ServiceStatus service) return;
        UpdateDetailPanel(service);
    }

    private void ActivityList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ActivityList.SelectedItem is not WorkActivity activity) return;
        if (!string.Equals(_inspectedTaskId, activity.Id, StringComparison.Ordinal))
        {
            _inspectedTaskId = null;
            _inspectionDetailText = null;
        }
        UpdateActivityDetailPanel(activity);
    }

    private void ActivityList_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
    {
        ScrollByMouseWheel(TaskScrollViewer, e);
    }

    private void ServicesList_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
    {
        ScrollByMouseWheel(ServicesScrollViewer, e);
    }

    private static void ScrollByMouseWheel(ScrollViewer scrollViewer, MouseWheelEventArgs e)
    {
        if (scrollViewer.ScrollableHeight <= 0) return;
        var targetOffset = Math.Clamp(scrollViewer.VerticalOffset - e.Delta, 0, scrollViewer.ScrollableHeight);
        scrollViewer.ScrollToVerticalOffset(targetOffset);
        e.Handled = true;
    }

    private async void TaskInspectButton_Click(object sender, RoutedEventArgs e)
    {
        if (ActivityList.SelectedItem is not WorkActivity activity) return;
        SetTaskActionButtons(null);
        FooterStatus.Text = $"{activity.Title} の状況を確認中…";
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var inspection = await _taskControlService.InspectAsync(activity.Id, cts.Token);
            _inspectedTaskId = activity.Id;
            _inspectionDetailText = inspection.ToDisplayText();
            UpdateActivityDetailPanel(activity);
            FooterStatus.Text = $"状況確認完了: {activity.Title}";
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"状況確認に失敗しました。\n\n{ex.Message}", "Task 状況確認", MessageBoxButton.OK, MessageBoxImage.Warning);
            FooterStatus.Text = $"状況確認失敗: {activity.Title}";
        }
        finally
        {
            SetTaskActionButtons(activity);
        }
    }

    private async void TaskContinueButton_Click(object sender, RoutedEventArgs e)
    {
        if (ActivityList.SelectedItem is not WorkActivity activity) return;
        SetTaskActionButtons(null);
        FooterStatus.Text = $"{activity.Title} の再開プロンプトを生成中…";
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var result = await _taskControlService.GetResumePromptAsync(activity.Id, cts.Token);
            if (!result.Succeeded || string.IsNullOrWhiteSpace(result.Prompt))
                throw new InvalidOperationException(result.Message);
            Clipboard.SetText(result.Prompt);
            MessageBox.Show(this,
                "ChatGPT再開用プロンプトをクリップボードへコピーしました。\n\nAIは起動していません。ChatGPTへ貼り付けて再開してください。",
                "続行プロンプト",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
            FooterStatus.Text = $"再開プロンプトをコピー: {activity.Title}";
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"再開プロンプトをコピーできませんでした。\n\n{ex.Message}", "続行プロンプト", MessageBoxButton.OK, MessageBoxImage.Warning);
            FooterStatus.Text = $"再開プロンプト生成失敗: {activity.Title}";
        }
        finally
        {
            if (ActivityList.SelectedItem is WorkActivity selected) SetTaskActionButtons(selected);
        }
    }

    private async void TaskCodexContinueButton_Click(object sender, RoutedEventArgs e)
    {
        if (ActivityList.SelectedItem is not WorkActivity activity) return;
        var answer = MessageBox.Show(
            this,
            $"「{activity.Title}」をCodexで続行しますか？\n\nGPT-5.6系のCodex使用枠を消費します。通常は「再開文をコピー」を使ってChatGPT (Sol) で再開してください。",
            "Codexで続行",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning,
            MessageBoxResult.No);
        if (answer != MessageBoxResult.Yes) return;

        SetTaskActionButtons(null);
        FooterStatus.Text = $"{activity.Title} をCodexで再開中…";
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(35));
            var result = await _taskControlService.ContinueWithCodexAsync(activity.Id, cts.Token);
            MessageBox.Show(this, result.Message, "Codexで続行", MessageBoxButton.OK,
                result.Succeeded ? MessageBoxImage.Information : MessageBoxImage.Warning);
            await RefreshActivitiesAsync();
            FooterStatus.Text = result.Succeeded ? $"Codex続行: {activity.Title}" : $"Codex続行失敗: {activity.Title}";
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Codexでの続行に失敗しました。\n\n{ex.Message}", "Codexで続行", MessageBoxButton.OK, MessageBoxImage.Warning);
            FooterStatus.Text = $"Codex続行失敗: {activity.Title}";
        }
        finally
        {
            if (ActivityList.SelectedItem is WorkActivity selected) SetTaskActionButtons(selected);
        }
    }

    private async void TaskCompleteButton_Click(object sender, RoutedEventArgs e)
    {
        if (ActivityList.SelectedItem is not WorkActivity activity) return;
        var answer = MessageBox.Show(
            this,
            $"「{activity.Title}」を閉じ忘れタスクとして完了にしますか？\n\nTaskが更新されていた場合は安全のため完了を拒否します。",
            "Task 終了",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning,
            MessageBoxResult.No);
        if (answer != MessageBoxResult.Yes) return;

        SetTaskActionButtons(null);
        FooterStatus.Text = $"{activity.Title} を完了にしています…";
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var result = await _taskControlService.CompleteForgottenAsync(activity.Id, activity.UpdatedAt, cts.Token);
            if (!result.Succeeded) throw new InvalidOperationException(result.Message);
            await RefreshActivitiesAsync();
            FooterStatus.Text = $"タスク完了: {activity.Title}";
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"タスクを完了にできませんでした。\n\n{ex.Message}", "Task 終了", MessageBoxButton.OK, MessageBoxImage.Warning);
            FooterStatus.Text = $"タスク終了失敗: {activity.Title}";
            if (ActivityList.SelectedItem is WorkActivity selected) SetTaskActionButtons(selected);
        }
    }

    private void OpenRootButton_Click(object sender, RoutedEventArgs e)
    {
        OpenPath(_collector.AgentToolsRoot);
    }

    private void OpenLogsButton_Click(object sender, RoutedEventArgs e)
    {
        if (ServicesList.SelectedItem is ServiceStatus { LogPath: not null } service)
        {
            OpenPath(service.LogPath);
        }
    }

    private async void DevSpaceStartButton_Click(object sender, RoutedEventArgs e)
    {
        await RunDevSpaceActionAsync(
            "起動",
            token => _collector.StartDevSpaceAsync(token),
            MessageBoxImage.Question);
    }

    private async void DevSpaceStopButton_Click(object sender, RoutedEventArgs e)
    {
        await RunDevSpaceActionAsync(
            "停止",
            token => _collector.StopDevSpaceAsync(token),
            MessageBoxImage.Warning);
    }

    private async void DevSpaceDoctorButton_Click(object sender, RoutedEventArgs e)
    {
        if (ServicesList.SelectedItem is not ServiceStatus { Id: "devspace" } service) return;

        SetDevSpaceActionButtonsEnabled(false);
        FooterStatus.Text = "DevSpaceを診断しています…";
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            var result = await _collector.DiagnoseDevSpaceAsync(cts.Token);
            var message = !string.IsNullOrWhiteSpace(result.StandardOutput)
                ? result.StandardOutput
                : result.StandardError;
            MessageBox.Show(
                string.IsNullOrWhiteSpace(message) ? "診断は完了しました。" : message,
                result.Succeeded ? "DevSpace診断" : "DevSpace診断エラー",
                MessageBoxButton.OK,
                result.Succeeded ? MessageBoxImage.Information : MessageBoxImage.Warning);
            await RefreshStatusesAsync(showOverlay: false);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "DevSpace診断エラー", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            UpdateDetailPanel(ServicesList.SelectedItem as ServiceStatus);
        }
    }

    private async Task RunDevSpaceActionAsync(
        string actionLabel,
        Func<CancellationToken, Task<ProcessResult>> action,
        MessageBoxImage confirmationIcon)
    {
        if (ServicesList.SelectedItem is not ServiceStatus { Id: "devspace" } service) return;

        var confirm = MessageBox.Show(
            $"DevSpaceを{actionLabel}します。\n\nGateway supervisorの安全な既定手順だけを使用し、強制終了は行いません。\n実行しますか？",
            $"DevSpace {actionLabel}の確認",
            MessageBoxButton.YesNo,
            confirmationIcon,
            MessageBoxResult.No);
        if (confirm != MessageBoxResult.Yes) return;

        SetDevSpaceActionButtonsEnabled(false);
        FooterStatus.Text = $"DevSpaceを{actionLabel}しています…";
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(100));
            var result = await action(cts.Token);
            if (!result.Succeeded)
            {
                var message = result.TimedOut
                    ? $"DevSpaceの{actionLabel}処理がタイムアウトしました。"
                    : string.IsNullOrWhiteSpace(result.StandardError)
                        ? result.StandardOutput
                        : result.StandardError;
                MessageBox.Show(message, $"DevSpaceを{actionLabel}できませんでした", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            else
            {
                FooterStatus.Text = $"DevSpaceの{actionLabel}を完了しました。状態を再確認します。";
            }

            await Task.Delay(800);
            await RefreshStatusesAsync(showOverlay: false);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, $"DevSpace {actionLabel}エラー", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            UpdateDetailPanel(ServicesList.SelectedItem as ServiceStatus);
        }
    }

    private void SetDevSpaceActionButtonsEnabled(bool enabled)
    {
        if (!enabled)
        {
            DevSpaceStartButton.IsEnabled = false;
            DevSpaceStopButton.IsEnabled = false;
            DevSpaceDoctorButton.IsEnabled = false;
            RestartButton.IsEnabled = false;
            return;
        }

        UpdateDetailPanel(ServicesList.SelectedItem as ServiceStatus);
    }

    private async void RestartButton_Click(object sender, RoutedEventArgs e)
    {
        if (ServicesList.SelectedItem is not ServiceStatus service || !service.CanRecover) return;

        var result = MessageBox.Show(
            $"{service.DisplayName} を安全な既定手順で再起動します。\n\n実行しますか？",
            "再起動の確認",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning,
            MessageBoxResult.No);
        if (result != MessageBoxResult.Yes) return;

        RestartButton.IsEnabled = false;
        FooterStatus.Text = $"{service.DisplayName} の再起動を要求しています…";
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(100));
            var restartResult = await _collector.RestartAsync(service.Id, cts.Token);
            if (!restartResult.Succeeded)
            {
                var message = restartResult.TimedOut
                    ? "再起動処理がタイムアウトしました。"
                    : string.IsNullOrWhiteSpace(restartResult.StandardError)
                        ? restartResult.StandardOutput
                        : restartResult.StandardError;
                MessageBox.Show(message, "再起動できませんでした", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            else
            {
                FooterStatus.Text = $"{service.DisplayName} の再起動要求を完了しました。状態を再確認します。";
            }

            await Task.Delay(1200);
            await RefreshStatusesAsync(showOverlay: false);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "再起動エラー", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            RestartButton.IsEnabled = service.CanRecover;
        }
    }

    private void CopyDiagnosticsButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var payload = new
            {
                generatedAt = DateTimeOffset.Now,
                agentToolsRoot = _collector.AgentToolsRoot,
                services = _services.Select(service => new
                {
                    service.Id,
                    service.DisplayName,
                    health = service.Health.ToString(),
                    service.StatusText,
                    service.Summary,
                    service.Details,
                    service.CheckedAt
                })
            };
            Clipboard.SetText(JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }));
            FooterStatus.Text = "診断情報をクリップボードへコピーしました。";
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "コピー失敗", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private static void OpenPath(string path)
    {
        try
        {
            if (!Directory.Exists(path) && !File.Exists(path))
            {
                MessageBox.Show($"パスが見つかりません。\n{path}", "パスなし", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                UseShellExecute = true,
                ArgumentList = { path }
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "フォルダを開けませんでした", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void Window_StateChanged(object? sender, EventArgs e)
    {
        if (WindowState == WindowState.Minimized)
        {
            Hide();
        }
    }

    private void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (_allowClose) return;
        e.Cancel = true;
        Hide();
    }

    private void ShowFromTray()
    {
        Show();
        WindowState = WindowState.Normal;
        Activate();
        Topmost = true;
        Topmost = false;
        Focus();
    }

    private void ExitApplication()
    {
        _allowClose = true;
        _activityTimer.Stop();
        _planUsageTimer.Stop();
        _refreshCancellation?.Cancel();
        if (_notifyIcon is not null)
        {
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            _notifyIcon = null;
        }
        Application.Current.Shutdown();
    }
}
