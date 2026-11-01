using System.Diagnostics;
using System.Text;
using System.Web.Script.Serialization;

namespace System.Runtime.CompilerServices
{
    internal static class IsExternalInit { }
}

namespace Velmren.Setup
{
    internal static class JsonCodec
    {
        internal static T Deserialize<T>(string value) => new JavaScriptSerializer
        {
            MaxJsonLength = 64 * 1024, RecursionLimit = 16
        }.Deserialize<T>(value);

        internal static string Serialize(object value) => new JavaScriptSerializer().Serialize(value);
    }

    internal static class FrameworkCompatibility
    {
        internal static string ProcessPath { get { using var process = Process.GetCurrentProcess(); return process.MainModule!.FileName; } }
        internal static int ProcessId { get { using var process = Process.GetCurrentProcess(); return process.Id; } }

        // ProcessStartInfo.Arguments uses the Windows CRT quoting rules, never a shell.
        internal static string Arguments(IEnumerable<string> values) => string.Join(" ", values.Select(QuoteArgument));

        private static string QuoteArgument(string value)
        {
            var result = new StringBuilder("\"");
            var slashes = 0;
            foreach (var character in value)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"') result.Append('\\', slashes * 2 + 1);
                else result.Append('\\', slashes);
                result.Append(character);
                slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }

        internal static async Task WaitForExitAsync(Process process, CancellationToken token = default)
        {
            var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            EventHandler exited = (_, _) => completion.TrySetResult(true);
            process.EnableRaisingEvents = true;
            process.Exited += exited;
            try
            {
                if (process.HasExited) return;
                using (token.Register(() => completion.TrySetCanceled())) await completion.Task;
            }
            finally { process.Exited -= exited; }
        }

        internal static bool IsFullyQualified(string path) =>
            path.Length >= 3 && char.IsLetter(path[0]) && path[1] == ':' && (path[2] == '\\' || path[2] == '/') ||
            path.StartsWith("\\\\", StringComparison.Ordinal) && path.Length > 2;

        internal static bool Contains(this string value, string text, StringComparison comparison) => value.IndexOf(text, comparison) >= 0;
    }
}
