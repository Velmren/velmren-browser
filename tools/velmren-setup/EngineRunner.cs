using System.Diagnostics;
using System.Text;

namespace Velmren.Setup;

internal sealed record EngineEvent(string Action, int? Percent, string? Phase = null,
    long? Completed = null, long? Total = null, long? ElapsedMs = null,
    string? Version = null, long? Bytes = null, long? Files = null, bool? Succeeded = null);
internal sealed record EngineResult(int ExitCode, string Error);

internal sealed class EngineRunner
{
    internal static async Task<EngineResult> RunAsync(string engine, IEnumerable<string> arguments,
        string cancelPath, IProgress<EngineEvent>? progress, CancellationToken cancellationToken)
    {
        var info = new ProcessStartInfo(engine)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = Path.GetDirectoryName(engine)!
        };
        info.Arguments = FrameworkCompatibility.Arguments(arguments.Concat(new[] { "--cancel-file", cancelPath }));
        using var process = new Process { StartInfo = info };
        cancellationToken.ThrowIfCancellationRequested();
        process.Start();
        var error = new StringBuilder();
        var stdout = ReadOutputAsync(process.StandardOutput, progress);
        var stderr = ReadErrorAsync(process.StandardError, error);
        using var registration = cancellationToken.Register(() =>
        {
            try { File.WriteAllText(cancelPath, "cancel"); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        });
        try
        {
            await FrameworkCompatibility.WaitForExitAsync(process, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            var stopped = FrameworkCompatibility.WaitForExitAsync(process);
            if (await Task.WhenAny(stopped, Task.Delay(TimeSpan.FromSeconds(8))) != stopped)
            {
                // Never terminate the browser, agent, or unrelated processes.
                try { process.Kill(); }
                catch (InvalidOperationException) { }
            }
            await stopped;
            await Task.WhenAll(stdout, stderr);
            throw;
        }
        await Task.WhenAll(stdout, stderr);
        cancellationToken.ThrowIfCancellationRequested();
        return new EngineResult(process.ExitCode, error.ToString());
    }

    private static async Task ReadOutputAsync(StreamReader reader, IProgress<EngineEvent>? progress)
    {
        while (await reader.ReadLineAsync() is { } line)
        {
            if (line.Length > 64 * 1024) continue;
            var parsed = ParseEvent(line);
            if (parsed is not null) progress?.Report(parsed);
        }
    }

    internal static EngineEvent? ParseEvent(string line)
    {
        try
        {
            var value = JsonCodec.Deserialize<Dictionary<string, object>>(line);
            if (value is null || !value.TryGetValue("action", out var action) || action is not string actionText)
                return null;
            int? percent = null;
            if (value.TryGetValue("percent", out var p) && p is not null)
            {
                if (p is not int number) return null;
                percent = Math.Max(0, Math.Min(number, 100));
            }
            string? phase = null;
            if (value.TryGetValue("phase", out var phaseValue) && phaseValue is not null)
            {
                if (phaseValue is not string phaseText || !KnownPhase(phaseText)) return null;
                phase = phaseText;
            }
            if (actionText is "phase-started" or "phase-completed" && phase is null) return null;
            const long maximumBytes = 1024L * 1024 * 1024 * 1024;
            if (!ReadCount(value, "completed", maximumBytes, out var completed) ||
                !ReadCount(value, "total", maximumBytes, out var total) ||
                !ReadCount(value, "elapsedMs", int.MaxValue, out var elapsed) ||
                !ReadCount(value, "bytes", maximumBytes, out var bytes) ||
                !ReadCount(value, "files", 10000000, out var files) ||
                completed > total) return null;
            if (actionText == "verifying-files" && (completed > 10000000 || total > 10000000)) return null;
            string? version = null;
            if (value.TryGetValue("version", out var versionValue) && versionValue is not null)
            {
                if (versionValue is not string versionText || versionText.Length > 64) return null;
                version = versionText;
            }
            bool? succeeded = null;
            if (value.TryGetValue("succeeded", out var succeededValue) && succeededValue is not null)
            {
                if (succeededValue is not bool success) return null;
                succeeded = success;
            }
            return new EngineEvent(actionText, percent, phase, completed, total, elapsed, version, bytes, files, succeeded);
        }
        catch (ArgumentException) { return null; }
        catch (InvalidOperationException) { return null; }
    }

    private static bool KnownPhase(string phase) => phase is
        "check-update" or "download" or "archive-verify" or "install" or "prepare-release" or
        "archive-preflight" or "extract" or "extract-files" or "sandbox-permissions" or
        "verify-installed" or "launcher-probe" or "activate" or "register" or "retention";

    private static bool ReadCount(Dictionary<string, object> value, string name, long maximum, out long? result)
    {
        result = null;
        if (!value.TryGetValue(name, out var item) || item is null) return true;
        if (item is not int && item is not long) return false;
        var number = item is int small ? small : (long)item;
        if (number < 0 || number > maximum) return false;
        result = number;
        return true;
    }

    private static async Task ReadErrorAsync(StreamReader reader, StringBuilder error)
    {
        var buffer = new char[2048];
        int count;
        while ((count = await reader.ReadAsync(buffer, 0, buffer.Length)) > 0)
        {
            if (error.Length < 8192) error.Append(buffer, 0, Math.Min(count, 8192 - error.Length));
        }
    }

    internal static string FriendlyError(string error, bool uninstall)
    {
        if (error.Contains("busy", StringComparison.OrdinalIgnoreCase) || error.Contains("running", StringComparison.OrdinalIgnoreCase) || error.Contains("in use", StringComparison.OrdinalIgnoreCase))
            return "Закройте Velmren и его фоновые процессы, затем повторите попытку.";
        if (error.Contains("UnauthorizedAccess", StringComparison.OrdinalIgnoreCase) || error.Contains("access denied", StringComparison.OrdinalIgnoreCase))
            return "Нет доступа к выбранной папке. Проверьте разрешения или выберите другую папку.";
        if (error.Contains("space", StringComparison.OrdinalIgnoreCase) || error.Contains("disk full", StringComparison.OrdinalIgnoreCase))
            return "На диске недостаточно места. Освободите место и повторите попытку.";
        if (error.Contains("HttpRequest", StringComparison.OrdinalIgnoreCase) || error.Contains("network", StringComparison.OrdinalIgnoreCase) || error.Contains("timeout", StringComparison.OrdinalIgnoreCase))
            return "Не удалось загрузить файлы. Проверьте подключение к интернету и повторите попытку.";
        return uninstall
            ? "Не удалось удалить Velmren. Закройте программу и повторите попытку. Сохранённый профиль останется на компьютере."
            : "Не удалось завершить установку. Повторите попытку. Если ошибка повторяется, скачайте установщик заново.";
    }
}
