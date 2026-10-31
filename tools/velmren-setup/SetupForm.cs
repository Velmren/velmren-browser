using System.Diagnostics;

namespace Velmren.Setup;

internal class SetupForm : Form
{
    private readonly bool uninstall;
    private readonly Label heading = new();
    private readonly Label introduction = new();
    private readonly TextBox destination = new();
    private readonly Button browse = new();
    private readonly CheckBox desktop = new();
    private readonly Label status = new();
    private readonly ProgressBar progress = new();
    private readonly CheckBox launch = new();
    private readonly Button primary = new();
    private readonly Button cancel = new();
    private readonly ErrorProvider errors = new();
    private PayloadSession? payload;
    private CancellationTokenSource? cancellation;
    private bool complete;
    private bool running;
    private bool closingAfterCancel;
    private bool cleaningUp;
    private string selectedRoot;

    internal SetupForm(SetupOptions options, SetupPayload? configuration = null)
    {
        selectedRoot = options.Root;
        configuration ??= PayloadSession.ReadConfiguration();
        var hasSource = configuration.Package is not null || configuration.Feed is not null;
        uninstall = options.Uninstall || (!hasSource && options.RootSpecified && File.Exists(Path.Combine(selectedRoot, "Velmren.exe")));

        Text = uninstall ? "Удаление Velmren" : "Установка Velmren";
        Font = new Font("Segoe UI", 10F);
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(640, 440);
        MinimumSize = new Size(580, 440);
        MaximizeBox = false;
        BackColor = SystemColors.Window;
        ForeColor = SystemColors.WindowText;
        AccessibleName = Text;

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6,
            Padding = new Padding(28, 24, 28, 20), BackColor = SystemColors.Window
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        heading.Text = uninstall ? "Удалить Velmren?" : "Установить Velmren";
        heading.Font = new Font(Font.FontFamily, 21F, FontStyle.Bold);
        heading.AutoSize = true;
        heading.Margin = new Padding(0, 0, 0, 8);
        heading.AccessibleRole = AccessibleRole.StaticText;
        layout.Controls.Add(heading, 0, 0);

        introduction.Text = uninstall
            ? "Программа будет удалена. Профиль браузера и данные агентов останутся на компьютере."
            : "Velmren будет доступен в вашей учётной записи Windows.";
        introduction.AutoSize = true;
        introduction.Dock = DockStyle.Fill;
        introduction.Margin = new Padding(0, 0, 0, 24);
        layout.Controls.Add(introduction, 0, 1);

        var optionsPanel = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 3, Margin = Padding.Empty };
        optionsPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        optionsPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var directoryLabel = new Label { Text = uninstall ? "Папка программы" : "&Папка установки", AutoSize = true, Margin = new Padding(0, 0, 0, 6), TabIndex = 0 };
        optionsPanel.Controls.Add(directoryLabel, 0, 0);
        optionsPanel.SetColumnSpan(directoryLabel, 2);
        destination.Text = selectedRoot;
        destination.Dock = DockStyle.Fill;
        destination.Margin = new Padding(0, 3, 12, 0);
        destination.AccessibleName = "Папка установки";
        destination.TabIndex = 1;
        destination.ReadOnly = uninstall;
        destination.TextChanged += (_, _) => errors.SetError(destination, "");
        optionsPanel.Controls.Add(destination, 0, 1);
        browse.Text = "&Обзор…";
        browse.AutoSize = true;
        browse.MinimumSize = new Size(94, 34);
        browse.Margin = Padding.Empty;
        browse.TabIndex = 2;
        browse.Visible = !uninstall;
        browse.Click += BrowseClick;
        optionsPanel.Controls.Add(browse, 1, 1);
        if (uninstall) optionsPanel.SetColumnSpan(destination, 2);
        desktop.Text = "Создать &ярлык на рабочем столе";
        desktop.AutoSize = true;
        desktop.Checked = true;
        desktop.Margin = new Padding(0, 16, 0, 0);
        desktop.TabIndex = 3;
        desktop.Visible = !uninstall;
        optionsPanel.Controls.Add(desktop, 0, 2);
        optionsPanel.SetColumnSpan(desktop, 2);
        layout.Controls.Add(optionsPanel, 0, 2);

