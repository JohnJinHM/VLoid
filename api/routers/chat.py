from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from api.database import get_db, ChatSessionDB, ChatMessageDB
from api.schemas.chat_schema import ChatRequest, ChatResponse, Message
from api.services.llm_service import LLMService


router = APIRouter(prefix="/api/chat", tags=["Chat"])
llm_service = LLMService() # 后期可以通过依赖注入管理

def save_message_to_db(db: Session, session_id: str, role: str, content: str, title: str = "New Chat"):
    # 1. 检查 Session 是否存在，不存在则创建
    db_session = db.query(ChatSessionDB).filter(ChatSessionDB.id == session_id).first()
    if not db_session:
        db_session = ChatSessionDB(id=session_id, title=title)
        db.add(db_session)
        db.commit()
    
    # 2. 插入新消息
    new_msg = ChatMessageDB(session_id=session_id, role=role, content=content)
    db.add(new_msg)
    db.commit()

@router.post("/stream")
async def chat_stream(request: ChatRequest, db: Session = Depends(get_db)):
    # 1. 收到请求时，立刻保存用户的最新发言
    # (假设 request.messages 的最后一条是用户刚发的话)
    user_msg = request.messages[-1]
    save_message_to_db(db, request.session_id, user_msg.role, user_msg.content)

    # 2. 拦截并包装原有的流式生成器
    async def stream_and_save():
        full_response = ""
        # 调用底层服务生成内容
        async for chunk in llm_service.generate_chat_stream(request):
            yield chunk
            
            # 解析 chunk 提取文本内容用于持久化 (需根据你的 SSE 格式微调)
            if chunk.startswith("data: "):
                data_str = chunk[6:].strip()
                if data_str != "[DONE]":
                    import json
                    try:
                        data_obj = json.loads(data_str)
                        delta = data_obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                        full_response += delta
                    except:
                        pass
        
        # 3. 流式传输完全结束后，将 AI 的完整回复存入数据库
        save_message_to_db(db, request.session_id, "assistant", full_response)

    return StreamingResponse(stream_and_save(), media_type="text/event-stream")