using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Reflection;
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
            Render(output, false, "online", online: true);
            Render(output, false, "options", "options", online: true);
            Render(output, false, "download", "download", online: true);
            Render(output, false, "retry", "retry", online: true);
            Render(output, false, "complete", "complete", online: true);
            Render(output, false, "options-scaled", "options", online: true, scale: 1.5F);
            Render(output, true, "uninstall");
            Render(output, true, "uninstalled", "complete");
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

    private static void Render(string output, bool uninstall, string name, string state = "initial", bool online = false, float scale = 1F)
    {
        using var form = new PreviewForm(new SetupOptions(uninstall,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Velmren")),
            online ? new SetupPayload("https://updates.example/fixture/", null) : new SetupPayload(null, "fixture.zip"));
        form.StartPosition = FormStartPosition.Manual;
        form.Location = new Point(-30000, -30000);
        form.ShowInTaskbar = false;
        form.Show();
        var primary = Field<Button>(form, "primary");
        var destination = Field<TextBox>(form, "destination");
        var options = Field<TableLayoutPanel>(form, "optionsPanel");
        var cancel = Field<Button>(form, "cancel");
        var closeWindow = form.closeWindow;
        Check(form.FormBorderStyle == FormBorderStyle.None, name + " classic frame is absent");
        Check(closeWindow.Visible && closeWindow.CanSelect && closeWindow.AccessibilityObject.Role == AccessibleRole.PushButton && !string.IsNullOrWhiteSpace(closeWindow.AccessibilityObject.Name), name + " close is an accessible native button");
        Check(WindowHit(form, new Point(100, 24)) == 2, name + " caption supports native dragging at negative screen coordinates");
        Check(WindowHit(form, new Point(1, 100)) == 10 && WindowHit(form, new Point(form.ClientSize.Width - 2, form.ClientSize.Height - 2)) == 17, name + " custom frame retains native resize hit testing");
        Check(WindowHit(form, new Point(closeWindow.Left + closeWindow.Width / 2, closeWindow.Top + closeWindow.Height / 2)) == 1, name + " close target is excluded from dragging");
        Check(!options.Visible && !destination.CanSelect, name + " optional settings start collapsed");
        Check(Field<PictureBox>(form, "brand").Image is not null && form.Icon is not null, name + " embedded Velmren identity");
        if (online) Check(primary.Text.Contains("Скачать и установить"), name + " online action is explicit");
        if (!uninstall && state == "initial")
        {
            Check(form.SelectNextControl(primary, true, true, true, true) && ReferenceEquals(form.ActiveControl, cancel), name + " Tab reaches secondary action");
            Check(form.SelectNextControl(cancel, true, true, true, true) && ReferenceEquals(form.ActiveControl, closeWindow), name + " Tab reaches caption close");
            Check(form.SelectNextControl(closeWindow, true, true, true, true) && ReferenceEquals(form.ActiveControl, Field<LinkLabel>(form, "changeOptions")), name + " Tab reaches settings disclosure");
        }
        if (state == "options")
        {
            Invoke(form, "SetOptionsExpanded", true);
            Check(form.Width == 600 && form.Height == 460, name + " settings expansion does not add invisible frame dimensions");
            Check(options.Visible && destination.CanSelect && Field<Button>(form, "browse").CanSelect, name + " folder can be edited with keyboard");
            Check(form.SelectNextControl(destination, true, true, true, true) && ReferenceEquals(form.ActiveControl, Field<Button>(form, "browse")), name + " Tab follows folder with picker");
            Check(form.SelectNextControl(form.ActiveControl, true, true, true, true) && ReferenceEquals(form.ActiveControl, Field<CheckBox>(form, "desktop")), name + " Tab follows picker with shortcut option");
            var customRoot = "D:\\Мои браузеры\\Velmren";
            destination.Text = customRoot;
            Invoke(form, "SetOptionsExpanded", false);
            Check(Field<Label>(form, "locationSummary").Text == customRoot, name + " selected folder stays visible after collapse");
            Invoke(form, "SetOptionsExpanded", true);
            Check(destination.Text == customRoot, name + " disclosure preserves chosen folder");
            destination.SelectionStart = destination.Text.Length;
            destination.SelectionLength = 0;
            primary.Focus();
        }
        if (state is "download" or "retry")
        {
            Invoke(form, "ShowWorking");
            Check(!primary.Visible && !destination.Enabled && cancel.Enabled, name + " only cancellation available while working");
            using var cancellation = new CancellationTokenSource();
            SetField(form, "running", true);
            SetField(form, "cancellation", cancellation);
            Invoke(form, "OnEngineEvent", new EngineEvent("downloading", 43));
            Check(Field<ProgressBar>(form, "progress").Value == 43 && Field<Label>(form, "status").Text.Contains("43 %"), name + " actual download percentage shown");
            Invoke(form, "OnEngineEvent", new EngineEvent("unknown", 99));
            Check(Field<ProgressBar>(form, "progress").Value == 43, name + " unknown event does not falsify progress");
            Invoke(form, "OnEngineEvent", new EngineEvent("verifying", null));
            Check(Field<Label>(form, "status").Text == "Проверка файлов браузера" && Field<ProgressBar>(form, "progress").Style == ProgressBarStyle.Marquee, name + " verification has no fabricated percentage");
            Invoke(form, "OnEngineEvent", new EngineEvent("downloading", 43));
            SetField(form, "running", false);
            SetField(form, "cancellation", null);
            if (state == "retry")
            {
                Invoke(form, "SetStatus", EngineRunner.FriendlyError("network", false));
                Invoke(form, "SetRetry");
                primary.Enabled = true;
                Check(primary.Visible && destination.Enabled && cancel.Enabled, name + " retry restores controls");
            }
        }
        if (state == "complete")
        {
            Invoke(form, "ShowComplete");
            Check(primary.Text.Contains(uninstall ? "Закрыть" : "Открыть Velmren"), name + " finish action is direct");
            Check(uninstall || ReferenceEquals(form.CancelButton, cancel), name + " closing does not launch browser");
        }
        if (scale != 1F)
        {
            form.Scale(new SizeF(scale, scale));
            form.Font = new Font("Segoe UI", 14F);
        }
        form.PerformLayout();
        foreach (Control child in form.Controls) child.CreateControl();
        using var bitmap = new Bitmap(form.Width, form.Height);
        form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size));
        bitmap.Save(Path.Combine(output, name + "-native-render.png"));
        Check(state == "download" || form.AcceptButton is Button { Enabled: true }, name + " default keyboard action");
        Check(form.CancelButton is Button, name + " escape action");
        Check(form.AutoScaleMode == AutoScaleMode.Dpi, name + " DPI scaling");
        var actionBounds = form.RectangleToClient(primary.RectangleToScreen(primary.ClientRectangle));
        Check(!primary.Visible || form.ClientRectangle.Contains(actionBounds), name + " primary action fits window");
        var inputBounds = options.RectangleToClient(destination.RectangleToScreen(destination.ClientRectangle));
        Check(!options.Visible || options.ClientRectangle.Contains(inputBounds), name + " folder input fits expanded settings");
        Check(form.ClientRectangle.Contains(form.RectangleToClient(closeWindow.RectangleToScreen(closeWindow.ClientRectangle))), name + " close action fits window");
        if (state == "download")
        {
            using var cancellation = new CancellationTokenSource();
            SetField(form, "running", true);
            SetField(form, "cancellation", cancellation);
            cancel.PerformClick();
            Check(cancellation.IsCancellationRequested && !cancel.Enabled && Field<Label>(form, "status").Text == "Остановка…", name + " cancel requests cancellation and gives feedback");
            using var closeCancellation = new CancellationTokenSource();
            SetField(form, "cancellation", closeCancellation);
            closeWindow.PerformClick();
            Check(closeCancellation.IsCancellationRequested && !form.IsDisposed && Field<bool>(form, "closingAfterCancel"), name + " caption close waits for cancellation instead of abandoning work");
            SetField(form, "running", false);
            SetField(form, "cancellation", null);
        }
        if (name == "online") Check(form.TestKey(Keys.Alt | Keys.F4) && form.IsDisposed, name + " Alt F4 closes through the form lifecycle");
        else form.Close();
    }

    private static T Field<T>(SetupForm form, string name) => (T)typeof(SetupForm).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(form)!;
    private static void SetField(SetupForm form, string name, object? value) => typeof(SetupForm).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(form, value);
    private static void Invoke(SetupForm form, string name, params object[] arguments) => typeof(SetupForm).GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(form, arguments);

    private static int WindowHit(Form form, Point point)
    {
        var screen = form.PointToScreen(point);
        var packed = (screen.Y << 16) | (screen.X & 0xffff);
        return (int)SendMessage(form.Handle, 0x0084, IntPtr.Zero, (IntPtr)packed);
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
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    private sealed class SynchronousProgress(Action<EngineEvent> report) : IProgress<EngineEvent>
    {
        public void Report(EngineEvent value) => report(value);
    }
    private sealed class PreviewForm(SetupOptions options, SetupPayload payload) : SetupForm(options, payload)
    {
        internal bool TestKey(Keys keys)
        {
            var message = Message.Create(Handle, 0x0104, (IntPtr)Keys.F4, IntPtr.Zero);
            return ProcessCmdKey(ref message, keys);
        }
        protected override bool ShowWithoutActivation => true;
        protected override CreateParams CreateParams
        {
            get { var parameters = base.CreateParams; parameters.ExStyle |= 0x08000000; return parameters; }
        }
    }
}
