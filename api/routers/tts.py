import asyncio
import os
import re
import struct
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from typing import Optional

from api.services.tts_service import get_tts_service, TTSService
from core.logger import get_logger

logger = get_logger("TTSRouter")

router = APIRouter(prefix="/api/tts", tags=["TTS"])

# Thread pool for blocking TTS inference so the event loop stays free
_tts_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts")


# ------------------------------------------------------------------
# Request schemas
# ------------------------------------------------------------------

class VoiceDesignRequest(BaseModel):
    text: str
    instruct: str = ""
    language: Optional[str] = "Auto"
    split_mode: Optional[str] = "sentence"   # whole | sentence | punctuation | paragraph


class VoiceCloneRequest(BaseModel):
    text: str
    ref_audio_path: str    # Absolute OS path to the reference audio file
    ref_text: str = ""
    language: Optional[str] = "Auto"
    split_mode: Optional[str] = "sentence"


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def require_tts() -> TTSService:
    svc = get_tts_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="TTS service not initialised")
    return svc


def _resolve_ref_audio(path: str) -> str:
    """
    Validate that *path* is a non-empty string pointing to an existing file.
    Accepts any absolute OS path supplied by the local Electron client.
    """
    if not path:
        raise HTTPException(status_code=400, detail="ref_audio_path must not be empty.")
    if not os.path.isfile(path):
        raise HTTPException(
            status_code=404,
            detail=f"Reference audio not found: '{path}'. "
                   "The file may have been moved or deleted — please re-select it."
        )
    return path


def _split_text(text: str, mode: str) -> list[str]:
    """
    Split *text* into TTS-sized chunks according to *mode*.

    Modes
    -----
    whole       — single chunk, no splitting
    sentence    — split after sentence-ending punctuation: . ! ? 。 ！ ？  (default)
    punctuation — split after any pause/stop punct, incl. , ， ; ； : ：  …
    paragraph   — split on blank lines / single newlines
    """
    text = text.strip()
    if not text:
        return []
    if mode == "whole":
        return [text]
    if mode == "paragraph":
        parts = re.split(r"\n\s*\n|\n", text)
        return [s.strip() for s in parts if s.strip()] or [text]
    if mode == "punctuation":
        # Sentence-ending: . ! ? 。 ！ ？ …
        # Clause-ending:   , ; : ， 、 ； ：
        parts = re.split(r"(?<=[.!?,;:。！？，、；：…])\s*", text)
        return [s.strip() for s in parts if s.strip()] or [text]
    # Default: sentence
    parts = re.split(r"(?<=[.!?。！？])\s*", text)
    return [s.strip() for s in parts if s.strip()] or [text]


def _length_prefix(data: bytes) -> bytes:
    """Prepend a 4-byte big-endian length so the client can parse WAV chunks."""
    return len(data).to_bytes(4, "big") + data


# Sentinel used to signal end-of-stream from the producer thread
_NATIVE_DONE = object()


def _pcm_header(sample_rate: int, channels: int) -> bytes:
    """12-byte stream header: magic b'PCM\\0' + uint32 BE sample_rate + uint32 BE channels."""
    return b"PCM\x00" + struct.pack(">II", sample_rate, channels)


def _pcm_frame(pcm_np) -> bytes:
    """Length-prefixed float32 PCM frame: uint32 BE byte-length + raw float32 LE bytes."""
    data = pcm_np.astype("float32").tobytes()
    return struct.pack(">I", len(data)) + data


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.get("/status")
def tts_status():
    svc = get_tts_service()
    if svc is None:
        return {"service": "not_initialized", "vd_loaded": False, "clone_loaded": False}
    return {"service": "ok", **svc.get_status()}


# ── Non-streaming ─────────────────────────────────────────────────

@router.post("/voice-design")
def tts_voice_design(req: VoiceDesignRequest, svc: TTSService = Depends(require_tts)):
    try:
        wav_bytes = svc.voice_design(
            text=req.text, instruct=req.instruct, language=req.language or "Auto"
        )
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as e:
        logger.error(f"voice-design error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/voice-clone")
