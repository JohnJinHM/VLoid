from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from api.database import get_db, ChatSessionDB, ChatMessageDB
from api.schemas.chat_schema import ChatRequest
from api.services.llm_service import LLMService

router = APIRouter(prefix="/api/chat", tags=["Chat"])
llm_service = LLMService() 

def save_message_to_db(db: Session, session_id: str, role: str, content: str, parent_id: int = None, title: str = "New Chat"):
    # 1. 检查 Session 是否存在，不存在则创建
    db_session = db.query(ChatSessionDB).filter(ChatSessionDB.id == session_id).first()
    if not db_session:
        db_session = ChatSessionDB(id=session_id, title=title)
        db.add(db_session)
        db.commit()
    
    # 2. 插入新消息并绑定 parent_id
    new_msg = ChatMessageDB(session_id=session_id, role=role, content=content, parent_id=parent_id)
    db.add(new_msg)
    db.commit()
    db.refresh(new_msg) # 获取数据库自动生成的自增 id
    
    # 3. 更新该会话的当前节点指针到最新消息
    db_session.current_node_id = new_msg.id
    db.commit()
    
    return new_msg

@router.post("/stream")
async def chat_stream(request: ChatRequest, db: Session = Depends(get_db)):
    user_msg = request.messages[-1]
    
    # 1. 保存用户的最新发言，将其挂载到前端传来的 parent_id 下
    user_db_msg = save_message_to_db(
        db, request.session_id, user_msg.role, user_msg.content, parent_id=request.parent_id
    )

    # 2. 提前为 AI 的回复创建一个数据库条目（内容暂时为空），并将其挂载到刚才用户的消息下
    # 这样可以在生成期间就确立父子关系，并更新 current_node_id
    ai_db_msg = save_message_to_db(
        db, request.session_id, "assistant", "", parent_id=user_db_msg.id
    )

    # 3. 拦截并包装原有的流式生成器
    async def stream_and_save():
        full_response = ""
        # 调用底层服务生成内容
        async for chunk in llm_service.generate_chat_stream(request):
            yield chunk
            
            # 解析 chunk 提取文本内容用于持久化
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
        
        # 4. 流式传输完全结束后，更新刚才预创建的 AI 消息内容
        ai_db_msg.content = full_response
        db.commit()

    return StreamingResponse(stream_and_save(), media_type="text/event-stream")