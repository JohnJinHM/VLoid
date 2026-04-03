import threading
import uvicorn
from core.module_base import BaseModule
from core.logger import get_logger

logger = get_logger("APIServer")


class _UvicornServer(uvicorn.Server):
    """
    Uvicorn subclass that skips signal-handler installation.

    signal.signal() / loop.add_signal_handler() can only be called from the
    main thread.  When uvicorn runs inside a daemon thread we suppress the
    installation entirely and let the main thread's shutdown sequence set
    server.should_exit = True instead.
    """
    def install_signal_handlers(self) -> None:
        pass


class ApiServerModule(BaseModule):
    def __init__(self, config):
        super().__init__("APIServer", config)
        self.host = self.config.get("api", {}).get("host", "127.0.0.1")
        self.port = self.config.get("api", {}).get("port", 3000)
        self._server: _UvicornServer | None = None
        self._thread: threading.Thread | None = None

    def start(self):
        logger.info(f"Starting FastAPI server on {self.host}:{self.port}...")
        uv_config = uvicorn.Config(
            "api.app:app", host=self.host, port=self.port, log_level="warning"
        )
        self._server = _UvicornServer(uv_config)
        # Daemon thread: exits automatically when the main process exits.
        # Running uvicorn in the same process avoids the subprocess-spawn
        # overhead that previously delayed TTS loading by 30-120 s on Windows.
        self._thread = threading.Thread(
            target=self._server.run, daemon=True, name="uvicorn"
        )
        self._thread.start()

    def stop(self):
        if self._server and not self._server.should_exit:
            logger.info("Stopping FastAPI server...")
            self._server.should_exit = True
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=10)
            logger.info("FastAPI server stopped.")
