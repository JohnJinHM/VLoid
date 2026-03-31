import os
import subprocess
import threading

from core.module_base import BaseModule

# Project root is one level above this file's directory (modules/)
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ElectronModule(BaseModule):
    """
    Manages the Electron frontend process lifecycle.

    start() launches `electron .` from the project root.  The window is
    created hidden in src/index.js and only shown once the renderer receives
    confirmation that the backend is fully ready (IPC 'backend-ready').

    stop() terminates the process and waits for it to exit.
    """

    def __init__(self, config):
        super().__init__("Electron", config)

    def start(self):
        # Resolve the electron binary shipped with the npm package.
        # On Windows the shim is electron.cmd; on POSIX it is just electron.
        bin_name = "electron.cmd" if os.name == "nt" else "electron"
        electron_bin = os.path.join(_PROJECT_ROOT, "node_modules", ".bin", bin_name)

        self.logger.info(f"Starting Electron frontend from {_PROJECT_ROOT}…")
        self.process = subprocess.Popen(
            [electron_bin, "."],
            cwd=_PROJECT_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )
        threading.Thread(target=self._log_stream, daemon=True).start()
        self.logger.info(f"Electron process started (PID {self.process.pid})")

    def stop(self):
        if self.process and self.process.poll() is None:
            self.logger.info("Stopping Electron…")
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.logger.warning("Electron did not exit cleanly — killing process.")
                self.process.kill()
            self.logger.info("Electron stopped.")
