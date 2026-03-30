import asyncio
import re
from concurrent.futures import ThreadPoolExecutor
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from typing import Optional
import base64

from api.services.tts_service import get_tts_service, TTSService
from core.logger import get_logger

logger = get_logger("TTS Router")

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


class VoiceCloneRequest(BaseModel):
    text: str
    ref_audio: str          # Base64-encoded audio; data-URI prefix accepted
    ref_text: str
    language: Optional[str] = "Auto"


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def require_tts() -> TTSService:
    svc = get_tts_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="TTS service not initialised")
    return svc


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences for streaming playback."""
    parts = re.split(r'(?<=[.!?。！？\n])\s*', text)
    return [s.strip() for s in parts if s.strip()] or [text.strip()]


def _length_prefix(data: bytes) -> bytes:
    """Prepend a 4-byte big-endian length so the client can parse WAV chunks."""
    return len(data).to_bytes(4, 'big') + data


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.get("/status")
def tts_status():
    svc = get_tts_service()
    if svc is None:
        return {"service": "not_initialized", "vd_loaded": False, "clone_loaded": False}
    return {"service": "ok", **svc.get_status()}


@router.post("/voice-design")
def tts_voice_design(req: VoiceDesignRequest, svc: TTSService = Depends(require_tts)):
    """
    VoiceDesign mode: describe the desired voice/style in natural language.
    Returns complete audio/wav binary.
    """
    try:
        wav_bytes = svc.voice_design(
            text=req.text,
            instruct=req.instruct,
            language=req.language or "Auto",
        )
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as e:
        logger.error(f"voice-design error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/voice-clone")
def tts_voice_clone(req: VoiceCloneRequest, svc: TTSService = Depends(require_tts)):
    """
    VoiceClone mode: clone the voice heard in the reference audio.
    Returns complete audio/wav binary.
    """
    try:
        wav_bytes = svc.voice_clone(
            text=req.text,
            ref_audio_b64=req.ref_audio,
            ref_text=req.ref_text,
            language=req.language or "Auto",
        )
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as e:
        logger.error(f"voice-clone error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/voice-design/stream")
async def tts_voice_design_stream(req: VoiceDesignRequest, svc: TTSService = Depends(require_tts)):
    """
    Streaming VoiceDesign: splits text into sentences, generates and streams
    each sentence as a length-prefixed WAV chunk.

    Frame format: [4-byte uint32 big-endian length][WAV bytes]

    The client can start playing the first sentence while subsequent sentences
    are still being generated.
    """
    sentences = _split_sentences(req.text)
    loop = asyncio.get_event_loop()

    async def generate():
        for sentence in sentences:
            try:
                wav_bytes = await loop.run_in_executor(
                    _tts_executor,
                    lambda s=sentence: svc.voice_design(
                        text=s,
                        instruct=req.instruct,
                        language=req.language or "Auto",
                    )
                )
                yield _length_prefix(wav_bytes)
            except Exception as e:
                logger.error(f"voice-design/stream sentence error: {e}", exc_info=True)
                break

    return StreamingResponse(generate(), media_type="application/octet-stream")


@router.post("/voice-clone/stream")
async def tts_voice_clone_stream(req: VoiceCloneRequest, svc: TTSService = Depends(require_tts)):
    """
    Streaming VoiceClone: same sentence-level streaming as voice-design/stream.
    """
    sentences = _split_sentences(req.text)
    loop = asyncio.get_event_loop()

    async def generate():
        for sentence in sentences:
            try:
                wav_bytes = await loop.run_in_executor(
                    _tts_executor,
                    lambda s=sentence: svc.voice_clone(
                        text=s,
                        ref_audio_b64=req.ref_audio,
                        ref_text=req.ref_text,
                        language=req.language or "Auto",
                    )
                )
                yield _length_prefix(wav_bytes)
            except Exception as e:
                logger.error(f"voice-clone/stream sentence error: {e}", exc_info=True)
                break

    return StreamingResponse(generate(), media_type="application/octet-stream")


@router.post("/upload-ref-audio")
async def upload_ref_audio(file: UploadFile = File(...)):
    """
    Upload a reference audio file and receive its base64 representation.
    Accepts: WAV, MP3, OGG, FLAC  (max 50 MB)
    Returns: { "ref_audio": "<base64 string>", "filename": "..." }
    """
    ALLOWED_TYPES = {"audio/wav", "audio/mpeg", "audio/ogg", "audio/flac", "audio/x-wav", "audio/x-flac"}
    MAX_SIZE = 50 * 1024 * 1024

    content_type = (file.content_type or "").lower()
    filename = file.filename or ""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    allowed_exts = {"wav", "mp3", "ogg", "flac"}

    if content_type not in ALLOWED_TYPES and ext not in allowed_exts:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported audio format '{content_type}'. Allowed: wav, mp3, ogg, flac."
        )

    raw = await file.read()
    if len(raw) > MAX_SIZE:
        raise HTTPException(status_code=413, detail="File exceeds 50 MB limit.")

    b64 = base64.b64encode(raw).decode("utf-8")
    return {"ref_audio": b64, "filename": filename}
