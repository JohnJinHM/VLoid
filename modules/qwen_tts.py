import os
from core.module_base import BaseModule


class QwenTTSModule(BaseModule):
    """
    Pre-flight validator for the Qwen3-TTS model configuration.

    The actual model is loaded lazily inside the FastAPI lifespan (api/services/tts_service.py).
    This module exists to validate config and provide a consistent lifecycle interface
    alongside the LLM engine module.
    """

    def __init__(self, config):
        super().__init__("QwenTTS", config)

    def start(self):
        cfg = self.config.get("tts", {})
        model_type = cfg.get("model", "voice_design")

        if model_type == "voice_clone":
            model_path = cfg.get("base_model_path", "./models/tts/Qwen3-TTS-12Hz-1.7B-Base")
        else:
            model_path = cfg.get("vd_model_path", "./models/tts/Qwen3-TTS-12Hz-1.7B-VoiceDesign")

        self.logger.info(f"TTS model type: {model_type}")
        self.logger.info(f"TTS model path: {model_path}")

        if not os.path.isdir(model_path):
            self.logger.warning(
                f"TTS model directory not found locally: '{model_path}'. "
                "Will attempt to download from HuggingFace on first use."
            )
        else:
            self.logger.info("TTS model directory found.")

    def stop(self):
        # TTS model lifecycle is managed by the FastAPI lifespan — nothing to do here.
        pass
