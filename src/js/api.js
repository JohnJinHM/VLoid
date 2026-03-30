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
    // 流式对话请求
    async chatStream(payload, signal) {
        return fetch(`${API_BASE}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: signal
        });
    },

    async getPersonas() {
        const res = await fetch(`${API_BASE}/api/personas/`);
        const personas = await res.json();
        // Map snake_case API response → camelCase frontend model
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
                refAudioPath: '',
                refAudioData: p.tts_voice_clone?.ref_audio || null,
                refText: p.tts_voice_clone?.ref_text || '',
                language: p.tts_voice_clone?.language || 'auto',
            },
        }));
    },
    async savePersona(personaData) {
        // Map camelCase frontend model → snake_case API payload
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
                ref_audio: personaData.ttsVoiceClone?.refAudioData || '',
                ref_text: personaData.ttsVoiceClone?.refText || '',
                language: personaData.ttsVoiceClone?.language || 'auto',
            },
        };
        const res = await fetch(`${API_BASE}/api/personas/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return res.json();
    },
    async deletePersona(personaId) {
        const res = await fetch(`${API_BASE}/api/personas/${personaId}`, {
            method: 'DELETE'
        });
        return res.json();
    },

    /**
     * TTS via VoiceDesign mode — returns the streaming fetch Response.
     * Frame format: [4-byte uint32 BE length][WAV bytes] repeated per sentence.
     * payload: { text, language, instruct }
     */
    async ttsVoiceDesignStream(payload) {
        return fetch(`${API_BASE}/api/tts/voice-design/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    },

    /**
     * TTS via Voice Clone mode — returns the streaming fetch Response.
     * Frame format: [4-byte uint32 BE length][WAV bytes] repeated per sentence.
     * payload: { text, language, ref_audio, ref_text }
     */
    async ttsVoiceCloneStream(payload) {
        return fetch(`${API_BASE}/api/tts/voice-clone/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    },

    /**
     * Upload reference audio for voice clone.
     * Returns: { ref_audio: "<base64>", filename: "..." }
     */
    async uploadRefAudio(formData) {
        const res = await fetch(`${API_BASE}/api/tts/upload-ref-audio`, {
            method: 'POST',
            body: formData
        });
        return res.json();
    }
};