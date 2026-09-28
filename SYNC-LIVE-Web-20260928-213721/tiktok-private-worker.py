"""Local adapter for a separately installed TikTok LIVE room generator.

The upstream generator is deliberately not bundled: this adapter imports it
from the user-configured local checkout and uses its Stream API.
"""

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr


def send(packet):
    PROTOCOL_OUT.write(json.dumps(packet, ensure_ascii=False) + "\n")
    PROTOCOL_OUT.flush()


def required_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} が未設定です")
    return value


def clean_error(error, secrets):
    message = str(error)
    for secret in secrets:
        if secret:
            message = message.replace(secret, "[非表示]")
    return message[:1200]


def stop_process(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=6)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def wait_proxy_ready(process, log_path, timeout=30):
    marker = "waiting for OBS/local RTMP connection"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"TikTok SEI プロキシが終了しました (code {process.returncode})")
        try:
            if log_path.exists() and marker in log_path.read_text(encoding="utf-8", errors="replace"):
                return
        except OSError:
            pass
        time.sleep(0.2)
    raise RuntimeError("TikTok SEI プロキシの待受を確認できませんでした")


def local_ingest_url():
    value = os.environ.get("TIKTOK_PRIVATE_LOCAL_INGEST", "rtmp://127.0.0.1:19350/live/stream").strip()
    parsed = urlparse(value)
    if parsed.scheme not in ("rtmp", "rtmps") or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise RuntimeError("TIKTOK_PRIVATE_LOCAL_INGEST は localhost の RTMP URL にしてください")
    return value


