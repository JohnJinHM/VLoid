from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any

class Message(BaseModel):
    role: str # 'system', 'user', 'assistant'
    content: str

class ChatRequest(BaseModel):
    session_id: str = Field(..., description="用于区分多个对话标签页")
    messages: List[Message]
    
    # 生成参数管理
    temperature: Optional[float] = 0.7
    top_p: Optional[float] = 0.9
    max_tokens: Optional[int] = 2048
    repetition_penalty: Optional[float] = 1.1
    
    # 预留给后续功能的参数
    use_rag: Optional[bool] = False
    persona_id: Optional[str] = "default" 

class ChatResponse(BaseModel):
    session_id: str
    message: Message
    usage: Optional[Dict[str, int]] = None