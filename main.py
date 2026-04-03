import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from core.config import load_config
from core.logger import get_logger
from modules.vllm import VLLMModule
from modules.open_webui import WebUIModule
from modules.llama_cpp import LlamaCppModule
from modules.api_server import ApiServerModule
from modules.electron import ElectronModule
from modules.qwen_tts import QwenTTSModule
from modules.funasr_asr import FunASRModule


def _wait_for_ready(host: str, port: int, logger, timeout: int = 600) -> bool:
    """
    Poll GET /api/tts/status until the server responds with loaded=True,
    or until *timeout* seconds have elapsed.
    """
    url = f"http://{host}:{port}/api/tts/status"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as resp:
                data = json.loads(resp.read())
                if data.get("loaded"):
                    return True
        except Exception:
            pass
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

        # Add engine to active_modules before start() so the finally block
        # can always clean it up (BaseModule.stop() guards against None process).
        active_modules.append(engine)

        tts_module = QwenTTSModule(config)
        tts_module.start()
        active_modules.append(tts_module)

        asr_module = FunASRModule(config)
        asr_module.start()
        active_modules.append(asr_module)

        if config.get("open-webui", {}).get("enabled", False):
            webui = WebUIModule(config)
            webui.start()
            active_modules.append(webui)
        else:
            # Start the API server first — this kicks off TTS model loading
            # inside the FastAPI subprocess so it runs in parallel with the LLM.
            api_server = ApiServerModule(config)
            api_server.start()
            active_modules.append(api_server)

        host = config.get("api", {}).get("host", "127.0.0.1")
        port = config.get("api", {}).get("port", 3000)

        # Load the LLM engine and wait for the TTS model concurrently.
        # engine.start() blocks in a health-check loop until the LLM subprocess
        # is ready; _wait_for_ready polls the API server until TTS is loaded.
        # Running both in a thread pool cuts startup time to max(t_llm, t_tts)
        # instead of t_llm + t_tts.
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="startup") as pool:
            engine_future = pool.submit(engine.start)
            tts_future    = pool.submit(_wait_for_ready, host, port, logger)
            engine_future.result()       # re-raises any unhandled exception
            ready = tts_future.result()

        electron = ElectronModule(config)
        electron.start()
        active_modules.append(electron)

        if ready:
            logger.info("=" * 40)
            logger.info("All systems ready. Type 'exit' to terminate.")
            logger.info("=" * 40)
        else:
            logger.warning("TTS model did not finish loading within timeout.")
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
