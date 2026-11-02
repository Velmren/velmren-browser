using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Velmren.Delivery;

internal static partial class Program
{
    sealed class NativeArchiveDecoder : IDisposable
    {
        internal const string ResourceName = "Velmren.NativeArchiveDecoder";
        internal const long ImageSize = 936448;
        internal const string ImageSha256 = "ae23615622947262021cba6f4ae40c84702a9a55fef8e0b1bfab8b828748d63a";
        const int ErrorLimit = 16 * 1024;
        readonly CancellationToken cancellationToken;
        string? directory;
        string? imagePath;
        SafeFileHandle? directoryLock;
        FileStream? imageLock;
        Process? process;
        Task<string>? errorReader;
        CancellationTokenRegistration cancellation;

        NativeArchiveDecoder(CancellationToken cancellationToken) => this.cancellationToken = cancellationToken;

        internal static NativeArchiveDecoder? TryStart(string archivePath, CancellationToken cancellationToken)
        {
            using var image = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName);
            if (image is null) return null;
            var decoder = new NativeArchiveDecoder(cancellationToken);
            try { decoder.Start(image, archivePath); return decoder; }
            catch { decoder.Dispose(); throw; }
        }

        void Start(Stream image, string archivePath)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("The compact archive decoder requires Windows.");
            var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (!Path.IsPathFullyQualified(localData)) throw new IOException("Per-user decoder storage is unavailable.");
            var parent = Path.Combine(localData, "Velmren", "NativeDecoder");
            DirectorySafe(parent);
            var candidate = Path.Combine(parent, Guid.NewGuid().ToString("N"));
            CreatePrivateDirectory(candidate);
            directory = candidate;
            NoLinks(directory);
            // Denying delete sharing keeps the private directory at the checked path.
            directoryLock = OpenDirectory(directory, 0, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (directoryLock.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            imagePath = Path.Combine(directory, "7zr.exe");
            using (var output = new FileStream(imagePath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                var buffer = new byte[64 * 1024];
                long copied = 0;
                int count;
                while ((count = image.Read(buffer)) != 0)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    copied = checked(copied + count);
                    if (copied > ImageSize) throw new InvalidDataException("Native archive decoder resource length rejected.");
                    output.Write(buffer, 0, count);
                }
                if (copied != ImageSize) throw new InvalidDataException("Native archive decoder resource length rejected.");
                output.Flush(true);
            }
            NoLinks(imagePath);
            // Verify through the same handle that prevents replacement or modification until exit.
            imageLock = new FileStream(imagePath, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (imageLock.Length != ImageSize || !Convert.ToHexStringLower(SHA256.HashData(imageLock)).Equals(ImageSha256, StringComparison.Ordinal))
                throw new CryptographicException("Native archive decoder SHA-256 rejected.");
            cancellationToken.ThrowIfCancellationRequested();
            process = new Process { StartInfo = new ProcessStartInfo(imagePath)
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            } };
            foreach (var argument in new[] { "x", "-t7z", "-so", "-bd", "-bb0", "-bso0", "-bse2", "-bsp0", "-spd", "-y", "--", archivePath })
                process.StartInfo.ArgumentList.Add(argument);
            if (!process.Start()) throw new IOException("Native archive decoder did not start.");
            process.StandardInput.Close();
            errorReader = DrainErrors(process.StandardError);
            cancellation = cancellationToken.Register(TryTerminate);
            cancellationToken.ThrowIfCancellationRequested();
        }

        internal void ReadExactly(Span<byte> buffer)
        {
            while (!buffer.IsEmpty)
            {
                var count = ReadOutput(buffer);
                if (count == 0) throw new InvalidDataException("Native archive output ended before the signed file length.");
                buffer = buffer[count..];
            }
        }

        int ReadOutput(Span<byte> buffer)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int count;
            try { count = process!.StandardOutput.BaseStream.Read(buffer); }
            catch (IOException) when (cancellationToken.IsCancellationRequested)
            {
                cancellationToken.ThrowIfCancellationRequested();
                throw;
            }
            cancellationToken.ThrowIfCancellationRequested();
            return count;
        }

        internal void Complete()
        {
            Span<byte> extra = stackalloc byte[1];
            if (ReadOutput(extra) != 0) throw new InvalidDataException("Native archive output exceeds the signed inventory.");
            if (!process!.WaitForExit(30000)) throw new IOException("Native archive decoder did not exit.");
            cancellationToken.ThrowIfCancellationRequested();
            var errors = errorReader!.GetAwaiter().GetResult();
            if (process.ExitCode != 0) throw new InvalidDataException($"Native archive decoder failed ({process.ExitCode}): {errors}");
        }

        static async Task<string> DrainErrors(StreamReader reader)
        {
            var errors = new StringBuilder();
            var buffer = new char[2048];
            int count;
            while ((count = await reader.ReadAsync(buffer).ConfigureAwait(false)) != 0)
                if (errors.Length < ErrorLimit) errors.Append(buffer, 0, Math.Min(count, ErrorLimit - errors.Length));
            return errors.ToString();
        }

        void TryTerminate()
        {
            try { if (process is not null && !process.HasExited) process.Kill(); }
            catch (InvalidOperationException) { }
            catch (Win32Exception) { }
        }

        public void Dispose()
        {
            cancellation.Dispose();
            try
            {
                if (process is not null)
                {
                    TryTerminate();
                    try
                    {
                        if (!process.WaitForExit(10000)) throw new IOException("Native archive decoder could not be stopped.");
                        _ = errorReader?.GetAwaiter().GetResult();
                    }
                    catch (InvalidOperationException) { } // Process creation failed before a child existed.
                }
            }
            finally
            {
                process?.Dispose();
                imageLock?.Dispose();
                try
                {
                    if (imagePath is not null) { NoLinks(imagePath); File.Delete(imagePath); }
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                finally { directoryLock?.Dispose(); }
                try
                {
                    if (directory is not null) { NoLinks(directory); Directory.Delete(directory, false); }
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }

        static void CreatePrivateDirectory(string path)
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
            using var identity = WindowsIdentity.GetCurrent();
            var user = identity.User ?? throw new IOException("Current user security identifier is unavailable.");
            var security = new DirectorySecurity();
            security.SetOwner(user);
            security.SetAccessRuleProtection(true, false);
            foreach (var sid in new[] { user, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
                security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            var descriptor = security.GetSecurityDescriptorBinaryForm();
            var pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
            try
            {
                var attributes = new NativeSecurityAttributes { Length = Marshal.SizeOf<NativeSecurityAttributes>(), SecurityDescriptor = pinned.AddrOfPinnedObject() };
                if (!CreateDirectory(path, ref attributes)) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally { pinned.Free(); }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct NativeSecurityAttributes
        {
            internal int Length;
            internal IntPtr SecurityDescriptor;
            internal int InheritHandle;
        }

        [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool CreateDirectory(string path, ref NativeSecurityAttributes attributes);

        [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle OpenDirectory(string path, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
            uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
    }
}
