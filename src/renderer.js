import { initSessionManager, fetchAndRenderSessions } from './js/components/SessionManager.js';
import { initChatController } from './js/components/ChatController.js';
import { initPersonaManager } from './js/components/PersonaEditor.js';
import { initSettingsPanel } from './js/components/SettingsPanel.js';
import { initAudioSettings } from './js/components/AudioSettings.js';

const { ipcRenderer } = require('electron');

const API_READY_URL = 'http://127.0.0.1:3000/api/ready';
const POLL_INTERVAL_MS = 1000;

/**
 * Poll GET /api/ready until the backend signals it is fully initialised
 * (TTS model loaded, all routers registered).  Resolves as soon as the
 * endpoint returns { ready: true }.
 */
async function waitForBackend() {
    while (true) {
        try {
            const res = await fetch(API_READY_URL);
            if (res.ok) {
                const data = await res.json();
                if (data.ready) return;
            }
        } catch (_) {
            // Backend not up yet — keep polling
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await waitForBackend();

    // Tell the main process to show the window now that the backend is ready
    ipcRenderer.send('backend-ready');

    initSessionManager();
    initChatController();
    initPersonaManager();
    initSettingsPanel();
    initAudioSettings();

    await fetchAndRenderSessions();
});