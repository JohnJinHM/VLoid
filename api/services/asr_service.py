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
    Manages FSMN-VAD, FunASR Nano (offline), and optionally
    paraformer-zh-streaming (streaming partial recognition).

    Pipeline (per WebSocket connection):
      Non-streaming mode:
        vad_infer(chunk, cache) detects speech boundaries.
        transcribe(pcm) runs on the complete buffered utterance after speech_end.

      Streaming mode (requires use_streaming: true in config):
        vad_infer() still detects boundaries.
        stream_asr_infer(chunk, cache, is_final) runs every 600 ms during speech,
        yielding partial text incrementally.
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

        # Streaming ASR config
        self.use_streaming              = cfg.get("use_streaming", False)
        self.streaming_model_path       = cfg.get("streaming_model_path", "paraformer-zh-streaming")
        self.streaming_chunk_size       = cfg.get("streaming_chunk_size", [0, 10, 5])
        self.streaming_encoder_lookback = cfg.get("streaming_encoder_lookback", 4)
        self.streaming_decoder_lookback = cfg.get("streaming_decoder_lookback", 1)

        device_cfg = cfg.get("device", "cuda")
        try:
            self.device = device_cfg if (device_cfg != "cuda" or torch.cuda.is_available()) else "cpu"
        except Exception:
            self.device = "cpu"

        self._device_str = "cuda:0" if self.device == "cuda" else self.device

        self.vad_model       = None
        self.asr_model       = None
        self.streaming_model = None
        self.loaded          = False

        # Serialise offline ASR: the LLM is not safe to run concurrently
        self._asr_lock = Lock()

        logger.info(
            f"Initializing ASR Service — asr={self.model_path}, "
            f"vad={self.vad_model_path}, device={self.device}, "
            f"streaming={'enabled' if self.use_streaming else 'disabled'}"
        )

        try:
            logger.info(f"Loading VAD model: {self.vad_model_path}")
            self.vad_model = AutoModel(
                model=self.vad_model_path,
                device=self._device_str,
                max_single_segment_time=self.max_segment_ms,
            )
            logger.info("VAD model loaded.")

            logger.info(f"Loading offline ASR model: {self.model_path}")
            self.asr_model = AutoModel(
                model=self.model_path,
                device=self._device_str,
            )
            logger.info("Offline ASR model loaded.")

            if self.use_streaming:
                logger.info(f"Loading streaming ASR model: {self.streaming_model_path}")
                self.streaming_model = AutoModel(
                    model=self.streaming_model_path,
                    device=self._device_str,
                )
                logger.info("Streaming ASR model loaded.")

            self.loaded = True

            logger.info("Starting ASR/VAD warmup…")
            self._warmup()
            logger.info("ASR/VAD warmup complete.")

        except Exception as e:
            logger.error(f"Failed to load ASR model: {e}", exc_info=True)

    def _warmup(self):
        """Dummy inferences to pre-compile CUDA ops and load weights into VRAM."""
        try:
            # VAD warmup
            cache = {}
            self.vad_model.generate(
                input=np.zeros(int(self.vad_chunk_ms * 16000 / 1000), dtype=np.float32),
                cache=cache,
                is_final=True,
                chunk_size=self.vad_chunk_ms,
            )
            logger.info("VAD warmup done.")

            # Offline ASR warmup
            self.asr_model.generate(
                input=torch.zeros(16000, dtype=torch.float32),
                batch_size=1,
            )
            logger.info("Offline ASR warmup done.")

            # Streaming ASR warmup
            if self.use_streaming and self.streaming_model is not None:
                chunk_samples = self.streaming_chunk_size[1] * 960  # e.g. 10*960=9600
                cache_s = {}
                self.streaming_model.generate(
                    input=np.zeros(chunk_samples, dtype=np.float32),
                    cache=cache_s,
                    is_final=True,
                    chunk_size=self.streaming_chunk_size,
                    encoder_chunk_look_back=self.streaming_encoder_lookback,
                    decoder_chunk_look_back=self.streaming_decoder_lookback,
                )
                logger.info("Streaming ASR warmup done.")

        except Exception as e:
            logger.warning(f"Warmup failed (first request may be slow): {e}")

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def get_status(self) -> dict:
        return {
            "loaded":               self.loaded,
            "model":                self.model_path,
            "vad_model":            self.vad_model_path,
            "device":               self.device,
            "streaming_available":  self.use_streaming and self.streaming_model is not None,
        }

    # ------------------------------------------------------------------
    # Streaming VAD
    # ------------------------------------------------------------------

    def vad_infer(self, pcm_np: np.ndarray, cache: dict, is_final: bool = False) -> list:
        """
        Feed one 200 ms PCM chunk to the streaming FSMN-VAD.
        Returns list of [beg, end] pairs (ms, absolute from session start).
          [beg, -1]  → speech_start
          [-1, end]  → speech_end
          [beg, end] → complete segment
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
    # Offline ASR transcription (non-streaming mode)
    # ------------------------------------------------------------------

    def transcribe(self, pcm_np: np.ndarray) -> str:
        """Transcribe a complete utterance (float32, 16 kHz, mono). Thread-safe."""
        if not self.loaded or self.asr_model is None:
            return ""
        with self._asr_lock:
            try:
                res = self.asr_model.generate(
                    input=torch.from_numpy(pcm_np),
                    batch_size=1,
                )
                if res and isinstance(res, list) and res[0].get("text"):
                    return res[0]["text"].strip()
                return ""
            except Exception as e:
                logger.error(f"ASR transcription error: {e}", exc_info=True)
                return ""

    # ------------------------------------------------------------------
    # Streaming ASR (paraformer-zh-streaming)
    # ------------------------------------------------------------------

    def stream_asr_infer(
        self,
        pcm_np: np.ndarray,
        cache: dict,
        is_final: bool = False,
    ) -> str:
        """
        Run one streaming ASR step.  Each non-final call expects exactly
        chunk_size[1]*960 samples (e.g. 9600 for chunk_size=[0,10,5]).
        The final call (is_final=True) may be shorter; it flushes the model.
        Returns partial recognised text, or "" if none.
        """
        if not self.use_streaming or self.streaming_model is None:
            return ""
        try:
            res = self.streaming_model.generate(
                input=pcm_np,
                cache=cache,
                is_final=is_final,
                chunk_size=self.streaming_chunk_size,
                encoder_chunk_look_back=self.streaming_encoder_lookback,
                decoder_chunk_look_back=self.streaming_decoder_lookback,
            )
            if res and res[0].get("text"):
                return res[0]["text"].strip()
            return ""
        except Exception as e:
            logger.error(f"Streaming ASR error: {e}", exc_info=True)
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
