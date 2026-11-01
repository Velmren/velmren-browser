using System.Runtime.CompilerServices;

namespace Velmren.Setup;

internal sealed class FrameworkApplication : IDisposable
{
    private readonly string directory;
    private readonly string configuration;

    internal FrameworkApplication(string installRoot)
    {
        directory = PayloadSession.CreatePrivateDirectory(MaintenanceRelocation.CacheRootFor(installRoot));
        configuration = Path.Combine(directory, "application.config");
        File.WriteAllText(configuration, """
            <?xml version="1.0" encoding="utf-8"?>
            <configuration>
              <startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.7.2" /></startup>
              <System.Windows.Forms.ApplicationConfigurationSection>
                <add key="DpiAwareness" value="PerMonitorV2" />
              </System.Windows.Forms.ApplicationConfigurationSection>
              <runtime><AppContextSwitchOverrides value="Switch.System.IO.UseLegacyPathHandling=false;Switch.System.IO.BlockLongPaths=false" /></runtime>
            </configuration>
            """);
        // Set before JSON/configuration or WinForms initializes. Keep the installed artifact one EXE.
        AppDomain.CurrentDomain.SetData("APP_CONFIG_FILE", configuration);
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    internal static void InitializeUi()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
    }

    public void Dispose()
    {
        try
        {
            PayloadSession.EnsureNoLinks(configuration);
            File.Delete(configuration);
            Directory.Delete(directory);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
