using System.Drawing;

namespace ObsMultistreamRelay;

internal sealed class RelayForm : Form
{
    private readonly RelayWorker worker = new();
    private readonly System.Windows.Forms.Timer restartTimer = new() { Interval = 5000 };
    private readonly TextBox portBox = new();
    private readonly TextBox pathBox = new();
    private readonly TextBox ffmpegBox = new();
    private readonly CheckBox autoRestartBox = new() { Text = "異常終了時に自動再接続", AutoSize = true };
    private readonly Label status = new() { Text = "停止中", AutoSize = true, ForeColor = Color.FromArgb(29, 107, 61), Font = new Font("Segoe UI", 11, FontStyle.Bold) };
    private readonly Button startButton = new() { Text = "中継開始", AutoSize = true };
    private readonly Button stopButton = new() { Text = "中継停止", AutoSize = true, Enabled = false };
    private readonly TextBox logBox = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, BackColor = Color.FromArgb(17, 24, 39), ForeColor = Color.FromArgb(229, 231, 235), Font = new Font("Consolas", 9) };
    private readonly List<DestinationRow> rows = [];
    private RelayConfig config;
    private bool closing;

    public RelayForm()
    {
        config = RelayConfig.Load();
        Text = "OBS Multistream Relay";
        ClientSize = new Size(960, 720);
        MinimumSize = new Size(820, 620);
        Font = new Font("Segoe UI", 9);
        BuildUi();
        portBox.Text = config.Port.ToString();
        pathBox.Text = config.Path;
        ffmpegBox.Text = config.FfmpegPath;
        autoRestartBox.Checked = config.AutoRestart;
        AppendLog("準備完了。配信先を設定して「中継開始」を押してください。");

        worker.Started += (url, count) => OnUi(() =>
        {
            AppendLog($"中継プロセスを起動しました: {url} / 配信先 {count}件");
            AppendLog("OBSで配信開始すると、各配信先へ転送されます。");
        });
        worker.Log += line => OnUi(() =>
        {
            AppendLog(line);
            if (line.Contains("Input #", StringComparison.Ordinal) || line.Contains("Stream mapping:", StringComparison.Ordinal))
                status.Text = "配信中";
        });
        worker.Exited += (code, requested) => OnUi(() => HandleExit(code, requested));
        restartTimer.Tick += (_, _) =>
        {
            restartTimer.Stop();
            if (!autoRestartBox.Checked || worker.Running || status.Text is "停止中" or "停止処理中") return;
            AppendLog("自動再接続を試みます。");
            StartRelay();
        };
        autoRestartBox.CheckedChanged += (_, _) =>
        {
            if (autoRestartBox.Checked) return;
            if (restartTimer.Enabled) AppendLog("自動再接続をキャンセルしました。");
            restartTimer.Stop();
            if (!worker.Running) stopButton.Enabled = false;
        };
        startButton.Click += (_, _) => StartRelay();
        stopButton.Click += async (_, _) => await StopRelayAsync();
    }

    private void BuildUi()
    {
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(18, 16, 18, 18) };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 55));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 140));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 230));
        Controls.Add(root);

        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 70));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30));
        header.Controls.Add(new Label { Text = "OBS Multistream Relay", AutoSize = true, Font = new Font("Segoe UI", 18, FontStyle.Bold) }, 0, 0);
        var right = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft };
        right.Controls.Add(status);
        header.Controls.Add(right, 1, 0);
        root.Controls.Add(header, 0, 0);

        var inputGroup = new GroupBox { Text = "OBSからの入力", Dock = DockStyle.Fill };
        root.Controls.Add(inputGroup, 0, 1);
        var input = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(10), ColumnCount = 4, RowCount = 3 };
        input.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        input.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 48));
        input.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 85));
        input.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 52));
        input.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        input.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        input.RowStyles.Add(new RowStyle(SizeType.Absolute, 37));
        inputGroup.Controls.Add(input);
        input.Controls.Add(new Label { Text = "入力ポート", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0);
        portBox.Width = 90;
        input.Controls.Add(portBox, 1, 0);
        input.Controls.Add(new Label { Text = "入力パス", AutoSize = true, Anchor = AnchorStyles.Left }, 2, 0);
        pathBox.Width = 190;
        input.Controls.Add(pathBox, 3, 0);
        input.Controls.Add(new Label { Text = "OBS設定: カスタム / rtmp://127.0.0.1:ポート/live / キー: obs", AutoSize = true, ForeColor = Color.DimGray }, 0, 1);
        input.SetColumnSpan(input.GetControlFromPosition(0, 1)!, 4);
        input.Controls.Add(new Label { Text = "FFmpeg", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 2);
        ffmpegBox.Dock = DockStyle.Fill;
        input.Controls.Add(ffmpegBox, 1, 2);
        input.SetColumnSpan(ffmpegBox, 2);
        var browse = new Button { Text = "参照...", AutoSize = true };
        browse.Click += (_, _) =>
        {
            using var dialog = new OpenFileDialog { Title = "ffmpeg.exeを選択", Filter = "FFmpeg|ffmpeg.exe|実行ファイル|*.exe|すべてのファイル|*.*" };
            if (dialog.ShowDialog(this) == DialogResult.OK) ffmpegBox.Text = dialog.FileName;
        };
        input.Controls.Add(browse, 3, 2);

        var destinations = new GroupBox { Text = "配信先", Dock = DockStyle.Fill };
        root.Controls.Add(destinations, 0, 2);
        var destinationTable = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(10), ColumnCount = 4, AutoScroll = true };
        destinationTable.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 50));
        destinationTable.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
        destinationTable.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        destinationTable.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        destinations.Controls.Add(destinationTable);
        foreach (var (label, col) in new[] { ("有効", 0), ("配信先", 1), ("サーバーURL", 2), ("ストリームキー", 3) })
            destinationTable.Controls.Add(new Label { Text = label, AutoSize = true }, col, 0);
        var rowNumber = 1;
        foreach (var item in config.Destinations)
        {
            var row = new DestinationRow(item);
            rows.Add(row);
            destinationTable.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
            destinationTable.Controls.Add(row.Enabled, 0, rowNumber);
            destinationTable.Controls.Add(row.Name, 1, rowNumber);
            destinationTable.Controls.Add(row.Server, 2, rowNumber);
            destinationTable.Controls.Add(row.StreamKey, 3, rowNumber);
            rowNumber++;
        }

        var footer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        footer.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        footer.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        root.Controls.Add(footer, 0, 3);
        logBox.Dock = DockStyle.Fill;
        footer.Controls.Add(logBox, 0, 0);
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false };
        var closeButton = new Button { Text = "終了", AutoSize = true };
        closeButton.Click += (_, _) => Close();
        var saveButton = new Button { Text = "設定を保存", AutoSize = true };
        saveButton.Click += (_, _) => SaveConfig(false);
        actions.Controls.Add(closeButton);
        actions.Controls.Add(stopButton);
        actions.Controls.Add(startButton);
        actions.Controls.Add(saveButton);
        autoRestartBox.Margin = new Padding(0, 7, 0, 0);
        var bottom = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 40));
        bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 60));
        bottom.Controls.Add(autoRestartBox, 0, 0);
        bottom.Controls.Add(actions, 1, 0);
        footer.Controls.Add(bottom, 0, 1);
    }

    private RelayConfig CollectConfig()
    {
        if (!int.TryParse(portBox.Text.Trim(), out var port)) throw new ArgumentException("入力ポートは数字で指定してください。");
        if (port is < 1 or > 65535) throw new ArgumentException("入力ポートは1〜65535で指定してください。");
        var path = pathBox.Text.Trim().Trim('/');
        if (path.Length == 0) throw new ArgumentException("入力パスを指定してください。");
        return new RelayConfig
        {
            Port = port,
            Path = path,
            FfmpegPath = string.IsNullOrWhiteSpace(ffmpegBox.Text) ? "ffmpeg" : ffmpegBox.Text.Trim(),
            AutoRestart = autoRestartBox.Checked,
            Destinations = rows.Select(r => new Destination
            {
                Enabled = r.Enabled.Checked,
                Name = string.IsNullOrWhiteSpace(r.Name.Text) ? "配信先" : r.Name.Text.Trim(),
                Server = r.Server.Text.Trim(),
                StreamKey = r.StreamKey.Text.Trim()
            }).ToList()
        };
    }

    private bool SaveConfig(bool silent)
    {
        try
        {
            config = CollectConfig();
            config.Save();
            if (!silent) AppendLog("設定を保存しました。");
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or System.ComponentModel.Win32Exception)
        {
            if (!silent) MessageBox.Show(this, ex.Message, "設定エラー", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
    }

    private void StartRelay()
    {
        if (worker.Running) return;
        restartTimer.Stop();
        stopButton.Enabled = false;
        try
        {
            var next = CollectConfig();
            var enabled = next.Destinations.Where(d => d.Enabled).ToArray();
            if (enabled.Length == 0) throw new ArgumentException("有効な配信先を1つ以上選択してください。");
            foreach (var item in enabled) RelayConfig.TargetUrl(item);
            next.Save();
            config = next;
            worker.Start(next.FfmpegPath, next.Port, next.Path, enabled);
            status.Text = "OBS接続待機中";
            startButton.Enabled = false;
            stopButton.Enabled = true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or System.ComponentModel.Win32Exception)
        {
            MessageBox.Show(this, ex.Message, "中継を開始できません", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task StopRelayAsync()
    {
        restartTimer.Stop();
        var wasRunning = worker.Running;
        var task = worker.StopAsync();
        if (wasRunning)
        {
            status.Text = "停止処理中";
            AppendLog("停止処理を開始しました。");
            await task;
        }
        else
        {
            status.Text = "停止中";
            startButton.Enabled = true;
            stopButton.Enabled = false;
            AppendLog("中継を停止しました。");
        }
    }

    private void HandleExit(int code, bool requested)
    {
        restartTimer.Stop();
        startButton.Enabled = true;
        stopButton.Enabled = false;
        if (requested || worker.StopRequested)
        {
            status.Text = "停止中";
            AppendLog("中継を停止しました。");
        }
        else
        {
            status.Text = "接続終了";
            AppendLog($"中継プロセスが終了しました（終了コード: {code}）。");
            if (autoRestartBox.Checked)
            {
                AppendLog("5秒後に自動再接続します。");
                stopButton.Enabled = true;
                restartTimer.Start();
            }
        }
    }

    private void OnUi(Action action)
    {
        if (closing || IsDisposed) return;
        try
        {
            if (InvokeRequired) BeginInvoke((MethodInvoker)(() => { if (!closing) action(); }));
            else action();
        }
        catch (InvalidOperationException) { }
    }

    private void AppendLog(string line)
    {
        logBox.AppendText($"[{DateTime.Now:HH:mm:ss}] {line}{Environment.NewLine}");
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        closing = true;
        restartTimer.Stop();
        worker.StopAsync().GetAwaiter().GetResult();
        SaveConfig(true);
        base.OnFormClosing(e);
    }

    private sealed class DestinationRow
    {
        public CheckBox Enabled { get; } = new() { AutoSize = true };
        public TextBox Name { get; } = new() { Dock = DockStyle.Fill };
        public TextBox Server { get; } = new() { Dock = DockStyle.Fill };
        public TextBox StreamKey { get; } = new() { Dock = DockStyle.Fill, UseSystemPasswordChar = true };

        public DestinationRow(Destination destination)
        {
            Enabled.Checked = destination.Enabled;
            Name.Text = destination.Name;
            Server.Text = destination.Server;
            StreamKey.Text = destination.StreamKey;
        }
    }
}
