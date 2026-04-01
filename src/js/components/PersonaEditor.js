import { CharacterCard } from "https://esm.run/@lenml/char-card-reader";
import { state } from '../store.js';
import { api } from '../api.js';

// Electron 32+ removed file.path; use webUtils.getPathForFile instead.
const { webUtils } = require('electron');

// 视图与导航
const chatView     = document.getElementById('chat-view');
const personaView  = document.getElementById('persona-view');
const settingsView = document.getElementById('settings-view');
const navChatBtn     = document.getElementById('nav-chat-btn');
const navPersonaBtn  = document.getElementById('nav-persona-btn');
const navSettingsBtn = document.getElementById('nav-settings-btn');

// 列表与表单
const personaListEl   = document.getElementById('persona-list');
const newPersonaBtn   = document.getElementById('new-persona-btn');
const personaNameInput = document.getElementById('persona-name');
const personaDescInput = document.getElementById('persona-desc');
const rulesContainer  = document.getElementById('rules-container');
const addRuleBtn      = document.getElementById('add-rule-btn');

// 同步与操作
const sysPromptInput      = document.getElementById('sys-prompt');
const currentPersonaBadge = document.getElementById('current-persona-badge');
const saveBtn   = document.getElementById('save-persona-btn');
const resetBtn  = document.getElementById('reset-persona-btn');
const deleteBtn = document.getElementById('delete-persona-btn');

// TTS DOM 元素
const voiceDesignSection  = document.getElementById('voice-design-section');
const voiceCloneSection   = document.getElementById('voice-clone-section');
const vdInstructInput     = document.getElementById('vd-instruct');
const vdLanguageSelect    = document.getElementById('vd-language');
const vdSplitModeSelect   = document.getElementById('vd-split-mode');
const vcLanguageSelect    = document.getElementById('vc-language');
const vcSplitCharsSlider  = document.getElementById('vc-split-chars');
const vcSplitCharsVal     = document.getElementById('vc-split-chars-val');
const vcAudioUploadBtn    = document.getElementById('vc-audio-upload-btn');
const vcAudioFileInput    = document.getElementById('vc-audio-file');
const vcAudioList         = document.getElementById('vc-audio-list');

let savedPersonasData = {};

export async function initPersonaManager() {
    await loadPersonasFromDB();

    navChatBtn.addEventListener('click',     () => switchView('chat'));
    navPersonaBtn.addEventListener('click',  () => switchView('persona'));
    navSettingsBtn.addEventListener('click', () => switchView('settings'));
    newPersonaBtn.addEventListener('click',  createNewPersona);

    personaNameInput.addEventListener('input', (e) => updateDraft('name', e.target.value));
    personaDescInput.addEventListener('input', (e) => updateDraft('description', e.target.value));

    addRuleBtn.addEventListener('click', () => {
        const p = state.personasData[state.currentPersonaId];
        if (p) { p.rules.push(""); renderRules(p); updateDraft('rules', p.rules); }
    });

    rulesContainer.addEventListener('input', (e) => {
        if (e.target.classList.contains('rule-input')) {
            const p = state.personasData[state.currentPersonaId];
            p.rules[e.target.dataset.index] = e.target.value;
            updateDraft('rules', p.rules);
        }
    });

    rulesContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.delete-rule-btn');
        if (btn) {
            const p = state.personasData[state.currentPersonaId];
            p.rules.splice(parseInt(btn.dataset.index, 10), 1);
            renderRules(p);
            updateDraft('rules', p.rules);
        }
    });

    saveBtn.addEventListener('click',   handleSave);
    resetBtn.addEventListener('click',  handleReset);
    deleteBtn.addEventListener('click', handleDelete);

    initTTSEvents();
}

// ============== TTS 事件 ==============

