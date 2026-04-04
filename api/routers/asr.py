import asyncio
import json
import numpy as np
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.services.asr_service import get_asr_service
from core.logger import get_logger

logger = get_logger("ASRRouter")

router = APIRouter(prefix="/api/asr", tags=["ASR"])

# Dedicated single-worker pool: ASR inference must run on the same thread that
# performed warmup so PyTorch CUDA graph TLS state remains consistent.
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

# Streaming ASR chunk: chunk_size[1] * 960 samples × 2 bytes/sample = 19200 B (600 ms)
STREAMING_CHUNK_BYTES = 9600 * BYTES_PER_SAMPLE                     # 19200 B


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
      Text frame: {"type": "control", "streaming": bool}  — enable/disable streaming ASR.

    Backend → Frontend (JSON):
      {"type": "status",    "loaded": bool, "streaming_available": bool}  – sent on connect
      {"type": "speech_start"}                   – VAD detected utterance start
      {"type": "speech_end"}                     – VAD detected utterance end
      {"type": "partial",  "text": "..."}        – streaming ASR partial result (streaming mode only)
      {"type": "transcript","text": "..."}       – final ASR result
      {"type": "error",    "message": "..."}     – non-fatal error
    """
    await websocket.accept()
    svc = get_asr_service()

    streaming_available = svc.use_streaming and svc.streaming_model is not None
    await websocket.send_json({
        "type": "status",
        "loaded": svc.loaded,
        "streaming_available": streaming_available,
    })

    if not svc.loaded:
        await websocket.close(code=1011, reason="ASR service not loaded")
        return

    loop = asyncio.get_running_loop()

    # ----- Per-connection VAD state -----
    vad_cache   = {}
    vad_accum   = bytearray()   # accumulates incoming bytes for VAD batching
    speech_buf  = bytearray()   # complete buffered speech for offline ASR
    is_speech   = False
    pre_roll    = bytearray()   # rolling 300 ms pre-speech window

    # ----- Per-connection streaming ASR state -----
    streaming_enabled   = False
    streaming_asr_cache = {}
    streaming_asr_buf   = bytearray()   # accumulates bytes for 600 ms streaming chunks
    streaming_text      = ""            # accumulated partial text for this utterance

    # ----- Helpers -----

    async def _process_streaming_chunk(is_final: bool) -> str:
        """
        Consume all (or just the first STREAMING_CHUNK_BYTES of) streaming_asr_buf,
        run one streaming inference step, and return the partial text.
        For is_final=True the entire remaining buffer is consumed.
        """
        nonlocal streaming_asr_buf
        if is_final:
            chunk_bytes = bytes(streaming_asr_buf)
            streaming_asr_buf = bytearray()
        else:
            chunk_bytes = bytes(streaming_asr_buf[:STREAMING_CHUNK_BYTES])
            del streaming_asr_buf[:STREAMING_CHUNK_BYTES]

        if not chunk_bytes:
            return ""

        pcm = np.frombuffer(chunk_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        return await loop.run_in_executor(
            _asr_executor, svc.stream_asr_infer, pcm, streaming_asr_cache, is_final
        )

    async def _finish_speech():
        nonlocal is_speech, speech_buf, streaming_asr_cache, streaming_asr_buf, streaming_text

        is_speech  = False
        pcm_bytes  = bytes(speech_buf)
        speech_buf = bytearray()

        await websocket.send_json({"type": "speech_end"})

        if len(pcm_bytes) < MIN_SPEECH_BYTES:
            streaming_asr_cache = {}
            streaming_asr_buf   = bytearray()
            streaming_text      = ""
            return

        if streaming_enabled:
            # Flush any remaining partial buffer with is_final=True
            final_partial = await _process_streaming_chunk(is_final=True)
            if final_partial:
                streaming_text += final_partial
                await websocket.send_json({"type": "partial", "text": streaming_text})

            text = streaming_text

            # Reset streaming state for next utterance
            streaming_asr_cache = {}
            streaming_asr_buf   = bytearray()
            streaming_text      = ""
        else:
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
            msg = await websocket.receive()

            # Clean client disconnect — exit gracefully without erroring
            if msg.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect(code=msg.get("code", 1000))

            # Text frame: control message from frontend
            if "text" in msg:
                try:
                    data = json.loads(msg["text"])
                    if data.get("type") == "control":
                        requested = bool(data.get("streaming", False))
                        streaming_enabled = requested and streaming_available
                        logger.info(
                            f"Streaming ASR {'enabled' if streaming_enabled else 'disabled'} for connection."
                        )
                except Exception:
                    pass
                continue

            raw_bytes = msg.get("bytes", b"")
            if not raw_bytes:
                continue

            # 1. Update rolling pre-roll (keep last 300 ms)
            pre_roll.extend(raw_bytes)
            if len(pre_roll) > PRE_ROLL_BYTES:
                del pre_roll[: len(pre_roll) - PRE_ROLL_BYTES]

            # 2. Append to speech buffer and stream if utterance is active
            if is_speech:
                speech_buf.extend(raw_bytes)

                # Streaming: accumulate and process in 600 ms chunks
                if streaming_enabled:
                    streaming_asr_buf.extend(raw_bytes)
                    while len(streaming_asr_buf) >= STREAMING_CHUNK_BYTES:
                        partial = await _process_streaming_chunk(is_final=False)
                        if partial:
                            streaming_text += partial
                            await websocket.send_json({"type": "partial", "text": streaming_text})

                # Safety cap: force-process if utterance is unreasonably long
                if len(speech_buf) >= MAX_SPEECH_BYTES:
                    logger.warning("Speech segment exceeded 30 s cap; force-processing.")
                    await _finish_speech()
                    continue

            # 3. Accumulate for VAD
            vad_accum.extend(raw_bytes)

            # 4. Process VAD in 200 ms batches
            while len(vad_accum) >= VAD_BATCH_BYTES:
                batch_bytes = bytes(vad_accum[:VAD_BATCH_BYTES])
                del vad_accum[:VAD_BATCH_BYTES]

                batch = np.frombuffer(batch_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                events = await loop.run_in_executor(
                    None, svc.vad_infer, batch, vad_cache, False
                )

                for seg in events:
                    beg, end = seg[0], seg[1]

                    # Speech start detected
                    if beg >= 0 and not is_speech:
                        is_speech           = True
                        speech_buf          = bytearray(pre_roll)
                        streaming_asr_cache = {}
                        streaming_asr_buf   = bytearray()
                        streaming_text      = ""
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
