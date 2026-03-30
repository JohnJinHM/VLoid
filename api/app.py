import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api.routers import chat, personas, sessions
from api.routers import tts as tts_router
from api.services.tts_service import init_tts_service
from core.logger import get_logger

logger = get_logger("App")


async def preload_tts(svc):
    """Load the VoiceDesign model weights in a thread pool at startup."""
    try:
        svc = init_tts_service()
        logger.info("TTS VoiceDesign model preloaded successfully.")
    except Exception as e:
        logger.error(f"TTS preload failed: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    svc = init_tts_service()
    # Kick off model loading immediately without blocking API startup
    asyncio.create_task(preload_tts(svc))
    logger.info("TTS model preload started in background.")
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="AI Assistant Local API",
        description="Backend API for Multimodal AI Assistant (Electron UI)",
        version="1.0.0",
        lifespan=lifespan,
    )

    # 允许 Electron 跨域请求
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 注册路由
    app.include_router(chat.router)
    app.include_router(sessions.router)
    app.include_router(personas.router)
    app.include_router(tts_router.router)
    return app

app = create_app()
