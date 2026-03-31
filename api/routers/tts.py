import asyncio
import os
import re
import uuid as uuid_module
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import Response, StreamingResponse, FileResponse
from pydantic import BaseModel
from typing import Optional

from api.services.tts_service import get_tts_service, TTSService
from core.logger import get_logger

logger = get_logger("TTSRouter")

router = APIRouter(prefix="/api/tts", tags=["TTS"])

# Thread pool for blocking TTS inference so the event loop stays free
_tts_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts")

# Directory where reference audio files are stored on disk
_PROJECT_ROOT = Path(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
REF_AUDIO_DIR = _PROJECT_ROOT / "data" / "ref_audio"
REF_AUDIO_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_AUDIO_TYPES = {"audio/wav", "audio/mpeg", "audio/ogg", "audio/flac",
                       "audio/x-wav", "audio/x-flac"}
ALLOWED_AUDIO_EXTS  = {"wav", "mp3", "ogg", "flac"}
MAX_AUDIO_SIZE      = 50 * 1024 * 1024   # 50 MB


# ------------------------------------------------------------------
# Request schemas
# ------------------------------------------------------------------

class VoiceDesignRequest(BaseModel):
    text: str
    instruct: str = ""
    language: Optional[str] = "Auto"


class VoiceCloneRequest(BaseModel):
    text: str
    ref_audio_path: str    # Relative path on the server (from project root)
    ref_text: str = ""
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


def _resolve_ref_audio(rel_path: str) -> Path:
    """
    Resolve a stored relative path to an absolute Path and verify it is inside
    REF_AUDIO_DIR to prevent path traversal.
    """
    abs_path = (_PROJECT_ROOT / rel_path).resolve()
    if not abs_path.is_relative_to(REF_AUDIO_DIR.resolve()):
        raise HTTPException(status_code=400, detail="Invalid audio path.")
    if not abs_path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"Reference audio file not found: {rel_path}. "
                   "The file may have been deleted — please re-upload it."
        )
    return abs_path


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.get("/status")
def tts_status():
    svc = get_tts_service()
    if svc is None:
        return {"service": "not_initialized", "vd_loaded": False, "clone_loaded": False}
    return {"service": "ok", **svc.get_status()}


# ── Non-streaming inference ──────────────────────────────────────

@router.post("/voice-design")
def tts_voice_design(req: VoiceDesignRequest, svc: TTSService = Depends(require_tts)):
    """VoiceDesign: returns complete audio/wav binary."""
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
    """VoiceClone: returns complete audio/wav binary."""
    abs_path = _resolve_ref_audio(req.ref_audio_path)
    try:
        wav_bytes = svc.voice_clone(
            text=req.text,
            ref_audio_path=str(abs_path),
            ref_text=req.ref_text,
            language=req.language or "Auto",
        )
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as e:
        logger.error(f"voice-clone error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ── Streaming inference ───────────────────────────────────────────

@router.post("/voice-design/stream")
async def tts_voice_design_stream(
    req: VoiceDesignRequest, svc: TTSService = Depends(require_tts)
):
    """
    Streaming VoiceDesign: splits text into sentences, yields each as a
    length-prefixed WAV chunk so the client can start playing immediately.

    Frame format: [4-byte uint32 BE length][WAV bytes]
    """
    sentences = _split_sentences(req.text)
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


@router.post("/voice-clone/stream")
async def tts_voice_clone_stream(
    req: VoiceCloneRequest, svc: TTSService = Depends(require_tts)
):
    """
    Streaming VoiceClone: same sentence-level streaming as voice-design/stream.
    """
    abs_path = _resolve_ref_audio(req.ref_audio_path)
    abs_path_str = str(abs_path)
    sentences = _split_sentences(req.text)
    loop = asyncio.get_event_loop()

    async def generate():
        for sentence in sentences:
            try:
                wav_bytes = await loop.run_in_executor(
                    _tts_executor,
                    lambda s=sentence: svc.voice_clone(
                        text=s,
                        ref_audio_path=abs_path_str,
                        ref_text=req.ref_text,
                        language=req.language or "Auto",
                    )
                )
                yield _length_prefix(wav_bytes)
            except Exception as e:
                logger.error(f"voice-clone/stream error: {e}", exc_info=True)
                break

    return StreamingResponse(generate(), media_type="application/octet-stream")


# ── Reference audio file management ──────────────────────────────

@router.post("/upload-ref-audio")
async def upload_ref_audio(file: UploadFile = File(...)):
    """
    Upload a reference audio file. The file is saved to disk and a
    server-relative path is returned for storage in the persona.

    Returns:
      {
        "id": "<uuid>",
        "filename": "<original name>",
        "path": "data/ref_audio/<uuid>.<ext>",
        "url": "/api/tts/ref-audio/<uuid>.<ext>"
      }
    """
    content_type = (file.content_type or "").lower()
    filename = file.filename or "audio"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if content_type not in ALLOWED_AUDIO_TYPES and ext not in ALLOWED_AUDIO_EXTS:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported format '{content_type}'. Allowed: wav, mp3, ogg, flac."
        )

    raw = await file.read()
    if len(raw) > MAX_AUDIO_SIZE:
        raise HTTPException(status_code=413, detail="File exceeds 50 MB limit.")

    # Save with a UUID name to avoid collisions
    audio_id  = str(uuid_module.uuid4())
    safe_ext  = ext if ext in ALLOWED_AUDIO_EXTS else "wav"
    save_name = f"{audio_id}.{safe_ext}"
    save_path = REF_AUDIO_DIR / save_name
    save_path.write_bytes(raw)

    rel_path = f"data/ref_audio/{save_name}"
    logger.info(f"Saved ref audio: {rel_path} ({len(raw)} bytes, original: {filename})")

    return {
        "id":       audio_id,
        "filename": filename,
        "path":     rel_path,
        "url":      f"/api/tts/ref-audio/{save_name}",
    }


@router.get("/ref-audio/{audio_filename}")
async def serve_ref_audio(audio_filename: str):
    """Serve a stored reference audio file for browser preview."""
    # Sanitise: only allow UUID.ext filenames (no path traversal)
    if not re.match(r'^[0-9a-f\-]+\.[a-z0-9]+$', audio_filename, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="Invalid filename.")
    file_path = REF_AUDIO_DIR / audio_filename
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Audio file not found.")
    return FileResponse(str(file_path))


@router.delete("/ref-audio/{audio_filename}")
async def delete_ref_audio(audio_filename: str):
    """Delete a stored reference audio file."""
    if not re.match(r'^[0-9a-f\-]+\.[a-z0-9]+$', audio_filename, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="Invalid filename.")
    file_path = REF_AUDIO_DIR / audio_filename
    if file_path.is_file():
        file_path.unlink()
        logger.info(f"Deleted ref audio: {audio_filename}")
    return {"status": "ok"}