def tts_voice_clone(req: VoiceCloneRequest, svc: TTSService = Depends(require_tts)):
    path = _resolve_ref_audio(req.ref_audio_path)
    try:
        wav_bytes = svc.voice_clone(
            text=req.text, ref_audio_path=path,
            ref_text=req.ref_text, language=req.language or "Auto",
        )
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as e:
        logger.error(f"voice-clone error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ── Streaming ─────────────────────────────────────────────────────

@router.post("/voice-design/stream")
async def tts_voice_design_stream(
    req: VoiceDesignRequest, svc: TTSService = Depends(require_tts)
):
    """
    Streaming VoiceDesign: splits text per split_mode, yields each chunk as
    [4-byte uint32 BE length][WAV bytes].
    """
    sentences = _split_text(req.text, req.split_mode or "sentence")
    loop = asyncio.get_event_loop()

    async def generate():
        for sentence in sentences:
            try:
                wav_bytes = await loop.run_in_executor(
                    _tts_executor,
                    lambda s=sentence: svc.voice_design(
                        text=s, instruct=req.instruct, language=req.language or "Auto"
                    )
                )
                yield _length_prefix(wav_bytes)
            except Exception as e:
                logger.error(f"voice-design/stream error: {e}", exc_info=True)
                break

    return StreamingResponse(generate(), media_type="application/octet-stream")


# ── Native streaming (model frame-level) ──────────────────────────

@router.post("/voice-design/stream-native")
async def tts_voice_design_stream_native(
    req: VoiceDesignRequest, svc: TTSService = Depends(require_tts)
):
    """
    Native-streaming VoiceDesign: the model emits raw float32 PCM frames as they
    are decoded.  Wire format:
        Header  — b'PCM\\0' + uint32 BE sample_rate + uint32 BE channels  (12 bytes)
        Frames  — uint32 BE byte_length + float32 LE PCM bytes  (repeated)
    """
    sentences = _split_text(req.text, req.split_mode or "sentence")
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()

    def _produce():
        try:
            for sentence in sentences:
                for chunk, sr in svc.stream_voice_design_sentence(
                    text=sentence,
                    instruct=req.instruct,
                    language=req.language or "Auto",
                ):
                    loop.call_soon_threadsafe(q.put_nowait, (chunk, sr))
        except Exception as e:
            logger.error(f"voice-design/stream-native error: {e}", exc_info=True)
        finally:
            loop.call_soon_threadsafe(q.put_nowait, _NATIVE_DONE)

    async def generate():
        _tts_executor.submit(_produce)
        header_sent = False
        while True:
            item = await q.get()
            if item is _NATIVE_DONE:
                break
            chunk, sr = item
            if not header_sent:
                yield _pcm_header(sr, 1)
                header_sent = True
            yield _pcm_frame(chunk)

    return StreamingResponse(generate(), media_type="application/octet-stream")


@router.post("/voice-clone/stream")
async def tts_voice_clone_stream(
    req: VoiceCloneRequest, svc: TTSService = Depends(require_tts)
):
    """
    Streaming VoiceClone: same sentence-level streaming as voice-design/stream.
    """
    path = _resolve_ref_audio(req.ref_audio_path)
    sentences = _split_text(req.text, req.split_mode or "sentence")
    loop = asyncio.get_event_loop()

    async def generate():
        for sentence in sentences:
            try:
                wav_bytes = await loop.run_in_executor(
                    _tts_executor,
                    lambda s=sentence: svc.voice_clone(
                        text=s, ref_audio_path=path,
                        ref_text=req.ref_text, language=req.language or "Auto",
                    )
                )
                yield _length_prefix(wav_bytes)
            except Exception as e:
                logger.error(f"voice-clone/stream error: {e}", exc_info=True)
                break

    return StreamingResponse(generate(), media_type="application/octet-stream")


@router.post("/voice-clone/stream-native")
async def tts_voice_clone_stream_native(
    req: VoiceCloneRequest, svc: TTSService = Depends(require_tts)
):
    """Native-streaming VoiceClone — same wire format as voice-design/stream-native."""
    path = _resolve_ref_audio(req.ref_audio_path)
    sentences = _split_text(req.text, req.split_mode or "sentence")
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()

    def _produce():
        try:
            for sentence in sentences:
                for chunk, sr in svc.stream_voice_clone_sentence(
                    text=sentence,
                    ref_audio_path=path,
                    ref_text=req.ref_text,
                    language=req.language or "Auto",
                ):
                    loop.call_soon_threadsafe(q.put_nowait, (chunk, sr))
        except Exception as e:
            logger.error(f"voice-clone/stream-native error: {e}", exc_info=True)
        finally:
            loop.call_soon_threadsafe(q.put_nowait, _NATIVE_DONE)

    async def generate():
        _tts_executor.submit(_produce)
        header_sent = False
        while True:
            item = await q.get()
            if item is _NATIVE_DONE:
                break
            chunk, sr = item
            if not header_sent:
                yield _pcm_header(sr, 1)
                header_sent = True
            yield _pcm_frame(chunk)

    return StreamingResponse(generate(), media_type="application/octet-stream")
