import json
import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional

from api.database import get_db, PersonaDB
from pydantic import BaseModel

router = APIRouter(prefix="/api/personas", tags=["Personas"])


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------

class TTSVoiceDesign(BaseModel):
    instruct: str = ""
    language: str = "Auto"


class RefAudioEntry(BaseModel):
    id: str
    filename: str
    path: str          # Relative path from project root: data/ref_audio/<uuid>.<ext>
    ref_text: str = ""
    selected: bool = False


class TTSVoiceClone(BaseModel):
    ref_audios: List[RefAudioEntry] = []
    language: str = "Auto"


class PersonaSchema(BaseModel):
    id: str
    name: str
    description: str
    rules: List[str]
    tts_mode: Optional[str] = "voice_design"
    tts_voice_design: Optional[TTSVoiceDesign] = None
    tts_voice_clone: Optional[TTSVoiceClone] = None


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _check_audio_exists(path: str) -> bool:
    """
    Check whether the reference audio file still exists.
    *path* is now an absolute OS path stored by the Electron client.
    """
    return bool(path) and os.path.isfile(path)


def _row_to_dict(p: PersonaDB) -> dict:
    # Parse the ref_audios JSON list; annotate each entry with exists flag
    try:
        ref_audios_raw = json.loads(p.tts_ref_audios or "[]")
    except (json.JSONDecodeError, TypeError):
        ref_audios_raw = []

    ref_audios = []
    for entry in ref_audios_raw:
        entry["exists"] = _check_audio_exists(entry.get("path", ""))
        ref_audios.append(entry)

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
            "ref_audios": ref_audios,
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

    tts_mode = persona.tts_mode or "voice_design"

    if tts_mode == "voice_design" and persona.tts_voice_design:
        tts_instruct = persona.tts_voice_design.instruct
        tts_language = persona.tts_voice_design.language
        tts_ref_audios = "[]"
    elif tts_mode == "voice_clone" and persona.tts_voice_clone:
        tts_instruct = ""
        tts_language = persona.tts_voice_clone.language
        # Serialise list; strip runtime-only 'exists' field before storing
        entries = []
        for e in persona.tts_voice_clone.ref_audios:
            entries.append({
                "id":       e.id,
                "filename": e.filename,
                "path":     e.path,
                "ref_text": e.ref_text,
                "selected": e.selected,
            })
        tts_ref_audios = json.dumps(entries)
    else:
        tts_instruct   = ""
        tts_language   = "Auto"
        tts_ref_audios = "[]"

    rules_json = json.dumps(persona.rules)

    if db_persona:
        db_persona.name          = persona.name
        db_persona.description   = persona.description
        db_persona.rules         = rules_json
        db_persona.tts_mode      = tts_mode
        db_persona.tts_instruct  = tts_instruct
        db_persona.tts_language  = tts_language
        db_persona.tts_ref_audios = tts_ref_audios
    else:
        db_persona = PersonaDB(
            name=persona.name,
            description=persona.description,
            rules=rules_json,
            tts_mode=tts_mode,
            tts_instruct=tts_instruct,
            tts_language=tts_language,
            tts_ref_audios=tts_ref_audios,
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
