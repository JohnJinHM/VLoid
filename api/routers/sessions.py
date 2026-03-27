from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from api.database import get_db, ChatSessionDB, ChatMessageDB
from api.schemas.chat_schema import SessionInfo, MessageInfo

router = APIRouter(prefix="/api/sessions", tags=["Sessions"])

@router.get("/", response_model=List[SessionInfo])
def get_all_sessions(db: Session = Depends(get_db)):
    """获取所有历史会话列表，按时间倒序排列"""
    sessions = db.query(ChatSessionDB).order_by(ChatSessionDB.created_at.desc()).all()
    return sessions

@router.get("/{session_id}/messages", response_model=List[MessageInfo])
def get_session_messages(session_id: str, db: Session = Depends(get_db)):
    """获取指定会话的所有历史消息"""
    messages = db.query(ChatMessageDB).filter(ChatMessageDB.session_id == session_id).order_by(ChatMessageDB.created_at.asc()).all()
    return messages

@router.delete("/{session_id}")
def delete_session(session_id: str, db: Session = Depends(get_db)):
    """删除指定的历史会话及其所有消息"""
    db_session = db.query(ChatSessionDB).filter(ChatSessionDB.id == session_id).first()
    if not db_session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    db.delete(db_session)
    db.commit()
    return {"status": "success", "deleted_id": session_id}