from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from api.database import get_db, PersonaDB
from pydantic import BaseModel
import json

router = APIRouter(prefix="/api/personas", tags=["Personas"])

class PersonaSchema(BaseModel):
    id: str # 前端生成的临时ID或数据库ID
    name: str
    description: str
    rules: List[str]

@router.get("/")
def get_all_personas(db: Session = Depends(get_db)):
    personas = db.query(PersonaDB).all()
    result = []
    for p in personas:
        result.append({
            "id": str(p.id),
            "name": p.name,
            "description": p.description,
            "rules": json.loads(p.rules) if p.rules else []
        })
    return result

@router.post("/")
def save_persona(persona: PersonaSchema, db: Session = Depends(get_db)):
    # 如果传来的 id 是数字形式（已存在的），则更新；如果是字符串（如 persona_123），则新建
    db_persona = None
    if persona.id.isdigit():
        db_persona = db.query(PersonaDB).filter(PersonaDB.id == int(persona.id)).first()
    
    rules_json = json.dumps(persona.rules)
    
    if db_persona:
        db_persona.name = persona.name
        db_persona.description = persona.description
        db_persona.rules = rules_json
    else:
        db_persona = PersonaDB(
            name=persona.name, 
            description=persona.description, 
            rules=rules_json
        )
        db.add(db_persona)
        
    db.commit()
    db.refresh(db_persona)
    
    return {"status": "success", "id": str(db_persona.id)}

@router.delete("/{persona_id}")
def delete_persona(persona_id: int, db: Session = Depends(get_db)):
    db_persona = db.query(PersonaDB).filter(PersonaDB.id == persona_id).first()
    if not db_persona:
        raise HTTPException(status_code=404, detail="Persona not found")
    db.delete(db_persona)
    db.commit()
    return {"status": "success"}