        var statusPanel = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Margin = new Padding(0, 24, 0, 16) };
        statusPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        statusPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        statusPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        statusPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        status.Text = uninstall ? "Закройте Velmren перед удалением." : "Всё готово к установке.";
        status.AutoSize = true;
        status.Dock = DockStyle.Fill;
        status.Margin = new Padding(0, 0, 0, 12);
        status.AccessibleRole = AccessibleRole.StaticText;
        statusPanel.Controls.Add(status, 0, 0);
        progress.Dock = DockStyle.Fill;
        progress.Height = 20;
        progress.Margin = Padding.Empty;
        progress.Visible = false;
        progress.AccessibleName = "Ход установки";
        statusPanel.Controls.Add(progress, 0, 1);
        layout.Controls.Add(statusPanel, 0, 3);

        launch.Text = "&Запустить Velmren";
        launch.AutoSize = true;
        launch.Checked = true;
        launch.Visible = false;
        launch.Margin = new Padding(0, 0, 0, 16);
        launch.TabIndex = 4;
        layout.Controls.Add(launch, 0, 4);

        var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Margin = Padding.Empty };
        cancel.Text = "Отмена";
        cancel.MinimumSize = new Size(108, 36);
        cancel.AutoSize = true;
        cancel.Margin = new Padding(12, 0, 0, 0);
        cancel.TabIndex = 6;
        cancel.Click += (_, _) => CancelOrClose();
        primary.Text = uninstall ? "&Удалить" : "&Установить";
        primary.MinimumSize = new Size(132, 36);
        primary.AutoSize = true;
        primary.Margin = Padding.Empty;
        primary.TabIndex = 5;
        primary.Click += async (_, _) => await PrimaryClickAsync();
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(primary);
        layout.Controls.Add(buttons, 0, 5);
        Controls.Add(layout);
        AcceptButton = primary;
        CancelButton = cancel;
        errors.ContainerControl = this;
        errors.BlinkStyle = ErrorBlinkStyle.NeverBlink;

        if (!hasSource && !uninstall)
        {
            primary.Enabled = false;
            destination.Enabled = false;
            browse.Enabled = false;
            desktop.Enabled = false;
            SetStatus("В этом файле нет установочного пакета. Откройте полный установщик Velmren.");
        }
        Shown += (_, _) => primary.Focus();
        FormClosing += OnClosing;
        FormClosed += (_, _) => { payload?.Dispose(); errors.Dispose(); };
    }

    private void BrowseClick(object? sender, EventArgs e)
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Выберите папку для Velmren",
            UseDescriptionForTitle = true,
            SelectedPath = destination.Text,
            ShowNewFolderButton = true
        };
        if (dialog.ShowDialog(this) == DialogResult.OK) destination.Text = dialog.SelectedPath;
    }

    private async Task PrimaryClickAsync()
    {
        if (running) return;
        if (complete)
        {
            if (!uninstall && launch.Checked)
            {
                try
                {
                    var executable = Path.Combine(selectedRoot, "Velmren.exe");
                    PayloadSession.EnsureNoLinks(executable);
                    var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = selectedRoot };
                    foreach (var argument in new[] { "launch", "--root", selectedRoot }) info.ArgumentList.Add(argument);
                    Process.Start(info)?.Dispose();
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
                {
                    launch.Checked = false;
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
            destination.Focus();
            return;
        }

        running = true;
        cancellation = new CancellationTokenSource();
        primary.Enabled = false;
        destination.Enabled = false;
        browse.Enabled = false;
        desktop.Enabled = false;
        cancel.Text = "Отмена";
        cancel.Enabled = true;
        progress.Visible = true;
        progress.Style = ProgressBarStyle.Marquee;
        SetStatus("Подготовка файлов…");
        var token = cancellation.Token;
        try
        {
            payload ??= await PayloadSession.ExtractAsync(token, MaintenanceRelocation.CacheRootFor(selectedRoot));
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
            complete = true;
            heading.Text = uninstall ? "Velmren удалён" : "Velmren установлен";
            introduction.Text = uninstall ? "Профиль браузера и данные агентов сохранены." : "Теперь можно открыть Velmren и начать работу.";
            SetStatus(uninstall ? "Удаление завершено." : "Установка завершена.");
            progress.Style = ProgressBarStyle.Continuous;
            progress.Value = 100;
            primary.Text = "&Готово";
            launch.Visible = !uninstall;
            cancel.Visible = false;
            CancelButton = primary;
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
            cancel.Enabled = true;
            if (closingAfterCancel) Close();
            else primary.Focus();
        }
    }

    private void SetRetry()
    {
        progress.Style = ProgressBarStyle.Continuous;
        progress.Value = 0;
        primary.Text = "&Повторить";
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
            "download-started" or "downloading" or "download-resumed" => "Загрузка файлов…",
            "downloaded" or "bundle-verifying" or "verified" => "Проверка файлов…",
            "extracting" or "bundle-extracting" => "Распаковка файлов…",
            "staged" or "activating" or "activation-started" => "Завершение установки…",
            "installed" or "activated" => "Подготовка к запуску…",
            "registering" or "registered" => "Создание ярлыков…",
            "uninstalling" => "Удаление программы…",
            "uninstalled" => "Завершение удаления…",
            _ => null
        };
        if (text is not null) SetStatus(text);
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
