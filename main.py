import json
import sys
import time
import urllib.request

from core.config import load_config
from core.logger import get_logger
from modules.vllm import VLLMModule
from modules.open_webui import WebUIModule
from modules.llama_cpp import LlamaCppModule
from modules.api_server import ApiServerModule
from modules.electron import ElectronModule


def _wait_for_ready(host: str, port: int, logger, timeout: int = 600) -> bool:
    """
    Poll GET /api/tts/status until the server responds with vd_loaded=True,
    or until *timeout* seconds have elapsed.

    Because app.py blocks the lifespan until TTS finishes loading, a single
    successful response guarantees the model is ready — no need to check the
    payload content separately.
    """
    url = f"http://{host}:{port}/api/tts/status"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as resp:
                data = json.loads(resp.read())
                if data.get("vd_loaded"):
                    return True
        except Exception as exc:
            continue
        time.sleep(3)
    logger.warning("Timed out waiting for TTS status endpoint.")
    return False


def main():
    logger = get_logger("System")
    logger.info("Loading configuration...")
    config = load_config()

    active_modules = []

    try:
        engine_type = config.get("inference_engine", "llama_cpp")

        if engine_type == "vllm":
            engine = VLLMModule(config)
        elif engine_type == "llama_cpp":
            engine = LlamaCppModule(config)
        else:
            logger.error(f"Unknown engine type: {engine_type}")
            return

        engine.start()
        active_modules.append(engine)

        if config.get("open-webui", {}).get("enabled", False):
            webui = WebUIModule(config)
            webui.start()
            active_modules.append(webui)
        else:
            api_server = ApiServerModule(config)
            api_server.start()
            active_modules.append(api_server)

        host = config.get("api", {}).get("host", "127.0.0.1")
        port = config.get("api", {}).get("port", 3000)

        ready = _wait_for_ready(host, port, logger)

        # Start Electron only after the backend is confirmed ready so the
        # frontend never races against a cold API.
        electron = ElectronModule(config)
        electron.start()
        active_modules.append(electron)

        if ready:
            logger.info("=" * 40)
            logger.info("All systems ready. Type 'exit' to terminate.")
            logger.info("=" * 40)
        else:
            logger.warning("TTS models did not finish loading within timeout.")
            logger.info("=" * 40)
            logger.info("System running. Type 'exit' to terminate.")
            logger.info("=" * 40)

        while True:
            if input().strip().lower() == "exit":
                break

    except KeyboardInterrupt:
        logger.warning("Keyboard interrupt received.")

    finally:
        logger.info("Initiating graceful shutdown...")
        for module in reversed(active_modules):
            module.stop()
        sys.exit(0)


if __name__ == "__main__":
    main()