function initTTSEvents() {
    vdInstructInput.addEventListener('input', (e) => {
        const p = state.personasData[state.currentPersonaId];
        if (p?.ttsVoiceDesign) { p.ttsVoiceDesign.instruct = e.target.value; markUnsaved(); }
    });

    vdLanguageSelect.addEventListener('change', (e) => {
        const p = state.personasData[state.currentPersonaId];
        if (p?.ttsVoiceDesign) { p.ttsVoiceDesign.language = e.target.value; markUnsaved(); }
    });

    vdSplitModeSelect.addEventListener('change', (e) => {
        const p = state.personasData[state.currentPersonaId];
        if (p?.ttsVoiceDesign) { p.ttsVoiceDesign.splitMode = e.target.value; markUnsaved(); }
    });

    vcLanguageSelect.addEventListener('change', (e) => {
        const p = state.personasData[state.currentPersonaId];
        if (p?.ttsVoiceClone) { p.ttsVoiceClone.language = e.target.value; markUnsaved(); }
    });

    vcSplitCharsSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10) || 0;
        vcSplitCharsVal.textContent = val;
        const p = state.personasData[state.currentPersonaId];
        if (p?.ttsVoiceClone) { p.ttsVoiceClone.splitChars = val; markUnsaved(); }
    });

    vcAudioUploadBtn.addEventListener('click', () => vcAudioFileInput.click());
    vcAudioFileInput.addEventListener('change', handleAudioFilesSelected);
}

function updateTTSMode() {
    const isClone = state.ttsServerModelType === 'voice_clone';
    voiceDesignSection.classList.toggle('hidden', isClone);
    voiceCloneSection.classList.toggle('hidden', !isClone);
}

// ============== Multi-audio management ==============

/**
 * Called when the user selects one or more files via the OS file picker.
 *
 * In Electron, `file.path` exposes the absolute filesystem path of the
 * selected file, so we store that directly — no HTTP upload needed.
 * The backend reads the file from this path during inference.
 */
function handleAudioFilesSelected(e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    const p = state.personasData[state.currentPersonaId];
    if (!p?.ttsVoiceClone) return;

    for (const file of files) {
        const validTypes = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/x-wav'];
        if (!validTypes.includes(file.type) && !file.name.match(/\.(wav|mp3|ogg|flac)$/i)) {
            alert(`Unsupported format: ${file.name}. Use WAV, MP3, OGG, or FLAC.`);
            continue;
        }

        const filePath = webUtils.getPathForFile(file);  // Electron 32+: absolute OS path
        if (!filePath) {
            alert(`Could not read file path for "${file.name}". Make sure you are running in Electron.`);
            continue;
        }

        const isFirst = p.ttsVoiceClone.refAudios.filter(a => a.selected).length === 0;
        p.ttsVoiceClone.refAudios.push({
            id:       'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
            filename: file.name,
            path:     filePath,   // absolute OS path — served directly by the local backend
            refText:  '',
            selected: isFirst,
            exists:   true,
        });
    }

    renderRefAudioList(p);
    markUnsaved();
    vcAudioFileInput.value = '';
}

/**
 * Render the full reference audio list into #vc-audio-list.
 */
