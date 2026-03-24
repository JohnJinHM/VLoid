import os
from sqlalchemy import create_engine, Column, String, Integer, Text, ForeignKey, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
from datetime import datetime

# 数据库文件保存在根目录
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "chat_history.db")
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class ChatSessionDB(Base):
    __tablename__ = "chat_sessions"

    id = Column(String, primary_key=True, index=True) # 对应前端的 session_id
    title = Column(String, default="New Chat")
    created_at = Column(DateTime, default=datetime.utcnow)
    
    # 建立与 Message 的级联关联
    messages = relationship("ChatMessageDB", back_populates="session", cascade="all, delete-orphan")

class ChatMessageDB(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("chat_sessions.id"))
    role = Column(String) # 'user', 'assistant', 'system'
    content = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)

    session = relationship("ChatSessionDB", back_populates="messages")

# 初始化创建表
Base.metadata.create_all(bind=engine)

# 获取数据库会话的依赖函数 (供 FastAPI 路由使用)
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()