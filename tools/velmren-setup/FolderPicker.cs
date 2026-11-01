using System.Runtime.InteropServices;

namespace Velmren.Setup;

// Use the same Explorer folder picker on Framework as on modern WinForms.
internal static class FolderPicker
{
    internal static string? Show(IWin32Window owner, string selectedPath)
    {
        var dialog = (IFileDialog)new FileOpenDialog();
        IShellItem? initial = null;
        IShellItem? result = null;
        try
        {
            dialog.SetOptions(0x20 | 0x40 | 0x800 | 0x8); // Folders, filesystem, existing path, no cwd change.
            dialog.SetTitle("Выберите папку для Velmren");
            var path = selectedPath;
            while (!string.IsNullOrEmpty(path) && !Directory.Exists(path)) path = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(path))
            {
                var shellItem = typeof(IShellItem).GUID;
                if (SHCreateItemFromParsingName(path, IntPtr.Zero, ref shellItem, out initial) == 0) dialog.SetFolder(initial);
            }
            var status = dialog.Show(owner.Handle);
            if (status == unchecked((int)0x800704C7)) return null; // User cancelled.
            Marshal.ThrowExceptionForHR(status);
            dialog.GetResult(out result);
            result.GetDisplayName(0x80058000, out var name); // SIGDN_FILESYSPATH.
            try { return Marshal.PtrToStringUni(name); }
            finally { Marshal.FreeCoTaskMem(name); }
        }
        finally
        {
            if (result is not null) Marshal.ReleaseComObject(result);
            if (initial is not null) Marshal.ReleaseComObject(initial);
            Marshal.ReleaseComObject(dialog);
        }
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr binding, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr types);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr binding, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint kind, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }
}
