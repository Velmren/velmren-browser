using System.Diagnostics;

namespace Velmren.Setup;

internal class SetupForm : SetupWindow
{
    private readonly bool uninstall;
    private readonly bool online;
    private readonly Label heading = new();
    private readonly Label introduction = new();
    private readonly PictureBox brand = new();
    private readonly TableLayoutPanel locationPanel = new();
    private readonly TableLayoutPanel optionsPanel = new();
    private readonly Label locationSummary = new();
    private readonly Label locationCaption = new();
    private readonly LinkLabel changeOptions = new();
    private readonly TextBox destination = new();
    private readonly SetupButton browse = new();
    private readonly CheckBox desktop = new();
    private readonly Label status = new();
    private readonly ProgressBar progress = new();
    private readonly SetupButton primary = new() { Emphasized = true };
    private readonly SetupButton cancel = new() { Quiet = true };
    private readonly ErrorProvider errors = new();
    private PayloadSession? payload;
    private CancellationTokenSource? cancellation;
    private bool complete;
    private bool running;
    private bool closingAfterCancel;
    private bool cleaningUp;
    private bool launchOnFinish = true;
    private string selectedRoot;

    internal SetupForm(SetupOptions options, SetupPayload? configuration = null)
    {
        selectedRoot = options.Root;
        configuration ??= PayloadSession.ReadConfiguration();
        var hasSource = configuration.Package is not null || configuration.Feed is not null;
        online = configuration.Package is null && configuration.Feed is not null;
        uninstall = options.Uninstall || (!hasSource && options.RootSpecified && File.Exists(Path.Combine(selectedRoot, "Velmren.exe")));

        Text = "Velmren";
        Font = new Font("Segoe UI", 11F);
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(600, 380);
        MinimumSize = new Size(600, 380);
        MaximizeBox = false;
        BackColor = SetupPalette.Surface;
        ForeColor = SetupPalette.Ink;
        AccessibleName = uninstall ? "Удаление Velmren" : "Установка Velmren";
        using (var iconStream = typeof(SetupForm).Assembly.GetManifestResourceStream("Setup.Brand.Icon"))
            if (iconStream is not null) Icon = new Icon(iconStream);
        using (var imageStream = typeof(SetupForm).Assembly.GetManifestResourceStream("Setup.Brand.Logo"))
            if (imageStream is not null)
            {
                using var source = Image.FromStream(imageStream);
                brand.Image = new Bitmap(source);
            }

        var layout = new SetupLayout
        {
            Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5, AutoScroll = true,
            Padding = new Padding(40, 12, 40, 32), BackColor = SetupPalette.Surface
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var header = new TableLayoutPanel
        {
            AutoSize = true, Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2,
            Margin = new Padding(0, 0, 0, 32)
        };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        brand.Size = new Size(64, 64);
        brand.SizeMode = PictureBoxSizeMode.Zoom;
        brand.Margin = new Padding(0, 4, 20, 0);
        brand.TabStop = false;
        brand.AccessibleRole = AccessibleRole.None;
        header.Controls.Add(brand, 0, 0);
        header.SetRowSpan(brand, 2);
        heading.Text = uninstall ? "Удалить Velmren?" : "Velmren";
        heading.Font = new Font("Segoe UI Semibold", 26F);
        heading.AutoSize = true;
        heading.Dock = DockStyle.Fill;
        heading.Margin = new Padding(0, 0, 0, 4);
        heading.AccessibleRole = AccessibleRole.StaticText;
        header.Controls.Add(heading, 1, 0);

        introduction.Text = uninstall
            ? "Браузер будет удалён. Ваш профиль и данные агентов останутся на компьютере."
            : "Браузер для Windows";
        introduction.AutoSize = true;
        introduction.Dock = DockStyle.Fill;
        introduction.Margin = Padding.Empty;
        header.Controls.Add(introduction, 1, 1);
        layout.Controls.Add(header, 0, 0);

        locationPanel.AutoSize = true;
        locationPanel.Dock = DockStyle.Fill;
        locationPanel.ColumnCount = 2;
        locationPanel.RowCount = 2;
        locationPanel.Margin = Padding.Empty;
        locationPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        locationPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        locationCaption.Text = uninstall ? "Папка браузера" : "Папка установки";
        locationCaption.AutoSize = true;
        locationCaption.Margin = new Padding(0, 0, 0, 8);
        locationPanel.Controls.Add(locationCaption, 0, 0);
        locationSummary.Text = selectedRoot;
        locationSummary.AutoSize = true;
        locationSummary.Dock = DockStyle.Fill;
        locationSummary.Margin = new Padding(0, 0, 12, 0);
        locationSummary.UseMnemonic = false;
        locationSummary.AccessibleName = "Папка установки: " + selectedRoot;
        locationPanel.Controls.Add(locationSummary, 0, 1);
        changeOptions.Text = "&Изменить";
        changeOptions.AutoSize = true;
        changeOptions.Padding = new Padding(0, 4, 0, 4);
        changeOptions.Margin = Padding.Empty;
        changeOptions.TabIndex = 0;
        changeOptions.Visible = !uninstall;
        changeOptions.AccessibleName = "Изменить папку и параметры установки";
        changeOptions.LinkBehavior = LinkBehavior.HoverUnderline;
        changeOptions.LinkClicked += (_, _) => SetOptionsExpanded(!optionsPanel.Visible);
        locationPanel.Controls.Add(changeOptions, 1, 0);
        locationPanel.SetRowSpan(changeOptions, 2);
        layout.Controls.Add(locationPanel, 0, 1);

        optionsPanel.AutoSize = true;
        optionsPanel.Dock = DockStyle.Fill;
        optionsPanel.ColumnCount = 2;
        optionsPanel.RowCount = 2;
        optionsPanel.Margin = new Padding(0, 12, 0, 0);
        optionsPanel.Visible = false;
        optionsPanel.TabIndex = 1;
        optionsPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        optionsPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        destination.Text = selectedRoot;
        destination.AccessibleName = "Папка установки";
        destination.TabIndex = 1;
        destination.ReadOnly = uninstall;
        destination.TextChanged += (_, _) =>
        {
            errors.SetError(destination, "");
            locationSummary.Text = destination.Text;
            locationSummary.AccessibleName = "Папка установки: " + destination.Text;
        };
        var destinationField = new FolderField(destination) { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 12, 0), TabIndex = 1 };
        optionsPanel.Controls.Add(destinationField, 0, 0);
        browse.Text = "&Обзор…";
        browse.AutoSize = true;
        browse.MinimumSize = new Size(100, 44);
        browse.Margin = Padding.Empty;
        browse.TabIndex = 2;
        browse.Visible = !uninstall;
        browse.Click += BrowseClick;
        optionsPanel.Controls.Add(browse, 1, 0);
        desktop.Text = "Создать &ярлык на рабочем столе";
        desktop.AutoSize = true;
        desktop.Checked = true;
        desktop.Margin = new Padding(0, 16, 0, 0);
        desktop.TabIndex = 3;
        desktop.Visible = !uninstall;
        optionsPanel.Controls.Add(desktop, 0, 1);
        optionsPanel.SetColumnSpan(desktop, 2);
        layout.Controls.Add(optionsPanel, 0, 2);

        var statusPanel = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Margin = new Padding(0, 20, 0, 20) };
        statusPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        statusPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        statusPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        status.Text = uninstall ? "Закройте Velmren перед удалением." : "";
        status.AutoSize = true;
        status.Dock = DockStyle.Fill;
        status.Margin = new Padding(0, 0, 0, 12);
        status.AccessibleRole = AccessibleRole.StaticText;
        statusPanel.Controls.Add(status, 0, 0);
        progress.Dock = DockStyle.Top;
        progress.Height = 8;
        progress.Margin = Padding.Empty;
        progress.Visible = false;
        progress.AccessibleName = "Ход установки";
        statusPanel.Controls.Add(progress, 0, 1);
        layout.Controls.Add(statusPanel, 0, 3);

