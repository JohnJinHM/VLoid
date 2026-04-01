import io
import os
import tempfile
from threading import Lock

import numpy as np
import torch
import soundfile as sf

import transformers.utils

torch.set_float32_matmul_precision('high')

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
    Manages a single Qwen3-TTS model instance determined by tts.model in config.

    Supported model types:
      voice_design — generate speech from a natural-language voice description
      voice_clone  — clone a voice from reference audio samples
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

        self.model_type = cfg.get("model", "voice_design")

        if self.model_type == "voice_clone":
            model_path = cfg.get("base_model_path", "./models/tts/Qwen3-TTS-12Hz-1.7B-Base")
        else:
            model_path = cfg.get("vd_model_path", "./models/tts/Qwen3-TTS-12Hz-1.7B-VoiceDesign")

        device_cfg = cfg.get("device", "cuda")
        self.device = device_cfg if (device_cfg != "cuda" or torch.cuda.is_available()) else "cpu"

        dtype_str = cfg.get("dtype", "bfloat16")
        _dtype_map = {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}
        self._dtype = _dtype_map.get(dtype_str, torch.bfloat16)

        self.model = None
        self.loaded = False
        self._prompt_cache: dict = {}   # (ref_audio_path, ref_text) → prompt vector

        logger.info(
            f"Initializing TTS Service — model_type={self.model_type}, "
            f"device={self.device}, dtype={dtype_str}"
        )

        self._model_kwargs = {
            "device_map": "cuda:0" if self.device == "cuda" else "cpu",
        }
        if self.device == "cuda":
            self._model_kwargs["dtype"] = self._dtype
            self._model_kwargs["attn_implementation"] = "flash_attention_2"

        try:
            logger.info(f"Loading {self.model_type} model from: {model_path}")
            self.model = Qwen3TTSModel.from_pretrained(model_path, **self._model_kwargs)
            self.loaded = True
            logger.info(f"{self.model_type} model loaded successfully.")
            if self.model_type == "voice_clone":
                self._enable_streaming_opts(self.model)
        except Exception as e:
            logger.error(f"Failed to load {self.model_type} model: {e}", exc_info=True)

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def get_status(self) -> dict:
        return {
            "loaded":     self.loaded,
            "model_type": self.model_type,
            "device":     self.device,
        }

    # ------------------------------------------------------------------
    # Unified streaming inference
    # ------------------------------------------------------------------

    def stream_generate(
        self,
        text: str,
        instruct: str = "",
        language: str = "Auto",
        ref_audio_path: str = "",
        ref_text: str = "",
    ):
        """
        Generator yielding (pcm_np: np.ndarray[float32], sample_rate: int) tuples.
        Dispatches to the appropriate backend based on self.model_type.
        """
        if not self.loaded:
            raise RuntimeError("TTS model is not loaded.")

        if self.model_type == "voice_clone":
            yield from self._stream_voice_clone(text, ref_audio_path, ref_text, language)
        else:
            yield from self._stream_voice_design(text, instruct, language)

    def _stream_voice_design(self, text: str, instruct: str, language: str):
        # The VoiceDesign model does not have a frame-level streaming API.
        # generate_voice_design returns the full waveform; yield it as a single chunk
        # so the caller (and the HTTP streaming endpoint) see the same interface.
        kwargs = {
            "text": text,
            "language": language or "Auto",
        }
        if instruct and instruct.strip():
            kwargs["instruct"] = instruct.strip()

        wavs, sr = self.model.generate_voice_design(**kwargs)
        yield wavs[0].astype("float32"), sr

    def _stream_voice_clone(
        self, text: str, ref_audio_path: str, ref_text: str, language: str
    ):
        if not ref_audio_path or not os.path.isfile(ref_audio_path):
            raise RuntimeError(f"Reference audio file not found: '{ref_audio_path}'")

        cache_key = (ref_audio_path, ref_text)
        if cache_key not in self._prompt_cache:
            audio_data, sr_in = sf.read(ref_audio_path, dtype="float32")
            tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
            os.close(tmp_fd)
            sf.write(tmp_path, audio_data, sr_in, format="WAV", subtype="PCM_16")
            try:
                prompt = self.model.create_voice_clone_prompt(
                    ref_audio=tmp_path, ref_text=ref_text
                )
                self._prompt_cache[cache_key] = prompt
            finally:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

        prompt = self._prompt_cache[cache_key]
        for chunk, sr in self.model.stream_generate_voice_clone(
            text=text,
            language=language or "Auto",
            voice_clone_prompt=prompt,
            emit_every_frames=12,
            decode_window_frames=80,
            first_chunk_emit_every=5,
            first_chunk_decode_window=48,
        ):
            yield self._apply_edge_fade(chunk), sr

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _enable_streaming_opts(self, model):
        opts = {"decode_window_frames": 80, "use_compile": False}
        if self.device == "cuda":
            opts["compile_mode"] = "reduce-overhead"
        try:
            model.enable_streaming_optimizations(**opts)
            logger.info("Streaming optimizations enabled.")
        except Exception as e:
            logger.warning(f"Could not enable streaming optimizations: {e}")

    @staticmethod
    def _apply_edge_fade(chunk: np.ndarray, fade_samples: int = 120) -> np.ndarray:
        """Apply a short linear fade-in/out to prevent boundary clicks."""
        chunk = chunk.copy()
        n = min(fade_samples, len(chunk) // 4)
        if n > 0:
            ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
            chunk[:n] *= ramp
            chunk[-n:] *= ramp[::-1]
        return chunk

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
    """Called by app.py at startup to pre-load the configured TTS model."""
    logger.info("Triggering TTS service initialisation on server startup…")
    return get_tts_service()
