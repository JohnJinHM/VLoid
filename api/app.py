import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api.routers import chat, personas, sessions
from api.routers import tts as tts_router
from api.services.tts_service import init_tts_service
from core.logger import get_logger

logger = get_logger("App")

# Set once in lifespan after all startup tasks complete.
# The Electron frontend polls GET /api/ready and shows its window when this fires.
_ready_event: asyncio.Event | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    """
    Startup: block until the TTS VoiceDesign model is fully loaded, then set
    _ready_event so the Electron frontend knows it can show its window.
    Shutdown: log teardown (individual services clean up their own resources).
    """
    global _ready_event
    _ready_event = asyncio.Event()

    logger.info("Loading TTS VoiceDesign model — server will be ready once loading completes…")
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, init_tts_service)

    _ready_event.set()
    logger.info("TTS model loaded. Server is now fully ready.")

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