function renderRefAudioList(persona) {
    if (!vcAudioList) return;
    vcAudioList.innerHTML = '';

    const audios = persona.ttsVoiceClone?.refAudios || [];
    if (audios.length === 0) {
        vcAudioList.innerHTML = '<p class="param-hint" style="margin-top:8px;">No reference audios added yet.</p>';
        return;
    }

    audios.forEach((audio, idx) => {
        const entry = document.createElement('div');
        entry.className = 'vc-audio-entry' + (audio.selected ? ' vc-audio-entry--selected' : '');
        entry.dataset.id = audio.id;

        if (audio._uploading) {
            entry.innerHTML = `<div class="vc-audio-entry-header">
                <span class="vc-audio-filename">⏳ Uploading ${_escHtml(audio.filename)}…</span>
            </div>`;
            vcAudioList.appendChild(entry);
            return;
        }

        const missingBadge = !audio.exists
            ? `<span class="vc-audio-missing-badge" title="File not found on server — please re-upload">⚠ File missing</span>`
            : '';

        // Convert absolute OS path → file:// URL for the <audio> preview element.
        // Electron's renderer can load local files directly via the file:// protocol.
        const audioUrl = audio.path ? _pathToFileUrl(audio.path) : '';

        entry.innerHTML = `
            <div class="vc-audio-entry-header">
                <label class="vc-audio-select-label" title="Use this audio for TTS inference">
                    <input type="radio" name="vc-ref-select-${persona.id}"
                           class="vc-ref-radio" value="${audio.id}"
                           ${audio.selected ? 'checked' : ''}>
                    <span class="vc-audio-filename">${_escHtml(audio.filename)}</span>
                </label>
                ${missingBadge}
                <button class="icon-btn vc-audio-delete-btn" data-id="${audio.id}" title="Remove this audio">✕</button>
            </div>
            ${audioUrl ? `<audio src="${audioUrl}" controls class="vc-audio-preview"></audio>` : ''}
            <textarea class="form-input vc-audio-ref-text" data-id="${audio.id}" rows="2"
                placeholder="Transcript of this audio clip (improves quality)…">${_escHtml(audio.refText)}</textarea>
        `;

        vcAudioList.appendChild(entry);
    });

    // Bind events for this render
    vcAudioList.querySelectorAll('.vc-ref-radio').forEach(radio => {
        radio.addEventListener('change', () => {
            const p = state.personasData[state.currentPersonaId];
            if (!p?.ttsVoiceClone) return;
            p.ttsVoiceClone.refAudios.forEach(a => { a.selected = (a.id === radio.value); });
            renderRefAudioList(p);
            markUnsaved();
        });
    });

    vcAudioList.querySelectorAll('.vc-audio-ref-text').forEach(ta => {
        ta.addEventListener('input', () => {
            const p = state.personasData[state.currentPersonaId];
            if (!p?.ttsVoiceClone) return;
            const a = p.ttsVoiceClone.refAudios.find(x => x.id === ta.dataset.id);
            if (a) { a.refText = ta.value; markUnsaved(); }
        });
    });

    vcAudioList.querySelectorAll('.vc-audio-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => handleDeleteAudio(btn.dataset.id));
    });
}

function handleDeleteAudio(audioId) {
    const p = state.personasData[state.currentPersonaId];
    if (!p?.ttsVoiceClone) return;

    p.ttsVoiceClone.refAudios = p.ttsVoiceClone.refAudios.filter(a => a.id !== audioId);

    // Auto-select the first remaining entry if the deleted one was selected
    if (!p.ttsVoiceClone.refAudios.some(a => a.selected) && p.ttsVoiceClone.refAudios.length > 0) {
        p.ttsVoiceClone.refAudios[0].selected = true;
    }

    renderRefAudioList(p);
    markUnsaved();
}

/**
 * Convert an absolute OS path (Windows or Unix) to a file:// URL
 * suitable for use in <audio src="...">.
 */
