using System;
using System.Runtime.InteropServices;

public static class CodeXPlusPlusTaskbar
{
    private static readonly Guid AppModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PropertyKey
    {
        internal Guid Format;
        internal uint Id;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropVariant
    {
        [FieldOffset(0)] internal ushort Type;
        [FieldOffset(8)] internal IntPtr String;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [DllImport("shell32.dll")]
    private static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, out IPropertyStore store);

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant value);

    private static void Set(IPropertyStore store, uint id, string text)
    {
        var key = new PropertyKey { Format = AppModel, Id = id };
        var value = new PropVariant { Type = 31, String = Marshal.StringToCoTaskMemUni(text) };
        try
        {
            Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value));
        }
        finally
        {
            PropVariantClear(ref value);
        }
    }

    public static void Apply(IntPtr window, string command, string icon)
    {
        var iid = typeof(IPropertyStore).GUID;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window, ref iid, out var store));
        try
        {
            Set(store, 2, command);
            Set(store, 3, icon);
            Set(store, 4, "CodeX++");
            Set(store, 5, "ChenRan.CodeXPlusPlus.Desktop");
            Marshal.ThrowExceptionForHR(store.Commit());
        }
        finally
        {
            Marshal.ReleaseComObject(store);
        }
    }

    public static string GetIconResource(IntPtr window)
    {
        var iid = typeof(IPropertyStore).GUID;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window, ref iid, out var store));
        try
        {
            var key = new PropertyKey { Format = AppModel, Id = 3 };
            Marshal.ThrowExceptionForHR(store.GetValue(ref key, out var value));
            try { return value.Type == 31 ? Marshal.PtrToStringUni(value.String) : null; }
            finally { PropVariantClear(ref value); }
        }
        finally
        {
            Marshal.ReleaseComObject(store);
        }
    }
}
