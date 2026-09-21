using System.Threading;
using System.Windows;

namespace AgentToolsControlCenter;

public partial class App : System.Windows.Application
{
    private const string MutexName = "Local\\AgentTools.ControlCenter";
    private Mutex? _singleInstanceMutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        _singleInstanceMutex = new Mutex(initiallyOwned: true, MutexName, out var createdNew);
        if (!createdNew)
        {
            System.Windows.MessageBox.Show(
                "AgentTools Control Centerはすでに起動しています。タスクトレイを確認してください。",
                "すでに起動中",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
            Shutdown();
            return;
        }

        base.OnStartup(e);
        var window = new MainWindow();
        MainWindow = window;
        window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try
        {
            _singleInstanceMutex?.ReleaseMutex();
        }
        catch (ApplicationException)
        {
            // The mutex was not owned; nothing to release.
        }
        finally
        {
            _singleInstanceMutex?.Dispose();
        }

        base.OnExit(e);
    }
}
