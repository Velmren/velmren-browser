using System.Diagnostics;
using System.Text.Json;

namespace Velmren.Delivery;

internal static partial class Program
{
    static OperationPhase StartPhase(string? root, string phase, string? version = null,
        long? bytes = null, int? files = null) => new(root, phase, version, bytes, files);

    sealed class OperationPhase : IDisposable
    {
        readonly string? root;
        readonly string phase;
        readonly string? version;
        readonly long? bytes;
        readonly int? files;
        readonly Stopwatch timer = Stopwatch.StartNew();
        bool completed;
        bool disposed;

        internal OperationPhase(string? root, string phase, string? version, long? bytes, int? files)
        {
            this.root = root; this.phase = phase; this.version = version;
            this.bytes = bytes; this.files = files;
            Write("phase-started", 0, null);
        }

        internal void Complete() => completed = true;

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            timer.Stop();
            Write("phase-completed", timer.ElapsedMilliseconds, completed);
        }

        void Write(string action, long elapsedMs, bool? succeeded)
        {
            var line = JsonSerializer.Serialize(new {
                time = DateTimeOffset.UtcNow, action, phase, elapsedMs, version, bytes, files, succeeded
            });
            try { Console.WriteLine(line); }
            catch (Exception error) when (error is IOException or ObjectDisposedException) { }
            if (root is null) return;
            try
            {
                var path = Path.Combine(root, "events.jsonl");
                NoLinks(path);
                File.AppendAllText(path, line + Environment.NewLine);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException) { }
        }
    }
}
