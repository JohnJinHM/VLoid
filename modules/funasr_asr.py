import os
from core.module_base import BaseModule


class FunASRModule(BaseModule):
    """
    Pre-flight validator for the FunASR configuration.

    The actual model loading (VAD + ASR) happens lazily inside the FastAPI
    lifespan (api/services/asr_service.py).  This module exists only to
    validate config paths and provide a consistent lifecycle interface
    alongside the LLM engine and TTS modules.
    """

    def __init__(self, config):
        super().__init__("FunASR", config)

    def start(self):
        cfg = self.config.get("asr", {})
        model_path     = cfg.get("model_path",     "./models/asr/Fun-ASR-Nano-2512")
        vad_model_path = cfg.get("vad_model_path", "fsmn-vad")

        self.logger.info(f"ASR model path : {model_path}")
        self.logger.info(f"VAD model      : {vad_model_path}")

        if os.path.isdir(model_path):
            self.logger.info("ASR model directory found.")
        else:
            self.logger.warning(
                f"ASR model directory not found locally: '{model_path}'. "
                "Ensure the model is present before starting."
            )

        if not os.path.isdir(vad_model_path):
            self.logger.info(
                f"VAD model '{vad_model_path}' is not a local directory — "
                "will be downloaded from ModelScope on first run."
            )

    def stop(self):
        # ASR/VAD model lifecycle is managed by the FastAPI lifespan.
        pass