def run():
    proxy = None
    proxy_log = None
    stream = None
    created = False
    room_id = ""
    stream_id = ""
    device_id = ""
    install_id = ""
    region = os.environ.get("TIKTOK_PRIVATE_REGION", "").strip()
    source_dir = Path(required_env("TIKTOK_PRIVATE_API_DIR")).expanduser().resolve()
    cookies_path = Path(required_env("TIKTOK_COOKIE_JSON")).expanduser().resolve()
    signer_key = os.environ.get("TIKTOK_SIGNER_API_KEY", "").strip()
    if not signer_key:
        try:
            config = json.loads((source_dir / "config.json").read_text(encoding="utf-8"))
            signer_key = str(config.get("rapidapi_key", "") or "").strip()
        except (OSError, ValueError, AttributeError):
            signer_key = ""
    if not (source_dir / "TiktokStreamKeyGenerator.py").is_file():
        raise RuntimeError("TIKTOK_PRIVATE_API_DIR に TiktokStreamKeyGenerator.py がありません")
    if not (source_dir / "Libs" / "ffmpeg_sei_proxy.py").is_file():
        raise RuntimeError("指定したTikTok APIフォルダーに Libs/ffmpeg_sei_proxy.py がありません")
    if not cookies_path.is_file():
        raise RuntimeError("TIKTOK_COOKIE_JSON のCookie JSONファイルが見つかりません")
    if not signer_key:
        raise RuntimeError("TIKTOK_SIGNER_API_KEY が未設定です")

    title_request = json.loads(sys.stdin.readline() or "{}")
    title = str(title_request.get("title", "")).strip()
    if not title:
        raise RuntimeError("共通配信タイトルを入力してください")
    title = title[:100]
    ingest_url = local_ingest_url()
    category_id = os.environ.get("TIKTOK_PRIVATE_CATEGORY_ID", "42").strip() or "42"
    ffmpeg_path = os.environ.get("FFMPEG_PATH", "ffmpeg").strip() or "ffmpeg"
    if not (Path(ffmpeg_path).is_file() or shutil.which(ffmpeg_path)):
        raise RuntimeError("FFmpeg が見つかりません。FFMPEG_PATH を設定してください")

    sys.path.insert(0, str(source_dir))
    os.environ["RAPIDAPI_KEY"] = signer_key

    try:
        import TiktokStreamKeyGenerator as generator

        device_id, install_id = generator.register_desktop_device_identifiers()
        if not device_id or not install_id:
            raise RuntimeError("TikTok device/install ID を初期化できませんでした")

        stream = generator.Stream(cookies_path=str(cookies_path))
        existing = stream.getContinuableStreamInfo(
            device_id=device_id,
            install_id=install_id,
            priority_region=region,
        )
        if existing.get("has_room"):
            raise RuntimeError("すでに利用可能なTikTok LIVE枠があります。既存配信を終了してから再実行してください")

        info = stream.getCreateRoomInfo(
            device_id=device_id,
            install_id=install_id,
            priority_region=region,
            last_time_hashtag_id=category_id,
        )
        info_data = info.get("data", {}) if isinstance(info, dict) else {}
        if str(info_data.get("live_status")) == "2":
            raise RuntimeError("TikTokアカウントはすでに配信中です。現在の配信を終了してから再実行してください")

        stream.createStream(
            title=title,
            hashtag_id=category_id,
            game_tag_id="0",
            gen_replay=True,
            close_room_when_close_stream=True,
            priority_region=region,
            device_id=device_id,
            install_id=install_id,
        )
        created = True
        room_id = str(stream.roomId or "")
        stream_id = str(stream.streamId or "")
        if not room_id or not stream_id or not stream.streamUrl or not stream.ownerUserId:
            raise RuntimeError("TikTokから配信先情報が返りませんでした")

        stream.prepareStream(
            device_id=device_id,
            install_id=install_id,
            priority_region=region,
            room_id=room_id,
            stream_id=stream_id,
        )

        runtime_dir = Path(os.environ.get("TIKTOK_PRIVATE_RUNTIME_DIR", ".runtime")).resolve()
        runtime_dir.mkdir(parents=True, exist_ok=True)
        proxy_log_path = runtime_dir / "tiktok-sei-proxy.log"
        try:
            proxy_log_path.unlink()
        except FileNotFoundError:
            pass
        proxy_log = proxy_log_path.open("a", encoding="utf-8", errors="replace")
        proxy_script = source_dir / "Libs" / "ffmpeg_sei_proxy.py"
        proxy_args = [
            sys.executable,
            str(proxy_script),
            "--ffmpeg", ffmpeg_path,
            "--listen-url", ingest_url,
            "--output-url", stream.streamUrl,
            "--uid", str(stream.ownerUserId),
            "--device-id", str(device_id),
            "--room-id", room_id,
            "--aid", "8311",
            "--fps", os.environ.get("TIKTOK_PRIVATE_FPS", "60"),
            "--resolution", os.environ.get("TIKTOK_PRIVATE_RESOLUTION", "1920x1080"),
            "--timeout", "30",
            "--log", str(proxy_log_path),
        ]
        proxy_env = os.environ.copy()
        proxy_env["RAPIDAPI_KEY"] = signer_key
        proxy_env["PYTHONPATH"] = str(source_dir) + os.pathsep + proxy_env.get("PYTHONPATH", "")
        proxy = subprocess.Popen(
            proxy_args,
            cwd=str(source_dir),
            stdin=subprocess.DEVNULL,
            stdout=proxy_log,
            stderr=subprocess.STDOUT,
            env=proxy_env,
            creationflags=(getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0),
        )
        wait_proxy_ready(proxy, proxy_log_path)
        send({"type": "ready", "ingestUrl": ingest_url, "detail": "TikTok LIVE枠を作成し、署名プロキシを起動しました"})

        controls = queue.Queue()

        def read_controls():
            for line in sys.stdin:
                try:
                    controls.put(json.loads(line))
                except Exception:
                    controls.put({"action": "invalid"})

        threading.Thread(target=read_controls, daemon=True).start()
        heartbeat_status = generator.ANCHOR_STATUS_PREPARE
        last_heartbeat = 0.0
        while True:
            try:
                command = controls.get(timeout=0.25)
            except queue.Empty:
                command = None
            if command and command.get("action") == "stop":
                break
            if proxy.poll() is not None:
                raise RuntimeError(f"TikTok SEI プロキシが終了しました (code {proxy.returncode})")
            if time.monotonic() - last_heartbeat >= 5:
                try:
                    result = stream.anchorHeartbeat(
                        heartbeat_status,
                        device_id=device_id,
                        install_id=install_id,
                        priority_region=region,
                        room_id=room_id,
                        stream_id=stream_id,
                        action="SYNC LIVE heartbeat",
                    )
                    if heartbeat_status == generator.ANCHOR_STATUS_PREPARE and generator._is_room_is_living_payload(result):
                        heartbeat_status = generator.ANCHOR_STATUS_LIVING
                        send({"type": "status", "detail": "TikTok LIVE配信中"})
                except Exception as error:
                    send({"type": "warning", "detail": clean_error(error, [signer_key, stream.streamUrl])})
                last_heartbeat = time.monotonic()

        stop_process(proxy)
        proxy = None
        stream.endStream(
            device_id=device_id,
            install_id=install_id,
            priority_region=region,
            room_id=room_id,
            stream_id=stream_id,
        )
        created = False
        send({"type": "stopped", "detail": "TikTok LIVEを終了しました"})
    except Exception as error:
        message = clean_error(error, [signer_key, getattr(stream, "streamUrl", "")])
        send({"type": "error", "error": message})
        if proxy is not None:
            stop_process(proxy)
        if created and stream is not None:
            try:
                stream.endStream(
                    device_id=device_id,
                    install_id=install_id,
                    priority_region=region,
                    room_id=room_id,
                    stream_id=stream_id,
                )
            except Exception:
                pass
        return 1
    finally:
        if proxy_log is not None:
            proxy_log.close()
        if stream is not None:
            try:
                stream.s.close()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except Exception as error:
        send({"type": "error", "error": clean_error(error, [os.environ.get("TIKTOK_SIGNER_API_KEY", "")])})
        raise SystemExit(1)
