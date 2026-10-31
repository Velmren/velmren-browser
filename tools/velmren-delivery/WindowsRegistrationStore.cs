using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace Velmren.Delivery;

[SupportedOSPlatform("windows")]
internal sealed class WindowsRegistrationStore : IRegistrationStore
{
    public IRegistrationKey? Open(string path)
    {
        var key = Registry.CurrentUser.OpenSubKey(path, writable: true);
        return key is null ? null : new WindowsRegistrationKey(key);
    }

    public (IRegistrationKey Key, bool Created) Create(string path)
    {
        // The disposition distinguishes a fresh key from a concurrent foreign
        // create; RegistryKey.CreateSubKey does not expose that distinction.
        using var parentHandle = Registry.CurrentUser.Handle;
        var error = RegCreateKeyExW(parentHandle, path, 0, null, 0,
            0x2001f, IntPtr.Zero, out var handle, out var disposition);
        if (error != 0) { handle.Dispose(); throw new System.ComponentModel.Win32Exception(error); }
        try { return (new WindowsRegistrationKey(RegistryKey.FromHandle(handle)), disposition == 1); }
        catch { handle.Dispose(); throw; }
    }

    public void Delete(string path) => Registry.CurrentUser.DeleteSubKey(path, throwOnMissingSubKey: false);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern int RegCreateKeyExW(SafeRegistryHandle key, string subKey, int reserved,
        string? keyClass, int options, int access, IntPtr securityAttributes,
        out SafeRegistryHandle result, out int disposition);
}

[SupportedOSPlatform("windows")]
internal sealed class WindowsRegistrationKey(RegistryKey key) : IRegistrationKey
{
    internal static RegistrationSnapshot Read(RegistryKey key)
    {
        var values = new Dictionary<string, RegistrationValue>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in key.GetValueNames())
        {
            var kind = key.GetValueKind(name);
            var value = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
            values[name] = kind switch
            {
                RegistryValueKind.String when value is string text => RegistrationValue.String(text),
                RegistryValueKind.DWord when value is int number => RegistrationValue.Dword(number),
                _ => new RegistrationValue((int)kind)
            };
        }
        return new(values, key.SubKeyCount);
    }

    public RegistrationSnapshot Snapshot() => Read(key);
    public void DeleteValue(string name) => key.DeleteValue(name, throwOnMissingValue: false);
    public void Set(string name, RegistrationValue value)
    {
        if (value is { Kind: 1, Text: not null }) key.SetValue(name, value.Text, RegistryValueKind.String);
        else if (value is { Kind: 4, Number: not null }) key.SetValue(name, value.Number.Value, RegistryValueKind.DWord);
        else throw new InvalidDataException("Unsupported registration value type.");
    }
    public void Dispose() => key.Dispose();
}