        var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Margin = Padding.Empty };
        buttons.TabIndex = 3;
        cancel.Text = "Отмена";
        cancel.MinimumSize = new Size(96, 48);
        cancel.AutoSize = true;
        cancel.Margin = new Padding(0, 0, 12, 0);
        cancel.TabIndex = 1;
        cancel.Click += (_, _) => CancelOrClose();
        primary.Text = uninstall ? "&Удалить" : online ? "&Скачать и установить" : "&Установить Velmren";
        primary.MinimumSize = new Size(246, 48);
        primary.Font = new Font("Segoe UI Semibold", 11F);
        primary.AutoSize = true;
        primary.Margin = Padding.Empty;
        primary.TabIndex = 0;
        primary.Click += async (_, _) => await PrimaryClickAsync();
        buttons.Controls.Add(primary);
        buttons.Controls.Add(cancel);
        layout.Controls.Add(buttons, 0, 4);
        Controls.Add(layout);
        layout.BringToFront();
        closeWindow.BringToFront();
        AcceptButton = primary;
        CancelButton = cancel;
        errors.ContainerControl = this;
        errors.BlinkStyle = ErrorBlinkStyle.NeverBlink;
        ApplyColors();
        SystemColorsChanged += (_, _) => ApplyColors();

        if (!hasSource && !uninstall)
        {
            primary.Enabled = false;
            destination.Enabled = false;
            browse.Enabled = false;
            desktop.Enabled = false;
            changeOptions.Enabled = false;
            SetStatus("В этом файле нет установочного пакета. Откройте полный установщик Velmren.");
        }
        Shown += (_, _) => primary.Focus();
        FormClosing += OnClosing;
        FormClosed += (_, _) => { payload?.Dispose(); errors.Dispose(); brand.Image?.Dispose(); Icon?.Dispose(); };
    }

    private void ApplyColors()
    {
        var highContrast = SystemInformation.HighContrast;
        var ink = SetupPalette.Ink;
        BackColor = SetupPalette.Surface;
        ForeColor = ink;
        foreach (var panel in Controls.OfType<TableLayoutPanel>()) panel.BackColor = BackColor;
        heading.ForeColor = ink;
        introduction.ForeColor = SetupPalette.Muted;
        locationCaption.ForeColor = SetupPalette.Muted;
        status.ForeColor = SetupPalette.Muted;
        changeOptions.LinkColor = highContrast ? SystemColors.HotTrack : ink;
        changeOptions.ActiveLinkColor = highContrast ? SystemColors.HotTrack : Color.FromArgb(18, 66, 77);
        changeOptions.VisitedLinkColor = changeOptions.LinkColor;
        Invalidate(true);
    }

    private void SetOptionsExpanded(bool expanded)
    {
        if (uninstall || running || complete) return;
        optionsPanel.Visible = expanded;
        locationSummary.Visible = !expanded;
        changeOptions.Text = expanded ? "&Свернуть" : "&Изменить";
        changeOptions.AccessibleName = expanded ? "Свернуть параметры установки" : "Изменить папку и параметры установки";
        var compactHeight = (int)Math.Ceiling(380 * DeviceDpi / 96.0);
        var expandedHeight = (int)Math.Ceiling(460 * DeviceDpi / 96.0);
        if (expanded && Height < expandedHeight) Size = new Size(Width, expandedHeight);
        else if (!expanded && Height <= expandedHeight) Size = new Size(Width, compactHeight);
        if (expanded) destination.Focus();
    }

    private void BrowseClick(object? sender, EventArgs e)
    {
        var selected = FolderPicker.Show(this, destination.Text);
        if (selected is not null) destination.Text = selected;
    }

    private async Task PrimaryClickAsync()
    {
        if (running) return;
        if (complete)
        {
            if (!uninstall && launchOnFinish)
            {
                try
                {
                    var executable = Path.Combine(selectedRoot, "Velmren.exe");
                    PayloadSession.EnsureNoLinks(executable);
                    var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = selectedRoot };
                    info.Arguments = FrameworkCompatibility.Arguments(new[] { "launch", "--root", selectedRoot });
                    Process.Start(info)?.Dispose();
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
                {
                    launchOnFinish = false;
                    primary.Text = "&Закрыть";
                    SetStatus("Velmren установлен, но не удалось открыть его. Запустите программу через меню «Пуск».");
                    return;
                }
            }
            Close();
            return;
        }
        try { selectedRoot = SetupOptions.ValidateRoot(destination.Text); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            errors.SetError(destination, "Укажите полный путь к папке, например C:\\Users\\Имя\\AppData\\Local\\Programs\\Velmren.");
            SetStatus("Выберите папку для установки Velmren.");
            SetOptionsExpanded(true);
            destination.Focus();
            return;
        }

        SetOptionsExpanded(false);
        running = true;
        cancellation = new CancellationTokenSource();
        ShowWorking();
        var token = cancellation.Token;
        try
        {
            payload ??= await PayloadSession.ExtractAsync(token, MaintenanceRelocation.CacheRootFor(selectedRoot), selectedRoot);
            payload.ResetCancellation();
            var notifications = new Progress<EngineEvent>(OnEngineEvent);
            var arguments = new List<string> { uninstall ? "uninstall" : payload.BundleDirectory is null ? "install" : "install-bundle", "--root", selectedRoot };
            if (!uninstall)
            {
                if (payload.BundleDirectory is not null) { arguments.Add("--bundle-directory"); arguments.Add(payload.BundleDirectory); }
                if (payload.Feed is not null) { arguments.Add("--feed"); arguments.Add(payload.Feed); }
            }
            var result = await EngineRunner.RunAsync(payload.EnginePath, arguments, payload.CancelPath, notifications, token);
            if (result.ExitCode != 0) throw new EngineFailure(result.Error);
            if (!uninstall)
            {
                SetStatus("Создание ярлыков…");
                result = await EngineRunner.RunAsync(payload.EnginePath, ["register", "--root", selectedRoot, "--desktop", desktop.Checked ? "true" : "false"], payload.CancelPath, notifications, token);
                if (result.ExitCode != 0) throw new EngineFailure(result.Error);
            }
            ShowComplete();
        }
        catch (OperationCanceledException)
        {
            SetStatus(uninstall ? "Удаление остановлено. Можно повторить попытку." : "Установка остановлена. Можно продолжить, нажав «Повторить».");
            SetRetry();
        }
        catch (EngineFailure ex)
        {
            SetStatus(EngineRunner.FriendlyError(ex.Message, uninstall));
            SetRetry();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException or System.ComponentModel.Win32Exception)
        {
            SetStatus(EngineRunner.FriendlyError(ex.GetType().Name + ": " + ex.Message, uninstall));
            SetRetry();
        }
        finally
        {
            running = false;
            cancellation.Dispose();
            cancellation = null;
            primary.Enabled = true;
            primary.Visible = true;
            cancel.Enabled = true;
            if (closingAfterCancel) Close();
            else primary.Focus();
        }
    }

    private void ShowWorking()
    {
        primary.Enabled = false;
        primary.Visible = false;
        locationPanel.Visible = false;
        optionsPanel.Visible = false;
        destination.Enabled = false;
        browse.Enabled = false;
        desktop.Enabled = false;
        cancel.Text = "Отмена";
        cancel.Enabled = true;
        progress.Visible = true;
        progress.Style = ProgressBarStyle.Marquee;
        heading.Text = uninstall ? "Удаляем Velmren" : "Установка Velmren";
        introduction.Text = uninstall ? "Ваш профиль и данные агентов останутся на компьютере." : "Это окно можно оставить открытым.";
        SetStatus("Подготовка файлов…");
    }

    private void ShowComplete()
    {
        complete = true;
        heading.Text = uninstall ? "Velmren удалён" : "Всё готово";
        introduction.Text = uninstall ? "Профиль браузера и данные агентов сохранены." : "Velmren установлен. Можно открывать браузер.";
        SetStatus(uninstall ? "Удаление завершено." : "Ярлык Velmren доступен в меню «Пуск».");
        progress.Visible = false;
        progress.Style = ProgressBarStyle.Continuous;
        progress.Value = 100;
        locationPanel.Visible = false;
        optionsPanel.Visible = false;
        primary.Text = uninstall ? "&Закрыть" : "&Открыть Velmren";
        primary.Visible = true;
        cancel.Text = "Закрыть";
        cancel.Visible = !uninstall;
        CancelButton = uninstall ? primary : cancel;
    }

    private void SetRetry()
    {
        heading.Text = uninstall ? "Удаление прервано" : "Установка прервана";
        introduction.Text = "Исправьте причину и повторите попытку.";
        progress.Style = ProgressBarStyle.Continuous;
        progress.Value = 0;
        progress.Visible = false;
        locationPanel.Visible = true;
        primary.Text = "&Повторить";
        primary.Visible = true;
        cancel.Text = "Закрыть";
        destination.Enabled = !uninstall;
        browse.Enabled = !uninstall;
        desktop.Enabled = !uninstall;
    }

    private void OnEngineEvent(EngineEvent value)
    {
        if (!running || cancellation?.IsCancellationRequested != false) return;
        var text = value.Action switch
        {
            "download-started" or "downloading" or "download-resumed" => "Скачивание браузера",
            "downloaded" or "verifying" or "bundle-verifying" or "verified" => "Проверка файлов браузера",
            "extracting" or "bundle-extracting" => "Установка браузера",
            "staged" or "activating" or "activation-started" => "Завершение установки…",
            "installed" or "activated" => "Подготовка к запуску…",
            "registering" or "registered" => "Создание ярлыков…",
            "uninstalling" => "Удаление программы…",
            "uninstalled" => "Завершение удаления…",
            _ => null
        };
        if (text is null) return;
        SetStatus(value.Percent is int current ? $"{text} · {current} %" : text);
        if (value.Percent is int percent)
        {
            progress.Style = ProgressBarStyle.Continuous;
            progress.Value = percent;
        }
        else progress.Style = ProgressBarStyle.Marquee;
    }

    private void SetStatus(string text)
    {
        status.Text = text;
        status.AccessibleName = text;
    }

    private void CancelOrClose()
    {
        if (!running) { Close(); return; }
        cancellation?.Cancel();
        cancel.Enabled = false;
        SetStatus("Остановка…");
    }

    private async void OnClosing(object? sender, FormClosingEventArgs e)
    {
        if (running)
        {
            e.Cancel = true;
            closingAfterCancel = true;
            CancelOrClose();
            return;
        }
        if (payload is null) return;
        e.Cancel = true;
        if (cleaningUp) return;
        cleaningUp = true;
        primary.Enabled = false;
        cancel.Enabled = false;
        await payload.CleanupAsync();
        payload = null;
        Close();
    }

    private sealed class EngineFailure(string message) : Exception(message);
}
