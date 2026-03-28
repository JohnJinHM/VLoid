from pydantic import BaseModel, ConfigDict, Field
from typing import List, Optional, Dict, Any
from datetime import datetime

class Message(BaseModel):
    role: str # 'system', 'user', 'assistant'
    content: str

class ChatRequest(BaseModel):
    session_id: str = Field(..., description="用于区分多个对话标签页")
    messages: List[Message]
    
    # 【新增】指示当前用户消息挂载在哪个父节点下。如果不传，则作为全新的根节点。
    parent_id: Optional[int] = None 
    
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
    
class SessionInfo(BaseModel):
    id: str
    title: str
    created_at: datetime
    # 【新增】返回当前会话的最新叶子节点
    current_node_id: Optional[int] = None 
    
    model_config = ConfigDict(from_attributes=True) 

class MessageInfo(BaseModel):
    # 【新增】返回 ID 信息，供前端构建 messagesMap 字典和多叉树
    id: int
    parent_id: Optional[int] = None
    role: str
    content: str
    created_at: datetime
    
    model_config = ConfigDict(from_attributes=True)