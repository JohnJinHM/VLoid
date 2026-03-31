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
        self._prompt_cache: dict = {}   # (ref_audio_path, ref_text) → prompt vector

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
            self._enable_streaming_opts(self.design_model)
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
                self._enable_streaming_opts(self.clone_model)
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

        # Read the audio ourselves with soundfile, then write it to a temp file
        # with a guaranteed simple ASCII path before passing it to the model.
        # This sidesteps failures that occur when generate_voice_clone's internal
        # file reader (ffmpeg / librosa) receives paths with non-ASCII characters,
        # Windows backslashes, or spaces.
        audio_data, sr_in = sf.read(ref_audio_path, dtype="float32")

        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
        try:
            os.close(tmp_fd)
            sf.write(tmp_path, audio_data, sr_in, format="WAV", subtype="PCM_16")
            wavs, sr = self.clone_model.generate_voice_clone(
                text=text,
                language=language if language else "Auto",
                ref_audio=tmp_path,
                ref_text=ref_text,
            )
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        return self._numpy_to_wav_bytes(wavs[0], sr)

    # ------------------------------------------------------------------
    # Native streaming inference
    # ------------------------------------------------------------------

    def stream_voice_design_sentence(self, text: str, instruct: str, language: str):
        """
        Generator yielding (pcm_np: np.ndarray[float32], sample_rate: int) tuples
        directly from the model's frame-level streaming decoder.
        Each chunk has a short fade-in/out applied to prevent boundary clicks.
        """
        if not self.vd_loaded:
            raise RuntimeError("VoiceDesign model is not loaded.")

        kwargs = {
            "text": text,
            "language": language or "Auto",
            "emit_every_frames": 12,
            "decode_window_frames": 80,
            "first_chunk_emit_every": 5,
            "first_chunk_decode_window": 48,
        }
        if instruct and instruct.strip():
            kwargs["instruction"] = instruct.strip()

        for chunk, sr in self.design_model.stream_generate_voice_design(**kwargs):
            yield self._apply_edge_fade(chunk), sr

    def stream_voice_clone_sentence(
        self, text: str, ref_audio_path: str, ref_text: str, language: str
    ):
        """
        Generator yielding (pcm_np: np.ndarray[float32], sample_rate: int) tuples
        via model-native streaming.  The voice-clone prompt vector is computed once
        per (ref_audio_path, ref_text) pair and cached for subsequent calls.
        """
        self._ensure_clone_loaded()

        if not os.path.isfile(ref_audio_path):
            raise RuntimeError(f"Reference audio file not found: '{ref_audio_path}'")

        cache_key = (ref_audio_path, ref_text)
        if cache_key in self._prompt_cache:
            prompt = self._prompt_cache[cache_key]
            tmp_path = None
        else:
            audio_data, sr_in = sf.read(ref_audio_path, dtype="float32")
            tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
            os.close(tmp_fd)
            sf.write(tmp_path, audio_data, sr_in, format="WAV", subtype="PCM_16")
            prompt = self.clone_model.create_voice_clone_prompt(
                ref_audio=tmp_path, ref_text=ref_text
            )
            self._prompt_cache[cache_key] = prompt

        try:
            streamer = self.clone_model.stream_generate_voice_clone(
                text=text,
                language=language or "Auto",
                voice_clone_prompt=prompt,
                emit_every_frames=12,
                decode_window_frames=80,
                first_chunk_emit_every=5,
                first_chunk_decode_window=48,
            )
            for chunk, sr in streamer:
                yield self._apply_edge_fade(chunk), sr
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _enable_streaming_opts(self, model):
        """Call enable_streaming_optimizations on a loaded model.  On CUDA, also
        compiles the decoder with reduce-overhead for lower first-chunk latency."""
        opts = {"decode_window_frames": 80, "use_compile": False}
        if self.device == "cuda":
            opts["use_compile"] = False
            opts["compile_mode"] = "reduce-overhead"
        try:
            model.enable_streaming_optimizations(**opts)
            logger.info("Streaming optimizations enabled.")
        except Exception as e:
            logger.warning(f"Could not enable streaming optimizations: {e}")

    @staticmethod
    def _apply_edge_fade(chunk: np.ndarray, fade_samples: int = 120) -> np.ndarray:
        """Apply a short linear fade-in and fade-out to a PCM chunk.
        Prevents audible clicks at the seam between consecutive chunks."""
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
    """Called by app.py at startup to pre-load the VoiceDesign model."""
    logger.info("Triggering TTS service initialisation on server startup…")
    return get_tts_service()
