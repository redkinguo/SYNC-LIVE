from __future__ import annotations

import base64
import ctypes
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import tkinter as tk
from ctypes import POINTER, Structure, byref, c_bool, c_char, c_uint32, c_void_p, c_wchar_p, cast
from pathlib import Path
from tkinter import filedialog, messagebox, ttk


APP_DIR = Path(__file__).resolve().parent
CONFIG_PATH = APP_DIR / "config.json"
DEFAULT_PORT = 1935
DEFAULT_PATH = "live/obs"

DEFAULT_DESTINATIONS = [
    {
        "name": "YouTube",
        "enabled": True,
        "server": "rtmps://a.rtmps.youtube.com/live2",
        "stream_key": "",
    },
    {
        "name": "Kick",
        "enabled": True,
        "server": "",
        "stream_key": "",
    },
    {
        "name": "TikTok",
        "enabled": False,
        "server": "",
        "stream_key": "",
    },
]


class DATA_BLOB(Structure):
    _fields_ = [("cbData", c_uint32), ("pbData", POINTER(c_char))]


def _dpapi_protect(value: str) -> str:
    """Encrypt a stream key for the current Windows user."""
    if not value:
        return ""
    if os.name != "nt":
        return value

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    crypt32.CryptProtectData.argtypes = [
        POINTER(DATA_BLOB),
        c_wchar_p,
        POINTER(DATA_BLOB),
        c_void_p,
        c_void_p,
        c_uint32,
        POINTER(DATA_BLOB),
    ]
    crypt32.CryptProtectData.restype = c_bool
    kernel32.LocalFree.argtypes = [c_void_p]
    kernel32.LocalFree.restype = c_void_p

    raw = value.encode("utf-8")
    raw_buffer = ctypes.create_string_buffer(raw)
    source = DATA_BLOB(len(raw), cast(raw_buffer, POINTER(c_char)))
    encrypted = DATA_BLOB()
    if not crypt32.CryptProtectData(byref(source), "OBS Multistream Relay", None, None, None, 0, byref(encrypted)):
        raise ctypes.WinError()
    try:
        encrypted_bytes = ctypes.string_at(encrypted.pbData, encrypted.cbData)
        return "dpapi:" + base64.b64encode(encrypted_bytes).decode("ascii")
    finally:
        kernel32.LocalFree(encrypted.pbData)


