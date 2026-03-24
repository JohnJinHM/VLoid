from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from api.schemas.chat_schema import ChatRequest, ChatResponse, Message
from api.services.llm_service import LLMService

router = APIRouter(prefix="/api/chat", tags=["Chat"])
llm_service = LLMService() # 后期可以通过依赖注入管理

@router.post("/completions", response_model=ChatResponse)
async def chat_completions(request: ChatRequest):
    """标准（非流式）回复接口"""
    try:
        result = await llm_service.generate_chat_completion(request)
        reply = result['choices'][0]['message']['content']
        
        return ChatResponse(
            session_id=request.session_id,
            message=Message(role="assistant", content=reply),
            usage=result.get("usage")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/stream")
async def chat_stream(request: ChatRequest):
    """流式回复接口，Electron 前端应使用 SSE (Server-Sent Events) 接收"""
    try:
        return StreamingResponse(
            llm_service.generate_chat_stream(request), 
            media_type="text/event-stream"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))