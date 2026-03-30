from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional
from api.database import get_db, PersonaDB
from pydantic import BaseModel
import json

router = APIRouter(prefix="/api/personas", tags=["Personas"])


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------

class TTSVoiceDesign(BaseModel):
    instruct: str = ""
    language: str = "Auto"


class TTSVoiceClone(BaseModel):
    ref_audio: str = ""     # base64-encoded audio
    ref_text: str = ""
    language: str = "Auto"


class PersonaSchema(BaseModel):
    id: str                     # frontend temp-id or DB integer as string
    name: str
    description: str
    rules: List[str]
    tts_mode: Optional[str] = "voice_design"            # "voice_design" | "voice_clone"
    tts_voice_design: Optional[TTSVoiceDesign] = None
    tts_voice_clone: Optional[TTSVoiceClone] = None


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _row_to_dict(p: PersonaDB) -> dict:
    return {
        "id": str(p.id),
        "name": p.name,
        "description": p.description,
        "rules": json.loads(p.rules) if p.rules else [],
        "tts_mode": p.tts_mode or "voice_design",
        "tts_voice_design": {
            "instruct": p.tts_instruct or "",
            "language": p.tts_language or "Auto",
        },
        "tts_voice_clone": {
            "ref_audio": p.tts_ref_audio or "",
            "ref_text": p.tts_ref_text or "",
            "language": p.tts_language or "Auto",
        },
    }


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.get("/")
def get_all_personas(db: Session = Depends(get_db)):
    return [_row_to_dict(p) for p in db.query(PersonaDB).all()]


@router.post("/")
def save_persona(persona: PersonaSchema, db: Session = Depends(get_db)):
    db_persona = None
    if persona.id.isdigit():
        db_persona = db.query(PersonaDB).filter(PersonaDB.id == int(persona.id)).first()

    # Flatten TTS sub-objects
    tts_mode = persona.tts_mode or "voice_design"
    if tts_mode == "voice_design" and persona.tts_voice_design:
        tts_instruct = persona.tts_voice_design.instruct
        tts_language = persona.tts_voice_design.language
        tts_ref_audio = ""
        tts_ref_text = ""
    elif tts_mode == "voice_clone" and persona.tts_voice_clone:
        tts_instruct = ""
        tts_language = persona.tts_voice_clone.language
        tts_ref_audio = persona.tts_voice_clone.ref_audio
        tts_ref_text = persona.tts_voice_clone.ref_text
    else:
        tts_instruct = ""
        tts_language = "Auto"
        tts_ref_audio = ""
        tts_ref_text = ""

    rules_json = json.dumps(persona.rules)

    if db_persona:
        db_persona.name = persona.name
        db_persona.description = persona.description
        db_persona.rules = rules_json
        db_persona.tts_mode = tts_mode
        db_persona.tts_instruct = tts_instruct
        db_persona.tts_language = tts_language
        db_persona.tts_ref_audio = tts_ref_audio
        db_persona.tts_ref_text = tts_ref_text
    else:
        db_persona = PersonaDB(
            name=persona.name,
            description=persona.description,
            rules=rules_json,
            tts_mode=tts_mode,
            tts_instruct=tts_instruct,
            tts_language=tts_language,
            tts_ref_audio=tts_ref_audio,
            tts_ref_text=tts_ref_text,
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
