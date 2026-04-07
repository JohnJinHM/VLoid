const API_BASE = "http://127.0.0.1:3000";

export const api = {
    async getSessions() {
        const res = await fetch(`${API_BASE}/api/sessions/`);
        return res.json();
    },
    async getMessages(sessionId) {
        const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`);
        return res.json();
    },
    async deleteSession(sessionId) {
        const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`, { method: 'DELETE' });
        return res.json();
    },
    async chatStream(payload, signal) {
        return fetch(`${API_BASE}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
        });
    },

    async getPersonas() {
        const res = await fetch(`${API_BASE}/api/personas/`);
        const personas = await res.json();
        return personas.map(p => ({
            id:          p.id,
            name:        p.name,
            identity:    p.identity  || '',
            language:    p.language  || 'en',
            description: p.description,
            rules:       p.rules,
            ttsMode: p.tts_mode || 'voice_design',
            ttsVoiceDesign: {
                instruct:   p.tts_voice_design?.instruct   || '',
                language:   p.tts_voice_design?.language   || 'auto',
                splitMode:  p.tts_voice_design?.split_mode || 'sentence',
            },
            ttsVoiceClone: {
                // Each entry: { id, filename, path, refText, selected, exists }
                refAudios: (p.tts_voice_clone?.ref_audios || []).map(a => ({
                    id:       a.id,
                    filename: a.filename,
                    path:     a.path,
                    refText:  a.ref_text || '',
                    selected: a.selected || false,
                    exists:   a.exists !== false,
                })),
                language:    p.tts_voice_clone?.language    || 'auto',
                splitChars:  p.tts_voice_clone?.split_chars ?? 0,
            },
        }));
    },

    async savePersona(personaData) {
        const payload = {
            id:          personaData.id,
            name:        personaData.name,
            identity:    personaData.identity    || '',
            language:    personaData.language    || 'en',
            description: personaData.description,
            rules:       personaData.rules,
            tts_mode: personaData.ttsMode || 'voice_design',
            tts_voice_design: {
                instruct:   personaData.ttsVoiceDesign?.instruct   || '',
                language:   personaData.ttsVoiceDesign?.language   || 'auto',
                split_mode: personaData.ttsVoiceDesign?.splitMode  || 'sentence',
            },
            tts_voice_clone: {
                ref_audios: (personaData.ttsVoiceClone?.refAudios || []).map(a => ({
                    id:       a.id,
                    filename: a.filename,
                    path:     a.path,
                    ref_text: a.refText || '',
                    selected: a.selected || false,
                })),
                language:    personaData.ttsVoiceClone?.language    || 'auto',
                split_chars: personaData.ttsVoiceClone?.splitChars  ?? 0,
            },
        };
        const res = await fetch(`${API_BASE}/api/personas/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return res.json();
    },

    async deletePersona(personaId) {
        const res = await fetch(`${API_BASE}/api/personas/${personaId}`, { method: 'DELETE' });
        return res.json();
    },

    /**
     * Unified TTS streaming endpoint — returns a fetch Response with raw float32 PCM.
     * Wire format: 12-byte header (b'PCM\0' + uint32 BE sr + uint32 BE ch),
     *              then [uint32 BE len][float32 LE PCM bytes] per frame.
     *
     * The server dispatches to voice_design or voice_clone based on the loaded model.
     * payload: { text, language, instruct?, ref_audio_path?, ref_text? }
     */
    async ttsStream(payload, signal = null) {
        return fetch(`${API_BASE}/api/tts/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            ...(signal ? { signal } : {}),
        });
    },

    /** Returns { loaded, model_type, device } from the TTS service. */
    async getTTSStatus() {
        const res = await fetch(`${API_BASE}/api/tts/status`);
        return res.json();
    },

    /** Returns { loaded, model, vad_model, device } from the ASR service. */
    async getASRStatus() {
        const res = await fetch(`${API_BASE}/api/asr/status`);
        return res.json();
    },
};
