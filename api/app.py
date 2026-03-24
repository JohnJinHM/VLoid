from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api.routers import chat

def create_app() -> FastAPI:
    app = FastAPI(
        title="AI Assistant Local API",
        description="Backend API for Multimodal AI Assistant (Electron UI)",
        version="1.0.0"
    )

    # 允许 Electron 跨域请求
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"], # 生产环境建议指定具体的前端地址
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 注册路由
    app.include_router(chat.router)
    
    return app

app = create_app()