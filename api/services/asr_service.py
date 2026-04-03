import numpy as np
import torch
from threading import Lock

from funasr.models.fun_asr_nano.model import FunASRNano
from funasr.register import tables
tables.model_classes["FunASRNano"] = FunASRNano
from funasr import AutoModel

from core.config import load_config
from core.logger import get_logger

logger = get_logger("ASRService")


class ASRService:
    """
    Manages FSMN-VAD (streaming voice activity detection) and FunASR Nano
    (LLM-based ASR) as a single singleton.

    Pipeline (per WebSocket connection):
      1. Audio chunks (float32, 16 kHz, mono) arrive continuously.
      2. vad_infer(chunk, cache) → list of [beg, end] timing events.
      3. On speech boundaries, the caller buffers and calls transcribe(pcm).
      4. transcribe() returns the recognised text string.
    """

    _instance = None
    _lock = Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialize()
            return cls._instance

    # ------------------------------------------------------------------
    # Initialization
    # ------------------------------------------------------------------

    def _initialize(self):
        cfg = load_config().get("asr", {})

        self.model_path     = cfg.get("model_path",     "./models/asr/Fun-ASR-Nano-2512")
        self.vad_model_path = cfg.get("vad_model_path", "fsmn-vad")
        self.vad_chunk_ms   = cfg.get("vad_chunk_size_ms", 200)
        self.max_segment_ms = cfg.get("max_segment_ms", 30000)

        device_cfg = cfg.get("device", "cuda")
        try:
            import torch
            self.device = device_cfg if (device_cfg != "cuda" or torch.cuda.is_available()) else "cpu"
        except ImportError:
            self.device = "cpu"

        # "cuda" → "cuda:0" for AutoModel
        self._device_str = "cuda:0" if self.device == "cuda" else self.device

        self.vad_model = None
        self.asr_model = None
        self.loaded    = False

        # Serialise ASR inference: the LLM is not thread-safe for concurrent runs
        self._asr_lock = Lock()

        logger.info(
            f"Initializing ASR Service — asr={self.model_path}, "
            f"vad={self.vad_model_path}, device={self.device}"
        )

        try:
            
            logger.info(f"Loading VAD model: {self.vad_model_path}")
            self.vad_model = AutoModel(
                model=self.vad_model_path,
                device=self._device_str,
                max_single_segment_time=self.max_segment_ms,
            )
            logger.info("VAD model loaded.")

            logger.info(f"Loading ASR model: {self.model_path}")
            self.asr_model = AutoModel(
                model=self.model_path,
                device=self._device_str,
            )
            logger.info("ASR model loaded.")

            self.loaded = True

            logger.info("Starting ASR/VAD warmup...")
            self._warmup()
            logger.info("ASR/VAD warmup complete.")

        except Exception as e:
            logger.error(f"Failed to load ASR model: {e}", exc_info=True)

    def _warmup(self):
        """Single dummy inference to pre-compile CUDA ops and cache model weights."""
        try:
            # VAD warmup: one silent 200 ms chunk
            silent_chunk = np.zeros(
                int(self.vad_chunk_ms * 16000 / 1000), dtype=np.float32
            )
            cache = {}
            self.vad_model.generate(
                input=silent_chunk,
                cache=cache,
                is_final=True,
                chunk_size=self.vad_chunk_ms,
            )
            logger.info("VAD warmup pass done.")

            # ASR warmup: one second of silence
            self.asr_model.generate(
                input=torch.zeros(16000, dtype=torch.float32),
                batch_size=1,
            )
            logger.info("ASR warmup pass done.")

        except Exception as e:
            logger.warning(f"ASR/VAD warmup failed (first real request may be slow): {e}")

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def get_status(self) -> dict:
        return {
            "loaded":     self.loaded,
            "model":      self.model_path,
            "vad_model":  self.vad_model_path,
            "device":     self.device,
        }

    # ------------------------------------------------------------------
    # Streaming VAD
    # ------------------------------------------------------------------

    def vad_infer(
        self,
        pcm_np: np.ndarray,
        cache: dict,
        is_final: bool = False,
    ) -> list:
        """
        Feed one PCM chunk to the streaming FSMN-VAD.

        Returns a (possibly empty) list of [beg, end] pairs in milliseconds
        (absolute from connection start):
          [beg, -1]  → speech_start only
          [-1, end]  → speech_end only
          [beg, end] → complete speech segment
          []         → no event
        """
        if not self.loaded or self.vad_model is None:
            return []
        try:
            res = self.vad_model.generate(
                input=pcm_np,
                cache=cache,
                is_final=is_final,
                chunk_size=self.vad_chunk_ms,
            )
            return res[0]["value"] if (res and res[0].get("value")) else []
        except Exception as e:
            logger.error(f"VAD inference error: {e}", exc_info=True)
            return []

    # ------------------------------------------------------------------
    # ASR transcription
    # ------------------------------------------------------------------

    def transcribe(self, pcm_np: np.ndarray) -> str:
        """
        Transcribe a complete speech segment (float32, 16 kHz, mono).
        Thread-safe via internal lock.  Returns "" on failure.
        """
        if not self.loaded or self.asr_model is None:
            return ""
        with self._asr_lock:
            try:
                tensor = torch.from_numpy(pcm_np)
                res = self.asr_model.generate(input=tensor, batch_size=1)
                if res and isinstance(res, list) and res[0].get("text"):
                    return res[0]["text"].strip()
                return ""
            except Exception as e:
                logger.error(f"ASR transcription error: {e}", exc_info=True)
                return ""


# ------------------------------------------------------------------
# Singleton accessors
# ------------------------------------------------------------------

_service_instance = None


def get_asr_service() -> ASRService:
    global _service_instance
    if _service_instance is None:
        _service_instance = ASRService()
    return _service_instance


def init_asr_service():
    """Called by app.py lifespan to pre-load ASR and VAD models."""
    logger.info("Triggering ASR service initialisation on server startup…")
    return get_asr_service()
