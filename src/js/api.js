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
        return res.json();
    },
    async savePersona(personaData) {
        const res = await fetch(`${API_BASE}/api/personas/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(personaData)
        });
        return res.json();
    },
    async deletePersona(personaId) {
        const res = await fetch(`${API_BASE}/api/personas/${personaId}`, {
            method: 'DELETE'
        });
        return res.json();
    }
};