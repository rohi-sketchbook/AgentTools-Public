using System.Collections.ObjectModel;
using System.Windows;
using AgentToolsControlCenter.Models;
using AgentToolsControlCenter.Services;
using ColorConverter = System.Windows.Media.ColorConverter;
using MessageBox = System.Windows.MessageBox;

namespace AgentToolsControlCenter;

public partial class SkillImprovementsWindow : Window
{
    private readonly SkillImprovementService _service;
    private readonly ObservableCollection<SkillImprovementProposal> _proposals = [];
    private bool _refreshing;

    public SkillImprovementsWindow(SkillImprovementService service)
    {
        InitializeComponent();
        _service = service;
        ProposalList.ItemsSource = _proposals;
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        await RefreshAsync();
    }

    private async Task RefreshAsync(string? preferredId = null)
    {
        if (_refreshing) return;
        _refreshing = true;
        try
        {
            preferredId ??= (ProposalList.SelectedItem as SkillImprovementProposal)?.Id;
            FooterText.Text = "Skill改善候補を読み込んでいます…";
            var proposals = await _service.CollectAsync();
            _proposals.Clear();
            foreach (var proposal in proposals) _proposals.Add(proposal);

            var activeCount = _proposals.Count(item => item.Status is "pending" or "approved" or "stale");
            CountText.Text = _proposals.Count == 0
                ? "候補なし"
                : $"要確認 {activeCount} / 表示 {_proposals.Count}件";
            FooterText.Text = $"最終更新: {DateTime.Now:yyyy-MM-dd HH:mm:ss}";

            var selected = preferredId is null
                ? _proposals.FirstOrDefault()
                : _proposals.FirstOrDefault(item => item.Id == preferredId) ?? _proposals.FirstOrDefault();
            ProposalList.SelectedItem = selected;
            UpdateDetail(selected);
        }
        catch (Exception ex)
        {
            FooterText.Text = $"取得失敗: {ex.Message}";
        }
        finally
        {
            _refreshing = false;
        }
    }

    private void UpdateDetail(SkillImprovementProposal? proposal)
    {
        if (proposal is null)
        {
            DetailTitle.Text = "候補を選択してください";
            DetailStatus.Text = string.Empty;
            DetailText.Text = "改善候補が作成されると、ここで理由とdiffを確認できます。";
            DiffText.Text = string.Empty;
            ApproveButton.IsEnabled = false;
            RejectButton.IsEnabled = false;
            ApplyButton.IsEnabled = false;
            return;
        }

        DetailTitle.Text = proposal.SkillName;
        DetailStatus.Text = proposal.StatusText;
        DetailStatus.Foreground = BrushFromHex(proposal.StatusColor);
        DetailText.Text = proposal.Details;
        DiffText.Text = string.IsNullOrWhiteSpace(proposal.Diff) ? "差分はありません。" : proposal.Diff;
        ApproveButton.IsEnabled = proposal.CanApprove;
        RejectButton.IsEnabled = proposal.CanReject;
        ApplyButton.IsEnabled = proposal.CanApply;
    }

    private async void RefreshButton_Click(object sender, RoutedEventArgs e)
    {
        await RefreshAsync();
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e)
    {
        Close();
    }

    private void ProposalList_SelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
    {
        UpdateDetail(ProposalList.SelectedItem as SkillImprovementProposal);
    }

    private async void ApproveButton_Click(object sender, RoutedEventArgs e)
    {
        if (ProposalList.SelectedItem is not SkillImprovementProposal proposal || !proposal.CanApprove) return;
        var confirm = MessageBox.Show(
            $"{proposal.SkillName} の改善候補を承認します。\n\n承認だけではファイルを書き換えません。適用は別操作です。\n承認しますか？",
            "Skill改善候補の承認",
            MessageBoxButton.YesNo,
            MessageBoxImage.Question,
            MessageBoxResult.No);
        if (confirm != MessageBoxResult.Yes) return;

        SetActionButtons(false);
        try
        {
            var result = await _service.ApproveAsync(proposal.Id);
            if (!result.Succeeded)
            {
                MessageBox.Show(result.Error ?? "承認できませんでした。", "承認失敗", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            await RefreshAsync(proposal.Id);
        }
        finally
        {
            UpdateDetail(ProposalList.SelectedItem as SkillImprovementProposal);
        }
    }

    private async void RejectButton_Click(object sender, RoutedEventArgs e)
    {
        if (ProposalList.SelectedItem is not SkillImprovementProposal proposal || !proposal.CanReject) return;
        var confirm = MessageBox.Show(
            $"{proposal.SkillName} の改善候補を却下します。\n\n却下した候補は適用できなくなります。\n却下しますか？",
            "Skill改善候補の却下",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning,
            MessageBoxResult.No);
        if (confirm != MessageBoxResult.Yes) return;

        SetActionButtons(false);
        try
        {
            var result = await _service.RejectAsync(proposal.Id);
            if (!result.Succeeded)
            {
                MessageBox.Show(result.Error ?? "却下できませんでした。", "却下失敗", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            await RefreshAsync(proposal.Id);
        }
        finally
        {
            UpdateDetail(ProposalList.SelectedItem as SkillImprovementProposal);
        }
    }

    private async void ApplyButton_Click(object sender, RoutedEventArgs e)
    {
        if (ProposalList.SelectedItem is not SkillImprovementProposal proposal || !proposal.CanApply) return;
        SetActionButtons(false);
        try
        {
            var prepared = await _service.PrepareApplyAsync(proposal.Id);
            if (!prepared.Succeeded || string.IsNullOrWhiteSpace(prepared.ConfirmToken))
            {
                MessageBox.Show(prepared.Error ?? "適用確認を開始できませんでした。", "適用準備失敗", MessageBoxButton.OK, MessageBoxImage.Warning);
                await RefreshAsync(proposal.Id);
                return;
            }

            var confirm = MessageBox.Show(
                $"承認済みの {proposal.SkillName} を実ファイルへ適用します。\n\n" +
                "適用直前にbase hashを再確認し、別変更が入っていれば自動的に中止します。\n" +
                "この変更を適用しますか？",
                "Skill改善を適用",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning,
                MessageBoxResult.No);
            if (confirm != MessageBoxResult.Yes) return;

            var applied = await _service.ApplyAsync(proposal.Id, prepared.ConfirmToken);
            if (!applied.Succeeded)
            {
                MessageBox.Show(applied.Error ?? "Skill改善を適用できませんでした。", "適用失敗", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            else
            {
                MessageBox.Show("Skill改善を適用しました。", "適用完了", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            await RefreshAsync(proposal.Id);
        }
        finally
        {
            UpdateDetail(ProposalList.SelectedItem as SkillImprovementProposal);
        }
    }

    private void SetActionButtons(bool enabled)
    {
        if (!enabled)
        {
            ApproveButton.IsEnabled = false;
            RejectButton.IsEnabled = false;
            ApplyButton.IsEnabled = false;
            return;
        }
        UpdateDetail(ProposalList.SelectedItem as SkillImprovementProposal);
    }

    private static System.Windows.Media.Brush BrushFromHex(string hex)
    {
        return new System.Windows.Media.SolidColorBrush(
            (System.Windows.Media.Color)ColorConverter.ConvertFromString(hex));
    }
}
