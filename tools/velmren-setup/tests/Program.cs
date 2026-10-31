using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Velmren.Setup;

internal static class Smoke
{
    private static readonly List<string> checks = [];

    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var output = Path.GetFullPath(args[0]);
        Directory.CreateDirectory(output);
        try
        {
            if (args.Length < 2 || args[1] != "--render-only") CheckAsync(output).GetAwaiter().GetResult();
            var foreground = GetForegroundWindow();
            Render(output, false, "install");
            Render(output, true, "uninstall");
            Check(GetForegroundWindow() == foreground, "offscreen renders preserve foreground window");
            File.WriteAllText(Path.Combine(output, "smoke-results.json"), JsonSerializer.Serialize(new { passed = checks.Count, checks }, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"PASS {checks.Count} checks");
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception);
            return 1;
        }
    }

    private static async Task CheckAsync(string output)
    {
        Check(SetupOptions.Parse([]).Root.EndsWith(Path.Combine("Programs", "Velmren")), "default destination");
        Check(SetupOptions.Parse(["--uninstall", "--root", output]).Uninstall, "uninstall command");
        Throws(() => SetupOptions.Parse(["--feed", "https://untrusted.example"]), "no runtime feed override");
        Throws(() => SetupOptions.Parse(["--uninstall"]), "removal requires explicit root");
        Throws(() => SetupOptions.Parse(["--maintenance-session", "anything"]), "private marker cannot enable maintenance");
        Throws(() => SetupOptions.ValidateRoot("relative"), "relative destination rejected");
        Throws(() => SetupOptions.ValidateRoot(Path.GetPathRoot(output)!), "drive root rejected");
        Check(EngineRunner.ParseEvent("not json") is null, "non-JSON output ignored");
        Check(EngineRunner.ParseEvent("{\"action\":\"extracting\",\"percent\":140}")?.Percent == 100, "progress clamped");
        Check(EngineRunner.ParseEvent("{\"action\":\"extracting\",\"percent\":\"bad\"}") is null, "malformed progress ignored");
        using var payload = await PayloadSession.ExtractAsync(CancellationToken.None, Path.Combine(output, "extracted"));
        var extractedPath = payload.DirectoryPath;
        Check(File.Exists(payload.EnginePath), "embedded engine extracted");
        Check(payload.BundleDirectory is not null && File.Exists(Path.Combine(payload.BundleDirectory, "manifest.json")), "embedded manifest extracted");
        Check(File.Exists(Path.Combine(payload.BundleDirectory!, "velmren-1.0.0.0.zip")), "only named ZIP extracted");
        Check(!File.Exists(Path.Combine(payload.BundleDirectory!, "private.pem")), "unlisted files absent");
        Check(typeof(PayloadSession).Assembly.GetManifestResourceNames().Count(n => n.StartsWith("Setup.Payload.")) == 4, "only four explicit payload resources embedded");
        var installRoot = Path.Combine(output, "relocation-install");
        Directory.CreateDirectory(installRoot);
        var source = Path.Combine(installRoot, "original.exe");
        File.Copy(payload.EnginePath, source, true);
        var relocationCache = Path.Combine(output, "relocation-cache");
        var clone = MaintenanceRelocation.PrepareClone(installRoot, source, relocationCache, Environment.ProcessId + 100000, DateTime.UtcNow.Ticks);
        Check(File.Exists(clone.Executable) && !MaintenanceRelocation.IsWithin(clone.Executable, installRoot), "maintenance clone outside installed tree");
        var maintenanceOptions = new SetupOptions(true, installRoot, true, Path.GetFileName(clone.Directory));
        Check(MaintenanceRelocation.ValidateSession(maintenanceOptions, clone.Executable, relocationCache).Root == installRoot, "guarded maintenance clone accepted");
        Rejects(() => MaintenanceRelocation.ValidateSession(maintenanceOptions with { Root = output }, clone.Executable, relocationCache), "maintenance root substitution rejected");
        Rejects(() => MaintenanceRelocation.ValidateSession(maintenanceOptions with { MaintenanceSession = "../escape" }, clone.Executable, relocationCache), "maintenance marker traversal rejected");
        Rejects(() => MaintenanceRelocation.ValidateSession(maintenanceOptions, source, relocationCache), "maintenance marker on unrelated executable rejected");
        var root = Path.Combine(output, "Папка с пробелами & $() ' literal");
        var events = new List<EngineEvent>();
        var progress = new SynchronousProgress(events.Add);
        var result = await EngineRunner.RunAsync(payload.EnginePath,
            ["install-bundle", "--root", root, "--bundle-directory", payload.BundleDirectory!], payload.CancelPath, progress, CancellationToken.None);
        Check(result.ExitCode == 0 && events.Select(e => e.Percent).SequenceEqual(new int?[] { 10, 55, 100 }), "real process JSON progress");
        var arguments = JsonSerializer.Deserialize<string[]>(await File.ReadAllTextAsync(Path.Combine(root, "arguments-install-bundle.json")))!;
        Check(arguments[2] == root && arguments[4] == payload.BundleDirectory, "argument boundaries with Unicode and shell characters");
        result = await EngineRunner.RunAsync(payload.EnginePath, ["register", "--root", root, "--desktop", "false"], payload.CancelPath, null, CancellationToken.None);
        Check(result.ExitCode == 0, "registration command");
        await File.WriteAllTextAsync(Path.Combine(root, "profile.txt"), "saved");
        result = await EngineRunner.RunAsync(payload.EnginePath, ["uninstall", "--root", root], payload.CancelPath, null, CancellationToken.None);
        Check(result.ExitCode == 0 && File.Exists(Path.Combine(root, "profile.txt")), "frontend supplies no data deletion option");
        result = await EngineRunner.RunAsync(payload.EnginePath, ["fail", "--root", root], payload.CancelPath, null, CancellationToken.None);
        Check(result.ExitCode == 1 && result.Error.Length == 8192, "stderr drained and bounded");
        var friendly = EngineRunner.FriendlyError(result.Error, false);
        Check(!friendly.Contains("https") && !friendly.Contains("signature"), "technical diagnostics hidden from UI");
        using (var cancellation = new CancellationTokenSource())
        {
            payload.ResetCancellation();
            var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var operation = EngineRunner.RunAsync(payload.EnginePath, ["wait", "--root", root], payload.CancelPath,
                new SynchronousProgress(_ => ready.TrySetResult()), cancellation.Token);
            await ready.Task.WaitAsync(TimeSpan.FromSeconds(10));
            cancellation.Cancel();
            await ExpectCancellation(operation);
            Check(File.Exists(Path.Combine(root, "cancelled.txt")), "graceful cancellation via owned signal");
        }
        payload.ResetCancellation();
        result = await EngineRunner.RunAsync(payload.EnginePath, ["install", "--root", root, "--feed", "https://updates.example/manifest.json"], payload.CancelPath, null, CancellationToken.None);
        Check(result.ExitCode == 0 && !File.Exists(payload.CancelPath), "retry after cancellation");
        using (var unrelated = Process.Start(new ProcessStartInfo(payload.EnginePath)
        {
            UseShellExecute = false, CreateNoWindow = true,
            ArgumentList = { "ignore-cancel", "--root", Path.Combine(output, "unrelated-fixture") }
        })!)
        {
            try
            {
                using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
                var stopwatch = Stopwatch.StartNew();
                await ExpectCancellation(EngineRunner.RunAsync(payload.EnginePath, ["ignore-cancel", "--root", root], payload.CancelPath, null, cancellation.Token));
                Check(stopwatch.Elapsed < TimeSpan.FromSeconds(15) && !unrelated.HasExited, "cancel fallback stops only owned worker");
            }
            finally { if (!unrelated.HasExited) { unrelated.Kill(); await unrelated.WaitForExitAsync(); } }
        }
        await payload.CleanupAsync();
        Check(!Directory.Exists(extractedPath), "owned extracted payload cleaned");
    }

    private static void Render(string output, bool uninstall, string name)
    {
        using var form = new PreviewForm(new SetupOptions(uninstall,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Velmren")), new SetupPayload(null, "fixture.zip"));
        form.StartPosition = FormStartPosition.Manual;
        form.Location = new Point(-30000, -30000);
        form.ShowInTaskbar = false;
        form.Show();
        form.PerformLayout();
        foreach (Control child in form.Controls) child.CreateControl();
        using var bitmap = new Bitmap(form.Width, form.Height);
        form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size));
        bitmap.Save(Path.Combine(output, name + "-native-render.png"));
        Check(form.AcceptButton is Button { Enabled: true }, name + " default keyboard action");
        Check(form.CancelButton is Button, name + " escape action");
        Check(form.AutoScaleMode == AutoScaleMode.Dpi, name + " DPI scaling");
        form.Close();
    }

    private static async Task ExpectCancellation(Task<EngineResult> operation)
    {
        try { await operation; throw new InvalidOperationException("Expected cancellation."); }
        catch (OperationCanceledException) { }
    }
    private static void Check(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException("FAIL " + name);
        checks.Add(name);
    }
    private static void Throws(Action action, string name)
    {
        try { action(); throw new InvalidOperationException("Expected argument rejection."); }
        catch (ArgumentException) { checks.Add(name); }
    }
    private static void Rejects(Action action, string name)
    {
        try { action(); throw new InvalidOperationException("Expected maintenance rejection."); }
        catch (InvalidDataException) { checks.Add(name); }
    }
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    private sealed class SynchronousProgress(Action<EngineEvent> report) : IProgress<EngineEvent>
    {
        public void Report(EngineEvent value) => report(value);
    }
    private sealed class PreviewForm(SetupOptions options, SetupPayload payload) : SetupForm(options, payload)
    {
        protected override bool ShowWithoutActivation => true;
        protected override CreateParams CreateParams
        {
            get { var parameters = base.CreateParams; parameters.ExStyle |= 0x08000000; return parameters; }
        }
    }
}
