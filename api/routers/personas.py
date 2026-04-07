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

class Rule(BaseModel):
    text: str = ""
    enabled: bool = True


class TTSVoiceDesign(BaseModel):
    instruct: str = ""
    language: str = "Auto"
    split_mode: str = "sentence"   # sentence | punctuation | paragraph | whole


class RefAudioEntry(BaseModel):
    id: str
    filename: str
    path: str          # Absolute OS path stored by the Electron client
    ref_text: str = ""
    selected: bool = False


class TTSVoiceClone(BaseModel):
    ref_audios: List[RefAudioEntry] = []
    language: str = "Auto"
    split_chars: int = 0           # min chars before a sentence boundary triggers a new chunk


class PersonaSchema(BaseModel):
    id: str
    name: str
    identity: str = ""             # one-sentence tagline after the name
    language: str = "en"           # prompt framing language: en | zh | ja
    description: str = ""
    rules: List[Rule] = []
    tts_mode: Optional[str] = "voice_design"
    tts_voice_design: Optional[TTSVoiceDesign] = None
    tts_voice_clone: Optional[TTSVoiceClone] = None


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _check_audio_exists(path: str) -> bool:
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

    # rules are stored as [{text, enabled}]; migrate old string[] transparently
    try:
        rules_raw = json.loads(p.rules) if p.rules else []
    except (json.JSONDecodeError, TypeError):
        rules_raw = []

    rules = [
        r if isinstance(r, dict) else {"text": r, "enabled": True}
        for r in rules_raw
    ]

    return {
        "id":          str(p.id),
        "name":        p.name,
        "identity":    p.identity  or "",
        "language":    p.language  or "en",
        "description": p.description or "",
        "rules":       rules,
        "tts_mode":    p.tts_mode or "voice_design",
        "tts_voice_design": {
            "instruct":   p.tts_instruct     or "",
            "language":   p.tts_language     or "Auto",
            "split_mode": p.tts_vd_split_mode or "sentence",
        },
        "tts_voice_clone": {
            "ref_audios":  ref_audios,
            "language":    p.tts_vc_language  or "Auto",
            "split_chars": p.tts_vc_split_chars or 0,
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

    vd = persona.tts_voice_design or TTSVoiceDesign()
    vc = persona.tts_voice_clone  or TTSVoiceClone()

    # Serialise ref_audios; strip runtime-only 'exists' field before storing
    ref_audio_entries = [
        {
            "id":       e.id,
            "filename": e.filename,
            "path":     e.path,
            "ref_text": e.ref_text,
            "selected": e.selected,
        }
        for e in vc.ref_audios
    ]

    # Serialise rules as [{text, enabled}] objects
    rules_json = json.dumps([{"text": r.text, "enabled": r.enabled} for r in persona.rules])

    fields = dict(
        name=persona.name,
        identity=persona.identity,
        language=persona.language,
        description=persona.description,
        rules=rules_json,
        tts_mode=tts_mode,
        tts_instruct=vd.instruct,
        tts_language=vd.language,
        tts_vd_split_mode=vd.split_mode,
        tts_vc_language=vc.language,
        tts_vc_split_chars=vc.split_chars,
        tts_ref_audios=json.dumps(ref_audio_entries),
    )

    if db_persona:
        for k, v in fields.items():
            setattr(db_persona, k, v)
    else:
        db_persona = PersonaDB(**fields)
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
