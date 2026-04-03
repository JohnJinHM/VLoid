import asyncio
import numpy as np
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.services.asr_service import get_asr_service
from core.logger import get_logger

logger = get_logger("ASRRouter")

router = APIRouter(prefix="/api/asr", tags=["ASR"])

# Dedicated single-worker pool: ASR inference is not safe to run concurrently
# (LLM model weights are shared; serialising avoids CUDA OOM on concurrent ws).
_asr_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr")

# Audio constants (must match frontend capture settings)
SAMPLE_RATE       = 16000
BYTES_PER_SAMPLE  = 2         # Int16

# VAD accumulation target: 200 ms
VAD_BATCH_BYTES   = SAMPLE_RATE * BYTES_PER_SAMPLE * 200 // 1000   # 6400 B

# Pre-roll before detected speech_start (captures attack of utterance)
PRE_ROLL_BYTES    = SAMPLE_RATE * BYTES_PER_SAMPLE * 300 // 1000   # 9600 B

# Safety cap: force-end speech segment after 30 s to prevent runaway buffering
MAX_SPEECH_BYTES  = SAMPLE_RATE * BYTES_PER_SAMPLE * 30            # 960000 B

# Minimum buffered speech required to bother running ASR (avoids empty runs)
MIN_SPEECH_BYTES  = SAMPLE_RATE * BYTES_PER_SAMPLE * 100 // 1000   # 3200 B


# ------------------------------------------------------------------
# Status endpoint
# ------------------------------------------------------------------

@router.get("/status")
def asr_status():
    svc = get_asr_service()
    if svc is None:
        return {"loaded": False, "model": "unknown", "device": "unknown"}
    return svc.get_status()


# ------------------------------------------------------------------
# Full-duplex WebSocket
# ------------------------------------------------------------------

@router.websocket("/ws")
async def asr_websocket(websocket: WebSocket):
    """
    Full-duplex ASR WebSocket.

    Frontend → Backend:
      Binary frames of 16-bit PCM (little-endian), 16 kHz mono.
      Each message can be any number of samples (e.g. 64 ms = 1024 samples = 2048 B).

    Backend → Frontend (JSON):
      {"type": "speech_start"}                  – VAD detected utterance start
      {"type": "speech_end"}                    – VAD detected utterance end
      {"type": "transcript", "text": "..."}     – ASR result
      {"type": "error",      "message": "..."}  – non-fatal error
      {"type": "status",     "loaded": bool}    – sent once on connect
    """
    await websocket.accept()
    svc = get_asr_service()

    # Report readiness immediately so the frontend can disable the button
    # while ASR is still loading.
    await websocket.send_json({"type": "status", "loaded": svc.loaded})

    if not svc.loaded:
        await websocket.close(code=1011, reason="ASR service not loaded")
        return

    loop = asyncio.get_running_loop()

    # ----- Per-connection state -----
    vad_cache   = {}
    vad_accum   = bytearray()   # accumulates incoming Int16 bytes for VAD batching
    speech_buf  = bytearray()   # buffered speech from speech_start → speech_end
    is_speech   = False
    pre_roll    = bytearray()   # rolling 300 ms window for pre-speech context

    # ----- Helpers -----

    async def _finish_speech():
        """Convert speech_buf to float32, run ASR, send result."""
        nonlocal is_speech, speech_buf
        is_speech   = False
        pcm_bytes   = bytes(speech_buf)
        speech_buf  = bytearray()

        await websocket.send_json({"type": "speech_end"})

        if len(pcm_bytes) < MIN_SPEECH_BYTES:
            return

        pcm = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        try:
            text = await asyncio.wait_for(
                loop.run_in_executor(_asr_executor, svc.transcribe, pcm),
                timeout=30.0,
            )
        except asyncio.TimeoutError:
            logger.warning("ASR inference timed out for this utterance.")
            text = ""

        if text:
            await websocket.send_json({"type": "transcript", "text": text})

    # ----- Main receive loop -----

    try:
        while True:
            raw_bytes = await websocket.receive_bytes()

            # 1. Update rolling pre-roll (keep last 300 ms)
            pre_roll.extend(raw_bytes)
            if len(pre_roll) > PRE_ROLL_BYTES:
                del pre_roll[: len(pre_roll) - PRE_ROLL_BYTES]

            # 2. Append to speech buffer if utterance is active
            if is_speech:
                speech_buf.extend(raw_bytes)
                # Safety cap: force-process if utterance is unreasonably long
                if len(speech_buf) >= MAX_SPEECH_BYTES:
                    logger.warning("Speech segment exceeded 30 s cap; force-processing.")
                    await _finish_speech()
                    continue

            # 3. Accumulate for VAD
            vad_accum.extend(raw_bytes)

            # 4. Process VAD in 200 ms batches
            while len(vad_accum) >= VAD_BATCH_BYTES:
                batch_bytes         = bytes(vad_accum[:VAD_BATCH_BYTES])
                del vad_accum[:VAD_BATCH_BYTES]

                batch = np.frombuffer(batch_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                events = await loop.run_in_executor(
                    None, svc.vad_infer, batch, vad_cache, False
                )

                for seg in events:
                    beg, end = seg[0], seg[1]

                    # Speech start detected
                    if beg >= 0 and not is_speech:
                        is_speech  = True
                        # Seed speech_buf with pre-roll so we capture the attack
                        speech_buf = bytearray(pre_roll)
                        await websocket.send_json({"type": "speech_start"})

                    # Speech end detected
                    if end >= 0 and is_speech:
                        await _finish_speech()

    except WebSocketDisconnect:
        logger.info("ASR WebSocket client disconnected.")
    except Exception as e:
        logger.error(f"ASR WebSocket error: {e}", exc_info=True)
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
