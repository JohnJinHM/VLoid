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
            id: p.id,
            name: p.name,
            description: p.description,
            rules: p.rules,
            ttsMode: p.tts_mode || 'voice_design',
            ttsVoiceDesign: {
                instruct: p.tts_voice_design?.instruct || '',
                language: p.tts_voice_design?.language || 'auto',
            },
            ttsVoiceClone: {
                // Each entry: { id, filename, path, refText, selected, exists }
                refAudios: (p.tts_voice_clone?.ref_audios || []).map(a => ({
                    id:       a.id,
                    filename: a.filename,
                    path:     a.path,
                    refText:  a.ref_text || '',
                    selected: a.selected || false,
                    exists:   a.exists !== false,   // default true if not reported
                })),
                language: p.tts_voice_clone?.language || 'auto',
            },
        }));
    },

    async savePersona(personaData) {
        const payload = {
            id: personaData.id,
            name: personaData.name,
            description: personaData.description,
            rules: personaData.rules,
            tts_mode: personaData.ttsMode || 'voice_design',
            tts_voice_design: {
                instruct: personaData.ttsVoiceDesign?.instruct || '',
                language: personaData.ttsVoiceDesign?.language || 'auto',
            },
            tts_voice_clone: {
                ref_audios: (personaData.ttsVoiceClone?.refAudios || []).map(a => ({
                    id:       a.id,
                    filename: a.filename,
                    path:     a.path,
                    ref_text: a.refText || '',
                    selected: a.selected || false,
                })),
                language: personaData.ttsVoiceClone?.language || 'auto',
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
     * Upload a reference audio file to the server.
     * Returns: { id, filename, path, url }
     * The `path` is stored in the persona; `url` can be used for <audio> preview.
     */
    async uploadRefAudio(formData) {
        const res = await fetch(`${API_BASE}/api/tts/upload-ref-audio`, {
            method: 'POST',
            body: formData,
        });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        return res.json();
    },

    /**
     * Delete a stored reference audio file from the server.
     * audioFilename: the UUID-based filename (e.g. "abc123.wav")
     */
    async deleteRefAudio(audioFilename) {
        const res = await fetch(`${API_BASE}/api/tts/ref-audio/${audioFilename}`, {
            method: 'DELETE',
        });
        return res.json();
    },

    /**
     * TTS via VoiceDesign mode — returns a streaming fetch Response.
     * Frame format: [4-byte uint32 BE length][WAV bytes] repeated per sentence.
     * payload: { text, language, instruct }
     */
    async ttsVoiceDesignStream(payload) {
        return fetch(`${API_BASE}/api/tts/voice-design/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    },

    /**
     * TTS via Voice Clone mode — returns a streaming fetch Response.
     * Frame format: [4-byte uint32 BE length][WAV bytes] repeated per sentence.
     * payload: { text, language, ref_audio_path, ref_text }
     */
    async ttsVoiceCloneStream(payload) {
        return fetch(`${API_BASE}/api/tts/voice-clone/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    },
};
