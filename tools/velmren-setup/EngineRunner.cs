using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Velmren.Setup;

internal sealed record EngineEvent(string Action, int? Percent);
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
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        info.ArgumentList.Add("--cancel-file");
        info.ArgumentList.Add(cancelPath);
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
            await process.WaitForExitAsync(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(8)); }
            catch (TimeoutException)
            {
                // Never terminate the browser, agent, or unrelated processes.
                try { process.Kill(entireProcessTree: false); }
                catch (InvalidOperationException) { }
                await process.WaitForExitAsync();
            }
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
            using var document = JsonDocument.Parse(line);
            var value = document.RootElement;
            if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("action", out var action) || action.ValueKind != JsonValueKind.String)
                return null;
            int? percent = value.TryGetProperty("percent", out var p) && p.TryGetInt32(out var number) ? Math.Clamp(number, 0, 100) : null;
            return new EngineEvent(action.GetString()!, percent);
        }
        catch (JsonException) { return null; }
        catch (InvalidOperationException) { return null; }
    }

    private static async Task ReadErrorAsync(StreamReader reader, StringBuilder error)
    {
        var buffer = new char[2048];
        int count;
        while ((count = await reader.ReadAsync(buffer)) > 0)
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
