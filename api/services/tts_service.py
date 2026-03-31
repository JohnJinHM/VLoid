import io
import os
from threading import Lock

import torch
import soundfile as sf

import transformers.utils

# Patch 1: stub auto_docstring decorator missing in transformers 5.x
if not hasattr(transformers.utils, "auto_docstring"):
    def dummy_auto_docstring(*args, **kwargs):
        return lambda obj: obj
    transformers.utils.auto_docstring = dummy_auto_docstring

from qwen_tts import Qwen3TTSModel
from qwen_tts.core.models.configuration_qwen3_tts import Qwen3TTSTalkerConfig

# Patch 2: satisfy pad_token_id attribute check in newer transformers
if not hasattr(Qwen3TTSTalkerConfig, "pad_token_id"):
    Qwen3TTSTalkerConfig.pad_token_id = 151643

from core.config import load_config
from core.logger import get_logger

logger = get_logger("TTSService")


class TTSService:
    """
    Manages Qwen3-TTS model lifecycle and inference requests.

    The VoiceDesign model is loaded at startup.
    The Base (clone) model is loaded lazily on first voice-clone request
    to avoid consuming VRAM unnecessarily.
    """
    _instance = None
    _lock = Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(TTSService, cls).__new__(cls)
                cls._instance._initialize()
            return cls._instance

    # ------------------------------------------------------------------
    # Initialization
    # ------------------------------------------------------------------

    def _initialize(self):
        cfg = load_config().get("tts", {})

        self.vd_model_path   = cfg.get("vd_model_path",   "./models/tts/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
        self.base_model_path = cfg.get("base_model_path", "./models/tts/Qwen3-TTS-12Hz-1.7B-Base")

        device_cfg = cfg.get("device", "cuda")
        self.device = device_cfg if (device_cfg != "cuda" or torch.cuda.is_available()) else "cpu"

        dtype_str = cfg.get("dtype", "bfloat16")
        _dtype_map = {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}
        self._dtype = _dtype_map.get(dtype_str, torch.bfloat16)

        self.design_model = None
        self.clone_model  = None
        self.vd_loaded    = False
        self.clone_loaded = False
        self._clone_load_lock = Lock()

        logger.info(f"Initializing TTS Service — device={self.device}, dtype={dtype_str}")

        self._model_kwargs = {
            "device_map": "cuda:0" if self.device == "cuda" else "cpu",
        }
        if self.device == "cuda":
            self._model_kwargs["dtype"] = self._dtype
            self._model_kwargs["attn_implementation"] = "flash_attention_2"

        try:
            logger.info(f"Loading VoiceDesign model from: {self.vd_model_path}")
            self.design_model = Qwen3TTSModel.from_pretrained(
                self.vd_model_path, **self._model_kwargs
            )
            self.vd_loaded = True
            logger.info("VoiceDesign model loaded successfully.")
        except Exception as e:
            logger.error(f"Failed to load VoiceDesign model: {e}", exc_info=True)

    def _ensure_clone_loaded(self):
        """Load the Base (clone) model on first use — thread-safe."""
        if self.clone_loaded:
            return
        with self._clone_load_lock:
            if self.clone_loaded:
                return
            logger.info(f"Loading Base (clone) model from: {self.base_model_path}")
            try:
                self.clone_model = Qwen3TTSModel.from_pretrained(
                    self.base_model_path, **self._model_kwargs
                )
                self.clone_loaded = True
                logger.info("Base (clone) model loaded successfully.")
            except Exception as e:
                logger.error(f"Failed to load clone model: {e}", exc_info=True)
                raise RuntimeError(f"Could not load clone model: {e}") from e

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def get_status(self) -> dict:
        return {
            "vd_loaded":    self.vd_loaded,
            "clone_loaded": self.clone_loaded,
            "device":       self.device,
        }

    # ------------------------------------------------------------------
    # Inference
    # ------------------------------------------------------------------

    def voice_design(self, text: str, instruct: str, language: str) -> bytes:
        """Generate speech from text + natural-language voice description."""
        if not self.vd_loaded:
            raise RuntimeError("VoiceDesign model is not loaded.")

        logger.info(f"voice_design — lang={language}, chars={len(text)}")
        kwargs = {
            "text": text,
            "language": language if language else "Auto",
        }
        if instruct and instruct.strip():
            kwargs["instruct"] = instruct.strip()

        wavs, sr = self.design_model.generate_voice_design(**kwargs)
        return self._numpy_to_wav_bytes(wavs[0], sr)

    def voice_clone(self, text: str, ref_audio_path: str, ref_text: str, language: str) -> bytes:
        """
        Clone a voice from a reference audio file and synthesise text.

        ``ref_audio_path`` must be an absolute path to an audio file on disk.

        The original implementation passed a base64 string directly to the
        model, which interprets plain strings as file paths.  That caused the
        model to try opening the base64 chars as a filename, fail silently, and
        produce garbled output.  Reading the file to bytes here and passing the
        bytes object is the correct call convention.
        """
        if not self.vd_loaded:
            raise RuntimeError("TTS service failed to initialise.")

        self._ensure_clone_loaded()
        logger.info(f"voice_clone — lang={language}, chars={len(text)}, audio={ref_audio_path}")

        if not os.path.isfile(ref_audio_path):
            raise RuntimeError(f"Reference audio file not found: '{ref_audio_path}'")

        # generate_voice_clone expects a file-path string, not bytes.
        wavs, sr = self.clone_model.generate_voice_clone(
            text=text,
            language=language if language else "Auto",
            ref_audio=ref_audio_path,   # absolute path string
            ref_text=ref_text,
        )
        return self._numpy_to_wav_bytes(wavs[0], sr)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _numpy_to_wav_bytes(self, audio_np, sample_rate: int) -> bytes:
        buf = io.BytesIO()
        sf.write(buf, audio_np, sample_rate, format='WAV', subtype='PCM_16')
        buf.seek(0)
        return buf.read()


# ------------------------------------------------------------------
# Singleton accessors for FastAPI dependency injection
# ------------------------------------------------------------------

_service_instance = None


def get_tts_service() -> TTSService:
    global _service_instance
    if _service_instance is None:
        _service_instance = TTSService()
    return _service_instance


def init_tts_service():
    """Called by app.py at startup to pre-load the VoiceDesign model."""
    logger.info("Triggering TTS service initialisation on server startup…")
    return get_tts_service()
