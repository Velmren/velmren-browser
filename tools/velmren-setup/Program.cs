namespace Velmren.Setup;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        try
        {
            var options = SetupOptions.Parse(args);
            var payload = PayloadSession.ReadConfiguration();
            if (!options.Uninstall && options.RootSpecified && payload.Feed is null && payload.Package is null &&
                File.Exists(Path.Combine(options.Root, "Velmren.exe"))) options = options with { Uninstall = true };
            if (MaintenanceRelocation.RelocateIfNeeded(options)) return 0;
            Application.Run(new SetupForm(options, payload));
            return 0;
        }
        catch (Exception)
        {
            MessageBox.Show("Не удалось открыть установку Velmren. Скачайте установщик заново и повторите попытку.",
                "Velmren", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
