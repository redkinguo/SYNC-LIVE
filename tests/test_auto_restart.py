import queue
import unittest
from types import MethodType, SimpleNamespace
from unittest.mock import Mock, patch

from relay_app import RelayApp, RelayWorker


class AutoRestartTests(unittest.TestCase):
    def setUp(self):
        # Exercise the real callbacks without opening a window or launching FFmpeg.
        self.app = SimpleNamespace(
            events=queue.Queue(),
            worker=SimpleNamespace(running=False, stop_requested=False, stop=Mock(), start=Mock()),
            auto_restart_var=Mock(),
            status_var=Mock(),
            start_button=Mock(),
            stop_button=Mock(),
            after=Mock(return_value="restart-timer"),
            after_cancel=Mock(),
            _restart_after_id=None,
            _append_log=Mock(),
            _save=Mock(),
            destroy=Mock(),
        )
        self.app.auto_restart_var.get.return_value = True
        self.app.status_var.get.return_value = "接続終了"
        for name in (
            "_drain_events", "_restart_if_needed", "_stop", "_on_close",
            "_cancel_restart", "_on_auto_restart_changed",
        ):
            setattr(self.app, name, MethodType(getattr(RelayApp, name), self.app))
        self.app._start = Mock()

    def exit_unexpectedly(self):
        self.app.events.put(("exited", 1, False))
        self.app._drain_events()

    def test_pending_restart_can_be_stopped(self):
        self.exit_unexpectedly()
        self.app.stop_button.configure.assert_called_with(state="normal")
        self.assertEqual(self.app._restart_after_id, "restart-timer")
        self.app._stop()
        self.app.after_cancel.assert_called_once_with("restart-timer")
        self.assertIsNone(self.app._restart_after_id)
        self.app.status_var.set.assert_called_with("停止中")
        self.app.stop_button.configure.assert_called_with(state="disabled")

    def test_restart_checks_current_checkbox_value(self):
        self.app.auto_restart_var.get.return_value = False
        self.app._restart_if_needed()
        self.app._start.assert_not_called()

    def test_active_stop_waits_for_exit_event_before_enabling_start(self):
        self.app.worker.running = True
        self.app.worker.stop.side_effect = lambda: setattr(self.app.worker, "running", False)
        self.app._stop()
        self.app.status_var.set.assert_called_with("停止処理中")
        self.app.start_button.configure.assert_not_called()

    def test_new_exit_replaces_previous_restart_timer(self):
        self.exit_unexpectedly()
        self.exit_unexpectedly()
        self.app.after_cancel.assert_called_once_with("restart-timer")
        self.assertEqual(self.app._restart_after_id, "restart-timer")

    def test_disabling_auto_restart_cancels_timer(self):
        self.exit_unexpectedly()
        self.app.auto_restart_var.get.return_value = False
        self.app._on_auto_restart_changed()
        self.app.after_cancel.assert_called_once_with("restart-timer")
        self.assertIsNone(self.app._restart_after_id)
        self.app.stop_button.configure.assert_called_with(state="disabled")

    def test_disabling_auto_restart_keeps_active_relay_stoppable(self):
        self.app.worker.running = True
        self.app.auto_restart_var.get.return_value = False
        self.app._on_auto_restart_changed()
        self.app.worker.stop.assert_not_called()
        self.app.stop_button.configure.assert_not_called()

    def test_manual_start_cancels_pending_timer(self):
        self.exit_unexpectedly()
        self.app._collect_config = Mock(return_value={
            "ffmpeg_path": "ffmpeg", "port": 1935, "path": "live/obs",
            "destinations": [{"enabled": True, "server": "rtmp://example.test/live", "stream_key": "test"}],
        })
        with patch("relay_app.save_config"), patch("relay_app.messagebox.showerror") as showerror:
            RelayApp._start(self.app)
        showerror.assert_not_called()
        self.app.after_cancel.assert_called_once_with("restart-timer")
        self.app.worker.start.assert_called_once()

    def test_close_cancels_pending_timer(self):
        self.exit_unexpectedly()
        self.app._on_close()
        self.app.after_cancel.assert_called_once_with("restart-timer")
        self.app.destroy.assert_called_once()

    def test_timer_is_cleared_before_automatic_start(self):
        self.app._restart_after_id = "restart-timer"
        self.app._restart_if_needed()
        self.assertIsNone(self.app._restart_after_id)
        self.app._start.assert_called_once()

    def test_requested_exit_does_not_schedule_restart(self):
        self.app.events.put(("exited", 1, True))
        self.app._drain_events()
        self.assertFalse(any(call.args[0] == 5000 for call in self.app.after.call_args_list))
        self.app.status_var.set.assert_called_with("停止中")

    def test_stop_before_exit_event_is_drained_prevents_restart(self):
        self.app.worker = RelayWorker(self.app.events)
        self.app.events.put(("exited", 1, False))
        self.app._stop()
        self.app._drain_events()
        self.assertFalse(any(call.args[0] == 5000 for call in self.app.after.call_args_list))
        self.app.status_var.set.assert_called_with("停止中")

    def test_disabled_auto_restart_does_not_schedule_timer(self):
        self.app.auto_restart_var.get.return_value = False
        self.exit_unexpectedly()
        self.assertFalse(any(call.args[0] == 5000 for call in self.app.after.call_args_list))
        self.app.stop_button.configure.assert_called_with(state="disabled")

    def test_timer_does_not_restart_running_or_stopped_relay(self):
        self.app.worker.running = True
        self.app._restart_if_needed()
        self.app.worker.running = False
        for status in ("停止中", "停止処理中"):
            self.app.status_var.get.return_value = status
            self.app._restart_if_needed()
        self.app._start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
