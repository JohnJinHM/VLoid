import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api.routers import chat, personas, sessions
from api.routers import tts as tts_router
from api.routers import asr as asr_router
from api.routers.tts import _tts_executor
from api.routers.asr import _asr_executor
from api.services.tts_service import init_tts_service
from api.services.asr_service import init_asr_service
from core.logger import get_logger

logger = get_logger("App")

# Set once in lifespan after all startup tasks complete.
# The Electron frontend polls GET /api/ready and shows its window when this fires.
_ready_event: asyncio.Event | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    """
    Startup: load TTS and ASR models concurrently, then set _ready_event.
    Shutdown: log teardown (individual services clean up their own resources).
    """
    global _ready_event
    _ready_event = asyncio.Event()

    loop = asyncio.get_event_loop()
    logger.info("Loading TTS and ASR models concurrently…")
    await asyncio.gather(
        loop.run_in_executor(_tts_executor, init_tts_service),
        loop.run_in_executor(_asr_executor, init_asr_service),
    )

    _ready_event.set()
    logger.info("All models loaded. Server is now fully ready.")

    yield

    logger.info("Server shutting down.")
    _ready_event.clear()


def create_app() -> FastAPI:
    app = FastAPI(
        title="AI Assistant Local API",
        description="Backend API for Multimodal AI Assistant (Electron UI)",
        version="1.0.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(chat.router)
    app.include_router(sessions.router)
    app.include_router(personas.router)
    app.include_router(tts_router.router)
    app.include_router(asr_router.router)
    return app

app = create_app()


@app.get("/api/ready")
def api_ready():
    """
    Lightweight readiness probe polled by the Electron frontend on startup.
    Returns ready=true only after the full lifespan startup (TTS load) completes.
    Because the lifespan blocks uvicorn from accepting requests until startup
    finishes, _ready_event is always set by the time any request reaches here.
    The explicit flag is kept for clarity and future extensibility.
    """
    return {"ready": _ready_event is not None and _ready_event.is_set()}