function _pathToFileUrl(p) {
    if (!p) return '';
    if (p.startsWith('file://') || p.startsWith('http')) return p;
    // Windows: C:\path\to\file  →  file:///C:/path/to/file
    // Unix:    /path/to/file    →  file:///path/to/file
    return 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function _escHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function markUnsaved() {
    saveBtn.style.background = '#e74c3c';
    saveBtn.textContent = '💾 Save Changes*';
}

// ============== 核心数据逻辑 ==============

async function loadPersonasFromDB() {
    try {
        const personas = await api.getPersonas();
        state.personasData = {};
        savedPersonasData = {};

        if (personas.length === 0) {
            const defaultId = "default_1";
            const defaultData = createDefaultPersonaData(defaultId, 'Default Assistant', 'You are a helpful AI.', ['Always be polite.']);
            state.personasData[defaultId] = { ...defaultData };
            savedPersonasData[defaultId]  = { ...defaultData };
        } else {
            personas.forEach(p => {
                ensureTTSFields(p);
                state.personasData[p.id] = structuredClone(p);
                savedPersonasData[p.id]  = structuredClone(p);
            });
        }
        renderPersonaList();
        switchPersona(Object.keys(state.personasData)[0]);
    } catch (err) {
        console.error("Failed to load personas:", err);
    }
}

function ensureTTSFields(persona) {
    if (!persona.ttsMode) persona.ttsMode = 'voice_design';
    if (!persona.ttsVoiceDesign) {
        persona.ttsVoiceDesign = { instruct: '', language: 'auto', splitMode: 'sentence' };
    }
    if (persona.ttsVoiceDesign.splitMode === undefined) persona.ttsVoiceDesign.splitMode = 'sentence';
    if (!persona.ttsVoiceClone) {
        persona.ttsVoiceClone = { refAudios: [], language: 'auto', splitChars: 0 };
    }
    if (!Array.isArray(persona.ttsVoiceClone.refAudios)) {
        persona.ttsVoiceClone.refAudios = [];
    }
    if (persona.ttsVoiceClone.splitChars === undefined) persona.ttsVoiceClone.splitChars = 0;
}

function createDefaultPersonaData(id, name, description, rules) {
    return {
        id, name, description, rules,
        ttsMode: 'voice_design',
        ttsVoiceDesign: { instruct: '', language: 'auto' },
        ttsVoiceClone:  { refAudios: [], language: 'auto' },
    };
}

function updateDraft(field, value) {
    const p = state.personasData[state.currentPersonaId];
    if (!p) return;
    p[field] = value;
    if (field === 'name') renderPersonaList();
    syncToSystemPrompt(p);
    markUnsaved();
}

async function handleSave() {
    const currentDraft = state.personasData[state.currentPersonaId];
    if (!currentDraft) return;
    try {
        const response = await api.savePersona(currentDraft);
        if (response.id !== currentDraft.id) {
            const oldId = currentDraft.id;
            currentDraft.id = response.id;
            state.personasData[response.id] = currentDraft;
            delete state.personasData[oldId];
            state.currentPersonaId = response.id;
        }
        savedPersonasData[state.currentPersonaId] = structuredClone(currentDraft);
        saveBtn.style.background = '#5b6ea0';
        saveBtn.textContent = '💾 Saved';
        setTimeout(() => saveBtn.textContent = '💾 Save Persona', 2000);
        renderPersonaList();
    } catch (err) {
        console.error("Failed to save persona:", err);
        alert("Failed to save to database.");
    }
}

function handleReset() {
    const id = state.currentPersonaId;
    if (savedPersonasData[id]) {
        state.personasData[id] = structuredClone(savedPersonasData[id]);
    } else {
        state.personasData[id] = createDefaultPersonaData(id, 'New Character', '', []);
    }
    saveBtn.style.background = '#5b6ea0';
    saveBtn.textContent = '💾 Save Persona';
    switchPersona(id);
}

let deleteConfirmTimeout;
async function handleDelete() {
    const id = state.currentPersonaId;
    if (deleteBtn.dataset.confirming === "true") {
        deleteBtn.dataset.confirming = "false";
        deleteBtn.innerHTML = '🗑️ Delete';
        deleteBtn.style.background = 'transparent';
        deleteBtn.style.color = '#ff6b6b';
        clearTimeout(deleteConfirmTimeout);

        try {
            if (savedPersonasData[id] && String(id).match(/^\d+$/)) {
                await api.deletePersona(id);
            }
        } catch (err) {
            console.warn("Backend deletion failed or skipped.", err);
        }

        delete state.personasData[id];
        delete savedPersonasData[id];
        const remaining = Object.keys(state.personasData);
        if (remaining.length > 0) { switchPersona(remaining[0]); } else { createNewPersona(); }
        renderPersonaList();
    } else {
        deleteBtn.dataset.confirming = "true";
        deleteBtn.innerHTML = '⚠️ Click again to confirm';
        deleteBtn.style.background = '#ff6b6b';
        deleteBtn.style.color = 'white';
        deleteConfirmTimeout = setTimeout(() => {
            deleteBtn.dataset.confirming = "false";
            deleteBtn.innerHTML = '🗑️ Delete';
            deleteBtn.style.background = 'transparent';
            deleteBtn.style.color = '#ff6b6b';
        }, 3000);
    }
}

// ============== 渲染与 UI ==============

function switchView(viewName) {
    chatView.classList.toggle('hidden',    viewName !== 'chat');
    personaView.classList.toggle('hidden', viewName !== 'persona');
    settingsView.classList.toggle('hidden',viewName !== 'settings');
    navChatBtn.classList.toggle('active',     viewName === 'chat');
    navPersonaBtn.classList.toggle('active',  viewName === 'persona');
    navSettingsBtn.classList.toggle('active', viewName === 'settings');
}

function renderPersonaList() {
    personaListEl.innerHTML = '';
    Object.values(state.personasData).forEach(persona => {
        const div = document.createElement('div');
        div.className = `session-item ${persona.id === state.currentPersonaId ? 'active' : ''}`;
        div.textContent = persona.name || 'Unnamed Persona';
        div.addEventListener('click', () => switchPersona(persona.id));
        personaListEl.appendChild(div);
    });
}

function switchPersona(id) {
    if (!state.personasData[id]) return;
    state.currentPersonaId = id;
    const persona = state.personasData[id];
    ensureTTSFields(persona);

    personaNameInput.value = persona.name;
    personaDescInput.value = persona.description;
    renderRules(persona);
    renderTTSFields(persona);
    renderPersonaList();
    syncToSystemPrompt(persona);

    saveBtn.style.background = '#5b6ea0';
    saveBtn.textContent = '💾 Save Persona';
}

function createNewPersona() {
    const newId = 'temp_' + Date.now();
    state.personasData[newId] = createDefaultPersonaData(newId, 'New Character', '', ['Always stay in character.']);
    switchPersona(newId);
    updateDraft('name', 'New Character');
}

function renderRules(persona) {
    rulesContainer.innerHTML = '';
    persona.rules.forEach((rule, index) => {
        const div = document.createElement('div');
        div.className = 'rule-item';
        div.style.cssText = "display: flex; gap: 10px; margin-bottom: 8px;";
        div.innerHTML = `
            <input type="text" value="${_escHtml(rule)}" data-index="${index}"
                   class="rule-input form-input" style="flex-grow: 1;">
            <button data-index="${index}" class="delete-rule-btn icon-btn" style="color: #ff6b6b;">🗑️</button>
        `;
        rulesContainer.appendChild(div);
    });
}

function renderTTSFields(persona) {
    updateTTSMode();

    vdInstructInput.value    = persona.ttsVoiceDesign?.instruct   || '';
    vdLanguageSelect.value   = persona.ttsVoiceDesign?.language   || 'auto';
    vdSplitModeSelect.value  = persona.ttsVoiceDesign?.splitMode  || 'sentence';

    vcLanguageSelect.value   = persona.ttsVoiceClone?.language    || 'auto';
    const sc = persona.ttsVoiceClone?.splitChars ?? 0;
    vcSplitCharsSlider.value = sc;
    vcSplitCharsVal.textContent = sc;

    renderRefAudioList(persona);
}

function syncToSystemPrompt(persona) {
    currentPersonaBadge.textContent = persona.name || 'Unnamed Persona';
    let finalPrompt = `You are ${persona.name}.\n`;
    if (persona.description) finalPrompt += `\nDescription:\n${persona.description}\n`;
    const validRules = persona.rules.filter(r => r.trim() !== "");
    if (validRules.length > 0) {
        finalPrompt += `\nStrict Rules to follow:\n` + validRules.map(r => `- ${r}`).join('\n');
    }
    sysPromptInput.value = finalPrompt;
}
