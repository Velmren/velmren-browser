using System.Drawing.Drawing2D;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Velmren.Setup;

internal static class SetupPalette
{
    internal static Color Surface => SystemInformation.HighContrast ? SystemColors.Window : Color.FromArgb(249, 251, 250);
    internal static Color Ink => SystemInformation.HighContrast ? SystemColors.WindowText : Color.FromArgb(9, 44, 53);
    internal static Color Muted => SystemInformation.HighContrast ? SystemColors.WindowText : Color.FromArgb(88, 105, 108);
    internal static Color Border => SystemInformation.HighContrast ? SystemColors.WindowText : Color.FromArgb(129, 147, 141);

    internal static GraphicsPath Rounded(RectangleF rectangle, float radius)
    {
        var path = new GraphicsPath();
        var diameter = Math.Min(radius * 2, Math.Min(rectangle.Width, rectangle.Height));
        path.AddArc(rectangle.X, rectangle.Y, diameter, diameter, 180, 90);
        path.AddArc(rectangle.Right - diameter, rectangle.Y, diameter, diameter, 270, 90);
        path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rectangle.X, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}

// Native Button semantics and keyboard handling, with only its surface painted here.
internal sealed class SetupButton : Button
{
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal bool Emphasized { get; set; }
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal bool Quiet { get; set; }
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal bool CloseGlyph { get; set; }
    private bool hovered;
    private bool pressed;

