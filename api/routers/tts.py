import asyncio
import os
import struct
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional

from api.services.tts_service import get_tts_service, TTSService
from core.logger import get_logger

logger = get_logger("TTSRouter")

router = APIRouter(prefix="/api/tts", tags=["TTS"])

# Thread pool for blocking TTS inference so the event loop stays free
_tts_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts")


# ------------------------------------------------------------------
# Request schema
# ------------------------------------------------------------------

class TTSStreamRequest(BaseModel):
    text: str
    language: Optional[str] = "Auto"
    # voice_design fields
    instruct: str = ""
    # voice_clone fields
    ref_audio_path: str = ""
    ref_text: str = ""


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def require_tts() -> TTSService:
    svc = get_tts_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="TTS service not initialised")
    return svc


# Sentinel used to signal end-of-stream from the producer thread
_STREAM_DONE = object()


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
        return {"loaded": False, "model_type": "unknown", "device": "unknown"}
    return svc.get_status()


@router.post("/stream")
async def tts_stream(req: TTSStreamRequest, svc: TTSService = Depends(require_tts)):
    """
    Unified native-streaming TTS endpoint.  Dispatches to voice_design or voice_clone
    based on the server-side tts.model config.

    Wire format:
        Header  — b'PCM\\0' + uint32 BE sample_rate + uint32 BE channels  (12 bytes)
        Frames  — uint32 BE byte_length + float32 LE PCM bytes  (repeated)

    If the server is running voice_clone, ref_audio_path must point to a valid
    audio file on the local filesystem.
    """
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")

    if svc.model_type == "voice_clone" and not os.path.isfile(req.ref_audio_path):
        raise HTTPException(
            status_code=404,
            detail=f"Reference audio not found: '{req.ref_audio_path}'. "
                   "Re-select the file in the Persona Editor."
        )

    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()

    def _produce():
        try:
            for chunk, sr in svc.stream_generate(
                text=req.text.strip(),
                instruct=req.instruct,
                language=req.language or "Auto",
                ref_audio_path=req.ref_audio_path,
                ref_text=req.ref_text,
            ):
                loop.call_soon_threadsafe(q.put_nowait, (chunk, sr))
        except Exception as e:
            logger.error(f"/stream error: {e}", exc_info=True)
        finally:
            loop.call_soon_threadsafe(q.put_nowait, _STREAM_DONE)

    async def generate():
        _tts_executor.submit(_produce)
        header_sent = False
        while True:
            item = await q.get()
            if item is _STREAM_DONE:
                break
            chunk, sr = item
            if not header_sent:
                yield _pcm_header(sr, 1)
                header_sent = True
            yield _pcm_frame(chunk)

    return StreamingResponse(generate(), media_type="application/octet-stream")