def _dpapi_unprotect(value: str) -> str:
    if not value:
        return ""
    if not value.startswith("dpapi:") or os.name != "nt":
        return value

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    crypt32.CryptUnprotectData.argtypes = [
        POINTER(DATA_BLOB),
        POINTER(c_wchar_p),
        POINTER(DATA_BLOB),
        c_void_p,
        c_void_p,
        c_uint32,
        POINTER(DATA_BLOB),
    ]
    crypt32.CryptUnprotectData.restype = c_bool
    kernel32.LocalFree.argtypes = [c_void_p]
    kernel32.LocalFree.restype = c_void_p

    encrypted_bytes = base64.b64decode(value[6:])
    encrypted_buffer = ctypes.create_string_buffer(encrypted_bytes)
    source = DATA_BLOB(len(encrypted_bytes), cast(encrypted_buffer, POINTER(c_char)))
    decrypted = DATA_BLOB()
    description = c_wchar_p()
    if not crypt32.CryptUnprotectData(byref(source), byref(description), None, None, None, 0, byref(decrypted)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(decrypted.pbData, decrypted.cbData).decode("utf-8")
    finally:
        kernel32.LocalFree(decrypted.pbData)
        if description:
            kernel32.LocalFree(description)


def load_config() -> dict:
    config = {
        "port": DEFAULT_PORT,
        "path": DEFAULT_PATH,
        "ffmpeg_path": "ffmpeg",
        "auto_restart": True,
        "destinations": [dict(item) for item in DEFAULT_DESTINATIONS],
    }
    if not CONFIG_PATH.exists():
        return config

    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return config

    config["port"] = raw.get("port", DEFAULT_PORT)
    config["path"] = raw.get("path", DEFAULT_PATH)
    config["ffmpeg_path"] = raw.get("ffmpeg_path", "ffmpeg")
    config["auto_restart"] = raw.get("auto_restart", True)
    loaded_destinations = raw.get("destinations", [])
    if isinstance(loaded_destinations, list) and loaded_destinations:
        config["destinations"] = []
        for item in loaded_destinations:
            if not isinstance(item, dict):
                continue
            destination = {
                "name": str(item.get("name", "配信先")),
                "enabled": bool(item.get("enabled", False)),
                "server": str(item.get("server", "")),
                "stream_key": "",
            }
            encrypted_key = item.get("stream_key_protected", item.get("stream_key", ""))
            try:
                destination["stream_key"] = _dpapi_unprotect(str(encrypted_key))
            except (OSError, ValueError):
                destination["stream_key"] = ""
            config["destinations"].append(destination)
    return config


def save_config(config: dict) -> None:
    payload = {
        "port": int(config.get("port", DEFAULT_PORT)),
        "path": str(config.get("path", DEFAULT_PATH)),
        "ffmpeg_path": str(config.get("ffmpeg_path", "ffmpeg")),
        "auto_restart": bool(config.get("auto_restart", True)),
        "destinations": [],
    }
    for item in config.get("destinations", []):
        payload["destinations"].append(
            {
                "name": str(item.get("name", "配信先")),
                "enabled": bool(item.get("enabled", False)),
                "server": str(item.get("server", "")),
                "stream_key_protected": _dpapi_protect(str(item.get("stream_key", ""))),
            }
        )
    CONFIG_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def build_target_url(server: str, stream_key: str) -> str:
    server = server.strip()
    stream_key = stream_key.strip().lstrip("/")
    if not server or not stream_key:
        raise ValueError("サーバーURLとストリームキーを入力してください。")
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", server):
        raise ValueError("サーバーURLはrtmp://またはrtmps://から始めてください。")
    return server.rstrip("/") + "/" + stream_key


def mask_secrets(text: str, secrets: list[str]) -> str:
    masked = text
    for secret in secrets:
        if secret:
            masked = masked.replace(secret, "********")
    return masked


class RelayWorker:
    def __init__(self, events: queue.Queue):
        self.events = events
        self.process: subprocess.Popen[str] | None = None
        self.thread: threading.Thread | None = None
        self.stop_requested = False
        self.secrets: list[str] = []

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def start(self, ffmpeg_path: str, port: int, path: str, destinations: list[dict]) -> None:
        if self.running:
            return
        executable = ffmpeg_path.strip() or "ffmpeg"
        if not Path(executable).exists() and shutil.which(executable) is None:
            raise FileNotFoundError("FFmpegが見つかりません。ffmpeg.exeの場所を指定してください。")

        targets: list[str] = []
        self.secrets = []
        for destination in destinations:
            target_url = build_target_url(destination["server"], destination["stream_key"])
            targets.append(target_url)
            self.secrets.append(destination["stream_key"])
        if not targets:
            raise ValueError("有効な配信先を1つ以上設定してください。")

        input_url = f"rtmp://127.0.0.1:{port}/{path.strip('/') or DEFAULT_PATH}"
        command = [
            executable,
            "-hide_banner",
            "-loglevel",
            "info",
            "-listen",
            "1",
            "-i",
            input_url,
        ]
        for target in targets:
            command.extend(
                [
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a:0?",
                    "-c",
                    "copy",
                    "-f",
                    "flv",
                    "-flvflags",
                    "no_duration_filesize",
                    target,
                ]
            )

        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.stop_requested = False
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creation_flags,
        )
        self.events.put(("started", input_url, len(targets)))
        self.thread = threading.Thread(target=self._read_output, daemon=True)
        self.thread.start()

    def _read_output(self) -> None:
        process = self.process
        if process is None or process.stderr is None:
            return
        try:
            for line in process.stderr:
                line = mask_secrets(line.rstrip(), self.secrets)
                if line:
                    self.events.put(("log", line))
        finally:
            return_code = process.wait()
            was_requested = self.stop_requested
            self.process = None
            self.events.put(("exited", return_code, was_requested))

    def stop(self) -> None:
        process = self.process
        if process is None:
            return
        self.stop_requested = True
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                process.kill()


class RelayApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("OBS Multistream Relay")
        self.geometry("960x720")
        self.minsize(820, 620)
        self.config_data = load_config()
        self.events: queue.Queue = queue.Queue()
        self.worker = RelayWorker(self.events)
        self.destination_rows: list[dict[str, tk.Variable]] = []
        self.auto_restart_var = tk.BooleanVar(value=bool(self.config_data.get("auto_restart", True)))
        self.status_var = tk.StringVar(value="停止中")
        self._build_ui()
        self.after(100, self._drain_events)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _build_ui(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(2, weight=1)

        header = ttk.Frame(self, padding=(18, 16, 18, 8))
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(1, weight=1)
        ttk.Label(header, text="OBS Multistream Relay", font=("Segoe UI", 18, "bold")).grid(row=0, column=0, sticky="w")
        ttk.Label(header, textvariable=self.status_var, foreground="#1d6b3d", font=("Segoe UI", 11, "bold")).grid(row=0, column=1, sticky="e")

        settings = ttk.LabelFrame(self, text="OBSからの入力", padding=12)
        settings.grid(row=1, column=0, padx=18, pady=(0, 10), sticky="ew")
        settings.columnconfigure(1, weight=1)
        settings.columnconfigure(3, weight=1)
        self.port_var = tk.StringVar(value=str(self.config_data.get("port", DEFAULT_PORT)))
        self.path_var = tk.StringVar(value=str(self.config_data.get("path", DEFAULT_PATH)))
        self.ffmpeg_var = tk.StringVar(value=str(self.config_data.get("ffmpeg_path", "ffmpeg")))
        ttk.Label(settings, text="入力ポート").grid(row=0, column=0, sticky="w", padx=(0, 6), pady=4)
        ttk.Entry(settings, textvariable=self.port_var, width=10).grid(row=0, column=1, sticky="w", pady=4)
        ttk.Label(settings, text="入力パス").grid(row=0, column=2, sticky="w", padx=(20, 6), pady=4)
        ttk.Entry(settings, textvariable=self.path_var, width=24).grid(row=0, column=3, sticky="w", pady=4)
        ttk.Label(settings, text="OBS設定: カスタム / rtmp://127.0.0.1:ポート/live / キー: obs", foreground="#555").grid(row=1, column=0, columnspan=4, sticky="w", pady=(4, 0))
        ttk.Label(settings, text="FFmpeg").grid(row=2, column=0, sticky="w", padx=(0, 6), pady=(10, 4))
        ttk.Entry(settings, textvariable=self.ffmpeg_var).grid(row=2, column=1, columnspan=2, sticky="ew", pady=(10, 4))
        ttk.Button(settings, text="参照...", command=self._choose_ffmpeg).grid(row=2, column=3, sticky="w", padx=(6, 0), pady=(10, 4))

        destinations = ttk.LabelFrame(self, text="配信先", padding=12)
        destinations.grid(row=2, column=0, padx=18, pady=(0, 10), sticky="nsew")
        destinations.columnconfigure(1, weight=1)
        destinations.columnconfigure(2, weight=1)
        destinations.rowconfigure(1, weight=1)

        ttk.Label(destinations, text="有効").grid(row=0, column=0, sticky="w")
        ttk.Label(destinations, text="配信先").grid(row=0, column=1, sticky="w", padx=8)
        ttk.Label(destinations, text="サーバーURL").grid(row=0, column=2, sticky="w", padx=8)
        ttk.Label(destinations, text="ストリームキー").grid(row=0, column=3, sticky="w", padx=8)
        destinations.columnconfigure(3, weight=1)

        loaded = self.config_data.get("destinations", DEFAULT_DESTINATIONS)
        for index, item in enumerate(loaded):
            self._add_destination_row(destinations, index + 1, item)

        footer = ttk.Frame(self, padding=(18, 0, 18, 18))
        footer.grid(row=3, column=0, sticky="ew")
        footer.columnconfigure(0, weight=1)
        self.log_text = tk.Text(footer, height=9, state="disabled", wrap="none", background="#111827", foreground="#e5e7eb")
        self.log_text.grid(row=0, column=0, columnspan=5, sticky="ew", pady=(0, 10))
        ttk.Checkbutton(footer, text="異常終了時に自動再接続", variable=self.auto_restart_var).grid(row=1, column=0, sticky="w")
        ttk.Button(footer, text="設定を保存", command=self._save).grid(row=1, column=1, padx=4)
        self.start_button = ttk.Button(footer, text="中継開始", command=self._start)
        self.start_button.grid(row=1, column=2, padx=4)
        self.stop_button = ttk.Button(footer, text="中継停止", command=self._stop, state="disabled")
        self.stop_button.grid(row=1, column=3, padx=4)
        ttk.Button(footer, text="終了", command=self._on_close).grid(row=1, column=4, padx=(4, 0))

        self._append_log("準備完了。配信先を設定して「中継開始」を押してください。")

    def _add_destination_row(self, parent: ttk.Widget, row_number: int, item: dict) -> None:
        enabled = tk.BooleanVar(value=bool(item.get("enabled", False)))
        name = tk.StringVar(value=str(item.get("name", "配信先")))
        server = tk.StringVar(value=str(item.get("server", "")))
        stream_key = tk.StringVar(value=str(item.get("stream_key", "")))
        ttk.Checkbutton(parent, variable=enabled).grid(row=row_number, column=0, sticky="w", pady=7)
        ttk.Entry(parent, textvariable=name, width=14).grid(row=row_number, column=1, sticky="ew", padx=8, pady=7)
        ttk.Entry(parent, textvariable=server).grid(row=row_number, column=2, sticky="ew", padx=8, pady=7)
        ttk.Entry(parent, textvariable=stream_key, show="•").grid(row=row_number, column=3, sticky="ew", padx=8, pady=7)
        self.destination_rows.append({"enabled": enabled, "name": name, "server": server, "stream_key": stream_key})

    def _choose_ffmpeg(self) -> None:
        selected = filedialog.askopenfilename(
            title="ffmpeg.exeを選択",
            filetypes=[("FFmpeg", "ffmpeg.exe"), ("実行ファイル", "*.exe"), ("すべてのファイル", "*.*")],
        )
        if selected:
            self.ffmpeg_var.set(selected)

    def _collect_config(self) -> dict:
        try:
            port = int(self.port_var.get().strip())
        except ValueError as exc:
            raise ValueError("入力ポートは数字で指定してください。") from exc
        if not 1 <= port <= 65535:
            raise ValueError("入力ポートは1〜65535で指定してください。")
        path = self.path_var.get().strip().strip("/")
        if not path:
            raise ValueError("入力パスを指定してください。")
        return {
            "port": port,
            "path": path,
            "ffmpeg_path": self.ffmpeg_var.get().strip() or "ffmpeg",
            "auto_restart": self.auto_restart_var.get(),
            "destinations": [
                {
                    "enabled": row["enabled"].get(),
                    "name": row["name"].get().strip() or "配信先",
                    "server": row["server"].get().strip(),
                    "stream_key": row["stream_key"].get().strip(),
                }
                for row in self.destination_rows
            ],
        }

    def _save(self, silent: bool = False) -> bool:
        try:
            config = self._collect_config()
            save_config(config)
            self.config_data = config
            if not silent:
                self._append_log("設定を保存しました。")
            return True
        except (OSError, ValueError) as exc:
            if not silent:
                messagebox.showerror("設定エラー", str(exc))
            return False

    def _start(self) -> None:
        if self.worker.running:
            return
        try:
            config = self._collect_config()
            destinations = [item for item in config["destinations"] if item["enabled"]]
            if not destinations:
                raise ValueError("有効な配信先を1つ以上選択してください。")
            for item in destinations:
                build_target_url(item["server"], item["stream_key"])
            save_config(config)
            self.config_data = config
            self.worker.start(config["ffmpeg_path"], config["port"], config["path"], destinations)
            self.status_var.set("OBS接続待機中")
            self.start_button.configure(state="disabled")
            self.stop_button.configure(state="normal")
        except (FileNotFoundError, OSError, ValueError) as exc:
            messagebox.showerror("中継を開始できません", str(exc))

    def _stop(self) -> None:
        self.worker.stop()
        self.status_var.set("停止処理中")
        self._append_log("停止処理を開始しました。")

    def _append_log(self, line: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", time.strftime("[%H:%M:%S] ") + line + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _drain_events(self) -> None:
        try:
            while True:
                event = self.events.get_nowait()
                event_type = event[0]
                if event_type == "started":
                    self._append_log(f"中継プロセスを起動しました: {event[1]} / 配信先 {event[2]}件")
                    self._append_log("OBSで配信開始すると、各配信先へ転送されます。")
                elif event_type == "log":
                    line = event[1]
                    self._append_log(line)
                    if "Input #" in line or "Stream mapping:" in line:
                        self.status_var.set("配信中")
                elif event_type == "exited":
                    return_code, was_requested = event[1], event[2]
                    self.start_button.configure(state="normal")
                    self.stop_button.configure(state="disabled")
                    if was_requested:
                        self.status_var.set("停止中")
                        self._append_log("中継を停止しました。")
                    else:
                        self.status_var.set("接続終了")
                        self._append_log(f"中継プロセスが終了しました（終了コード: {return_code}）。")
                        if self.auto_restart_var.get():
                            self._append_log("5秒後に自動再接続します。")
                            self.after(5000, self._restart_if_needed)
        except queue.Empty:
            pass
        self.after(100, self._drain_events)

    def _restart_if_needed(self) -> None:
        if self.worker.running or self.status_var.get() in ("停止中", "停止処理中"):
            return
        self._append_log("自動再接続を試みます。")
        self._start()

    def _on_close(self) -> None:
        if self.worker.running:
            self.worker.stop()
        self._save(silent=True)
        self.destroy()


if __name__ == "__main__":
    RelayApp().mainloop()