    internal SetupButton()
    {
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        UseVisualStyleBackColor = false;
        SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    protected override void OnMouseEnter(EventArgs e) { hovered = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hovered = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { pressed = e.Button == MouseButtons.Left; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnKeyDown(KeyEventArgs e) { if (e.KeyCode == Keys.Space) { pressed = true; Invalidate(); } base.OnKeyDown(e); }
    protected override void OnKeyUp(KeyEventArgs e) { pressed = false; Invalidate(); base.OnKeyUp(e); }
    protected override void OnLostFocus(EventArgs e) { pressed = false; Invalidate(); base.OnLostFocus(e); }
    protected override void OnEnabledChanged(EventArgs e) { pressed = false; hovered = false; Invalidate(); base.OnEnabledChanged(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var highContrast = SystemInformation.HighContrast;
        var scale = DeviceDpi / 96F;
        var fill = Emphasized ? SetupPalette.Ink : Quiet ? SetupPalette.Surface : Color.White;
        var ink = Emphasized ? Color.White : SetupPalette.Ink;
        if (highContrast)
        {
            fill = Emphasized ? SystemColors.Highlight : SystemColors.Control;
            ink = Emphasized ? SystemColors.HighlightText : SystemColors.ControlText;
        }
        else if (pressed) fill = Emphasized ? Color.FromArgb(4, 32, 39) : Color.FromArgb(221, 232, 228);
        else if (hovered) fill = Emphasized ? Color.FromArgb(18, 67, 77) : Color.FromArgb(234, 241, 238);
        if (!Enabled) { fill = highContrast ? SystemColors.Control : Color.FromArgb(231, 237, 234); ink = SystemColors.GrayText; }

        e.Graphics.Clear(Parent?.BackColor ?? SetupPalette.Surface);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var bounds = new RectangleF(0.75F, 0.75F, Width - 1.5F, Height - 1.5F);
        using var shape = SetupPalette.Rounded(bounds, 10 * scale);
        using var brush = new SolidBrush(fill);
        e.Graphics.FillPath(brush, shape);
        if (highContrast || (!Emphasized && !Quiet))
        {
            using var border = new Pen(SetupPalette.Border, scale);
            e.Graphics.DrawPath(border, shape);
        }
        if (CloseGlyph)
        {
            var center = new PointF(Width / 2F, Height / 2F);
            var half = 5 * scale;
            using var pen = new Pen(ink, 1.5F * scale) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            e.Graphics.DrawLine(pen, center.X - half, center.Y - half, center.X + half, center.Y + half);
            e.Graphics.DrawLine(pen, center.X + half, center.Y - half, center.X - half, center.Y + half);
        }
        else
        {
            var flags = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine;
            if (!ShowKeyboardCues) flags |= TextFormatFlags.HidePrefix;
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, ink, flags);
        }
        if (Focused && ShowFocusCues)
        {
            var focus = Rectangle.Inflate(ClientRectangle, -(int)(5 * scale), -(int)(5 * scale));
            ControlPaint.DrawFocusRectangle(e.Graphics, focus, ink, fill);
        }
    }
}

internal sealed class FolderField : Panel
{
    private readonly TextBox input;

    internal FolderField(TextBox input)
    {
        this.input = input;
        MinimumSize = new Size(120, 44);
        Height = 44;
        TabStop = false;
        SetStyle(ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        input.BorderStyle = BorderStyle.None;
        input.Dock = DockStyle.None;
        input.Margin = Padding.Empty;
        input.TabIndex = 0;
        input.Enter += (_, _) => Invalidate();
        input.Leave += (_, _) => Invalidate();
        input.EnabledChanged += (_, _) => Invalidate();
        Controls.Add(input);
    }

    protected override void OnLayout(LayoutEventArgs e)
    {
        base.OnLayout(e);
        var inset = (int)Math.Ceiling(13 * DeviceDpi / 96.0);
        input.SetBounds(inset, Math.Max(0, (Height - input.PreferredHeight) / 2), Math.Max(1, Width - inset * 2), input.PreferredHeight);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var scale = DeviceDpi / 96F;
        e.Graphics.Clear(Parent?.BackColor ?? SetupPalette.Surface);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var shape = SetupPalette.Rounded(new RectangleF(1, 1, Width - 2, Height - 2), 9 * scale);
        var fill = SystemInformation.HighContrast ? SystemColors.Window : Color.White;
        input.BackColor = fill;
        input.ForeColor = SetupPalette.Ink;
        using var brush = new SolidBrush(fill);
        using var border = new Pen(input.Focused ? SetupPalette.Ink : SetupPalette.Border, (input.Focused ? 2 : 1) * scale);
        e.Graphics.FillPath(brush, shape);
        e.Graphics.DrawPath(border, shape);
    }
}

internal class SetupWindow : Form
{
    internal readonly SetupButton closeWindow = new() { Quiet = true, CloseGlyph = true };
    private readonly CaptionPanel caption = new() { Dock = DockStyle.Top, Height = 52, TabIndex = 9 };

    protected SetupWindow()
    {
        FormBorderStyle = FormBorderStyle.None;
        DoubleBuffered = true;
        closeWindow.Size = new Size(40, 40);
        closeWindow.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        closeWindow.AccessibleName = "Закрыть установщик";
        closeWindow.AccessibleDescription = "Закрыть окно. Во время установки сначала остановить операцию.";
        closeWindow.AccessibleRole = AccessibleRole.PushButton;
        closeWindow.TabIndex = 9;
        closeWindow.Click += (_, _) => Close();
        caption.Controls.Add(closeWindow);
        Controls.Add(caption);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.Style |= 0x00040000 | 0x00080000 | 0x00020000; // Sizing, system menu, minimize.
            return parameters;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000))
        {
            var rounded = 2; // DWMWCP_ROUND. DWM retains native shadow and corner clipping.
            _ = DwmSetWindowAttribute(Handle, 33, ref rounded, sizeof(int));
        }
    }

    protected override void OnLayout(LayoutEventArgs e)
    {
        base.OnLayout(e);
        var scale = DeviceDpi / 96F;
        var inset = (int)(12 * scale);
        caption.Height = (int)(52 * scale);
        closeWindow.SetBounds(caption.ClientSize.Width - inset - (int)(40 * scale), inset, (int)(40 * scale), (int)(40 * scale));
        closeWindow.BringToFront();
    }

    internal int HitTestChrome(Point point)
    {
        var border = Math.Max(5, (int)(6 * DeviceDpi / 96F));
        var left = point.X < border;
        var right = point.X >= ClientSize.Width - border;
        var top = point.Y < border;
        var bottom = point.Y >= ClientSize.Height - border;
        if (top && left) return 13;
        if (top && right) return 14;
        if (bottom && left) return 16;
        if (bottom && right) return 17;
        if (left) return 10;
        if (right) return 11;
        if (top) return 12;
        if (bottom) return 15;
        if (point.Y < 58 * DeviceDpi / 96F && !closeWindow.Bounds.Contains(point)) return 2;
        return 1;
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0083 && message.WParam != IntPtr.Zero) // WM_NCCALCSIZE: client covers native caption.
        {
            message.Result = IntPtr.Zero;
            return;
        }
        if (message.Msg == 0x0084) // WM_NCHITTEST: signed coordinates support monitors left of the primary.
        {
            var packed = message.LParam.ToInt64();
            var screen = new Point((short)(packed & 0xffff), (short)((packed >> 16) & 0xffff));
            message.Result = (IntPtr)HitTestChrome(PointToClient(screen));
            return;
        }
        base.WndProc(ref message);
    }

    protected override bool ProcessCmdKey(ref Message message, Keys keyData)
    {
        if (keyData == (Keys.Alt | Keys.F4))
        {
            Close();
            return true;
        }
        return base.ProcessCmdKey(ref message, keyData);
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    private sealed class CaptionPanel : Panel
    {
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x0084) { message.Result = (IntPtr)(-1); return; }
            base.WndProc(ref message);
        }
    }
}

internal sealed class SetupLayout : TableLayoutPanel
{
    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0084 && FindForm() is SetupWindow window)
        {
            var packed = message.LParam.ToInt64();
            var screen = new Point((short)(packed & 0xffff), (short)((packed >> 16) & 0xffff));
            if (window.HitTestChrome(window.PointToClient(screen)) != 1)
            {
                message.Result = (IntPtr)(-1);
                return;
            }
        }
        base.WndProc(ref message);
    }
}
