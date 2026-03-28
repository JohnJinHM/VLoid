import os
from sqlalchemy import create_engine, Column, String, Integer, Text, ForeignKey, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker, relationship, backref
from datetime import datetime, timezone

# 数据库文件保存在根目录
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "chat_history.db")
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class ChatSessionDB(Base):
    __tablename__ = "chat_sessions"
    id = Column(String, primary_key=True, index=True) 
    title = Column(String, default="New Chat")
    created_at = Column(DateTime, default=datetime.now(timezone.utc))
    
    # 记录该会话当前所处的“叶子节点”(leaf node)，便于每次打开时直接恢复最新分支
    current_node_id = Column(Integer, nullable=True) 
    
    messages = relationship("ChatMessageDB", back_populates="session", cascade="all, delete-orphan")
    
class ChatMessageDB(Base):
    __tablename__ = "chat_messages"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("chat_sessions.id"))
    
    # 【核心修改】引入 parent_id 构建对话树
    parent_id = Column(Integer, ForeignKey("chat_messages.id"), nullable=True)
    
    role = Column(String) 
    content = Column(Text)
    created_at = Column(DateTime, default=datetime.now(timezone.utc))

    session = relationship("ChatSessionDB", back_populates="messages")
    # 自引用关系，方便查询子节点
    children = relationship("ChatMessageDB", backref=backref("parent", remote_side=[id]))

class PersonaDB(Base):
    __tablename__ = "personas"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, default="New Persona")
    description = Column(Text)
    rules = Column(Text) # 将规则数组序列化为 JSON 字符串存储
    created_at = Column(DateTime, default=datetime.now(timezone.utc))


Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()