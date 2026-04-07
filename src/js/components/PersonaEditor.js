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
const personaListEl      = document.getElementById('persona-list');
const newPersonaBtn      = document.getElementById('new-persona-btn');
const personaNameInput   = document.getElementById('persona-name');
const personaIdentityInput = document.getElementById('persona-identity');
const personaLanguageSelect = document.getElementById('persona-language');
const personaDescInput   = document.getElementById('persona-desc');
const rulesContainer     = document.getElementById('rules-container');
const addRuleBtn         = document.getElementById('add-rule-btn');

// 同步与操作
const sysPromptInput      = document.getElementById('sys-prompt');
const currentPersonaBadge = document.getElementById('current-persona-badge');
const saveBtn   = document.getElementById('save-persona-btn');
const resetBtn  = document.getElementById('reset-persona-btn');
const deleteBtn = document.getElementById('delete-persona-btn');

// Import / Export
const charFileInput    = document.getElementById('char-file');
const exportPersonaBtn = document.getElementById('export-persona-btn');

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

// ============== System-prompt language templates ==============
//
// XML structural tags remain in English across all languages so the model
// receives a consistent schema regardless of the persona language.
// Only the prose framing (opening identity line) is localised.
//
// Supported language keys: 'en' | 'zh' | 'ja'

const PROMPT_LANG = {
    en: {
        /** Opening identity sentence. `identity` may be empty. */
        identity: (name, identity) =>
            identity ? `You are ${name}, ${identity}.` : `You are ${name}.`,
        /** How to prefix each rule bullet. */
        ruleBullet: '- ',
    },
    zh: {
        identity: (name, identity) =>
            identity ? `你是${name}，${identity}。` : `你是${name}。`,
        ruleBullet: '- ',
    },
    ja: {
        identity: (name, identity) =>
            identity ? `あなたは${name}、${identity}です。` : `あなたは${name}です。`,
        ruleBullet: '- ',
    },
};

function _lang(persona) {
    return PROMPT_LANG[persona.language] ?? PROMPT_LANG.en;
}

// ============== Public API: prompt builder ==============

/**
 * Build the final system prompt for a persona.
 *
 * @param {object} persona  - Persona data object from state.personasData.
 * @param {object} injections - Dynamic content to inject at runtime.
 *   @param {string} [injections.visual_awareness]  - Screen-share / vision context.
 *   @param {string} [injections.skills_and_tools]  - Available JSON-schema tool list.
 *   @param {string} [injections.retrieved_context] - RAG-retrieved passages.
 *
 * Sections with no content (no persona description, no rules, no injections)
 * still appear as empty tags so the model always receives a consistent schema.
 */
export function buildSystemPrompt(persona, injections = {}) {
    const lang = _lang(persona);
    const name = persona.name || 'Assistant';

    const identityLine = lang.identity(name, (persona.identity || '').trim());

    const description = (persona.description || '').trim();

    const activeRules = (persona.rules || [])
        .filter(r => r.enabled && r.text.trim())
        .map(r => lang.ruleBullet + r.text.trim())
        .join('\n');

    const va  = (injections.visual_awareness  || '').trim();
    const sat = (injections.skills_and_tools  || '').trim();
    const rc  = (injections.retrieved_context || '').trim();

    // Helper: wrap content in an XML section, keeping empty tags on one line.
    const section = (tag, content) =>
        content
            ? `<${tag}>\n${content}\n</${tag}>`
            : `<${tag}></${tag}>`;

    return [
        '<system_directive>',
        identityLine,
        '',
        section('persona', description),
        '',
        section('visual_awareness', va),
        '',
        section('skills_and_tools', sat),
        '',
        section('retrieved_context', rc),
        '',
        section('rules', activeRules),
        '</system_directive>',
    ].join('\n');
}

// ============== Init ==============

export async function initPersonaManager() {
    await loadPersonasFromDB();

    navChatBtn.addEventListener('click',     () => switchView('chat'));
    navPersonaBtn.addEventListener('click',  () => switchView('persona'));
    navSettingsBtn.addEventListener('click', () => switchView('settings'));
    newPersonaBtn.addEventListener('click',  createNewPersona);

    personaNameInput.addEventListener('input', (e) => updateDraft('name', e.target.value));

    if (personaIdentityInput) {
        personaIdentityInput.addEventListener('input', (e) => updateDraft('identity', e.target.value));
    }

    if (personaLanguageSelect) {
        personaLanguageSelect.addEventListener('change', (e) => updateDraft('language', e.target.value));
    }

    personaDescInput.addEventListener('input', (e) => updateDraft('description', e.target.value));

    addRuleBtn.addEventListener('click', () => {
        const p = state.personasData[state.currentPersonaId];
        if (p) {
            p.rules.push({ text: '', enabled: true });
            renderRules(p);
            updateDraft('rules', p.rules);
        }
    });

    // Rule text edits
    rulesContainer.addEventListener('input', (e) => {
        if (e.target.classList.contains('rule-input')) {
            const p = state.personasData[state.currentPersonaId];
            p.rules[parseInt(e.target.dataset.index, 10)].text = e.target.value;
            updateDraft('rules', p.rules);
        }
    });

    // Rule enable/disable toggle
    rulesContainer.addEventListener('change', (e) => {
        if (e.target.classList.contains('rule-enabled-checkbox')) {
            const p = state.personasData[state.currentPersonaId];
            const idx = parseInt(e.target.dataset.index, 10);
            p.rules[idx].enabled = e.target.checked;
            e.target.closest('.rule-item')
                .querySelector('.rule-input')
                .classList.toggle('rule-disabled', !e.target.checked);
            syncToSystemPrompt(p);
            markUnsaved();
        }
    });

    // Rule delete
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

    if (charFileInput) {
        charFileInput.addEventListener('change', handleImportFile);
    }

    if (exportPersonaBtn) {
        exportPersonaBtn.addEventListener('click', exportPersona);
    }

    initTTSEvents();
}

// ============== Import / Export ==============

/**
 * VLoid Persona JSON Schema v1.1
 *
 * {
 *   "exported_at": "<ISO-8601>",
 *   "persona": {
 *     "name":        "...",
 *     "identity":    "...",   ← one-sentence tagline after the name
 *     "language":    "en" | "zh" | "ja",
 *     "description": "...",
 *     "rules": [ { "text": "...", "enabled": true }, ... ],
 *     "ttsMode": "voice_design" | "voice_clone",
 *     "ttsVoiceDesign": { "instruct": "...", "language": "auto", "splitMode": "sentence" },
 *     "ttsVoiceClone":  { "language": "auto", "splitChars": 0 }
 *     // ttsVoiceClone.refAudios omitted — local paths are not portable
 *   }
 * }
 */

async function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    charFileInput.value = '';

    try {
        if (file.type === 'application/json' || file.name.toLowerCase().endsWith('.json')) {
            const text = await file.text();
            const data = JSON.parse(text);
            if (data.persona) {
                importVLoidPersona(data.persona);
                return;
            }
        }
        // Fall back to SillyTavern character card (PNG / WebP / JSON)
        const card = await CharacterCard.fromFile(file);
        importSillyTavernCard(card);
    } catch (err) {
        console.error('Import failed:', err);
        alert(`Import failed: ${err.message}`);
    }
}

function importVLoidPersona(personaData) {
    const newId = 'temp_' + Date.now();
    const imported = {
        id:          newId,
        name:        personaData.name        || 'Imported Persona',
        identity:    personaData.identity    || '',
        language:    personaData.language    || 'en',
        description: personaData.description || '',
        rules: Array.isArray(personaData.rules)
            ? personaData.rules.map(r =>
                typeof r === 'string'
                    ? { text: r, enabled: true }
                    : { text: r.text ?? '', enabled: r.enabled !== false }
              )
            : [],
        ttsMode:        personaData.ttsMode       || 'voice_design',
        ttsVoiceDesign: {
            instruct:  personaData.ttsVoiceDesign?.instruct   || '',
            language:  personaData.ttsVoiceDesign?.language   || 'auto',
            splitMode: personaData.ttsVoiceDesign?.splitMode  || 'sentence',
        },
        ttsVoiceClone: {
            refAudios:  [],
            language:   personaData.ttsVoiceClone?.language   || 'auto',
            splitChars: personaData.ttsVoiceClone?.splitChars ?? 0,
        },
    };

    state.personasData[newId] = imported;
    switchPersona(newId);
    markUnsaved();
}

function importSillyTavernCard(card) {
    const d = card.data ?? card;
    const newId = 'temp_' + Date.now();

    const parts = [d.description, d.personality].filter(Boolean);
    const description = parts.join('\n\n');

    const rules = [];
    if (d.system_prompt)  rules.push({ text: d.system_prompt.trim(),  enabled: true });
    if (d.character_note) rules.push({ text: d.character_note.trim(), enabled: true });

    const imported = {
        id: newId,
        name:        d.name      || 'Imported Character',
        identity:    '',
        language:    'en',
        description: description || '',
        rules,
        ttsMode:        'voice_design',
        ttsVoiceDesign: { instruct: '', language: 'auto', splitMode: 'sentence' },
        ttsVoiceClone:  { refAudios: [], language: 'auto', splitChars: 0 },
    };

    state.personasData[newId] = imported;
    switchPersona(newId);
    markUnsaved();
}

function exportPersona() {
    const p = state.personasData[state.currentPersonaId];
    if (!p) return;

    const payload = {
        exported_at: new Date().toISOString(),
        persona: {
            name:        p.name,
            identity:    p.identity    || '',
            language:    p.language    || 'en',
            description: p.description,
            rules:       p.rules.map(r => ({ text: r.text, enabled: r.enabled })),
            ttsMode:     p.ttsMode,
            ttsVoiceDesign: {
                instruct:  p.ttsVoiceDesign?.instruct   || '',
                language:  p.ttsVoiceDesign?.language   || 'auto',
                splitMode: p.ttsVoiceDesign?.splitMode  || 'sentence',
            },
            ttsVoiceClone: {
                language:   p.ttsVoiceClone?.language   || 'auto',
                splitChars: p.ttsVoiceClone?.splitChars ?? 0,
            },
        },
    };

    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${(p.name || 'persona').replace(/[^a-z0-9_\-]/gi, '_')}_vloid.json`;
    a.click();
    URL.revokeObjectURL(url);
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

        const filePath = webUtils.getPathForFile(file);
        if (!filePath) {
            alert(`Could not read file path for "${file.name}". Make sure you are running in Electron.`);
            continue;
        }

        const isFirst = p.ttsVoiceClone.refAudios.filter(a => a.selected).length === 0;
        p.ttsVoiceClone.refAudios.push({
            id:       'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
            filename: file.name,
            path:     filePath,
            refText:  '',
            selected: isFirst,
            exists:   true,
        });
    }

    renderRefAudioList(p);
    markUnsaved();
    vcAudioFileInput.value = '';
}

function renderRefAudioList(persona) {
    if (!vcAudioList) return;
    vcAudioList.innerHTML = '';

    const audios = persona.ttsVoiceClone?.refAudios || [];
    if (audios.length === 0) {
        vcAudioList.innerHTML = '<p class="param-hint" style="margin-top:8px;">No reference audios added yet.</p>';
        return;
    }

    audios.forEach((audio) => {
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

    if (!p.ttsVoiceClone.refAudios.some(a => a.selected) && p.ttsVoiceClone.refAudios.length > 0) {
        p.ttsVoiceClone.refAudios[0].selected = true;
    }

    renderRefAudioList(p);
    markUnsaved();
}

function _pathToFileUrl(p) {
    if (!p) return '';
    if (p.startsWith('file://') || p.startsWith('http')) return p;
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
            const defaultId = 'default_1';
            const defaultData = createDefaultPersonaData(defaultId, 'Default Assistant', '', 'You are a helpful AI.', [
                { text: 'Always be polite.', enabled: true },
            ]);
            state.personasData[defaultId] = { ...defaultData };
            savedPersonasData[defaultId]  = { ...defaultData };
        } else {
            personas.forEach(p => {
                ensurePersonaFields(p);
                state.personasData[p.id] = structuredClone(p);
                savedPersonasData[p.id]  = structuredClone(p);
            });
        }
        renderPersonaList();
        switchPersona(Object.keys(state.personasData)[0]);
    } catch (err) {
        console.error('Failed to load personas:', err);
    }
}

/** Ensures all expected fields exist, migrating old data formats. */
function ensurePersonaFields(persona) {
    if (!persona.identity) persona.identity = '';
    if (!persona.language) persona.language = 'en';

    // Migrate rules: string[] → {text, enabled}[]
    if (Array.isArray(persona.rules)) {
        persona.rules = persona.rules.map(r =>
            typeof r === 'string' ? { text: r, enabled: true } : r
        );
    } else {
        persona.rules = [];
    }

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

function createDefaultPersonaData(id, name, identity, description, rules) {
    const normalizedRules = (rules || []).map(r =>
        typeof r === 'string' ? { text: r, enabled: true } : r
    );
    return {
        id, name,
        identity:    identity    || '',
        language:    'en',
        description: description || '',
        rules: normalizedRules,
        ttsMode: 'voice_design',
        ttsVoiceDesign: { instruct: '', language: 'auto', splitMode: 'sentence' },
        ttsVoiceClone:  { refAudios: [], language: 'auto', splitChars: 0 },
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
        console.error('Failed to save persona:', err);
        alert('Failed to save to database.');
    }
}

function handleReset() {
    const id = state.currentPersonaId;
    if (savedPersonasData[id]) {
        state.personasData[id] = structuredClone(savedPersonasData[id]);
    } else {
        state.personasData[id] = createDefaultPersonaData(id, 'New Character', '', '', []);
    }
    saveBtn.style.background = '#5b6ea0';
    saveBtn.textContent = '💾 Save Persona';
    switchPersona(id);
}

let deleteConfirmTimeout;
async function handleDelete() {
    const id = state.currentPersonaId;
    if (deleteBtn.dataset.confirming === 'true') {
        deleteBtn.dataset.confirming = 'false';
        deleteBtn.innerHTML = '🗑️ Delete';
        deleteBtn.style.background = 'transparent';
        deleteBtn.style.color = '#ff6b6b';
        clearTimeout(deleteConfirmTimeout);

        try {
            if (savedPersonasData[id] && String(id).match(/^\d+$/)) {
                await api.deletePersona(id);
            }
        } catch (err) {
            console.warn('Backend deletion failed or skipped.', err);
        }

        delete state.personasData[id];
        delete savedPersonasData[id];
        const remaining = Object.keys(state.personasData);
        if (remaining.length > 0) { switchPersona(remaining[0]); } else { createNewPersona(); }
        renderPersonaList();
    } else {
        deleteBtn.dataset.confirming = 'true';
        deleteBtn.innerHTML = '⚠️ Click again to confirm';
        deleteBtn.style.background = '#ff6b6b';
        deleteBtn.style.color = 'white';
        deleteConfirmTimeout = setTimeout(() => {
            deleteBtn.dataset.confirming = 'false';
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
    ensurePersonaFields(persona);

    personaNameInput.value = persona.name;
    if (personaIdentityInput)   personaIdentityInput.value   = persona.identity  || '';
    if (personaLanguageSelect)  personaLanguageSelect.value  = persona.language  || 'en';
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
    state.personasData[newId] = createDefaultPersonaData(newId, 'New Character', '', '', [
        { text: 'Always stay in character.', enabled: true },
    ]);
    switchPersona(newId);
    updateDraft('name', 'New Character');
}

function renderRules(persona) {
    rulesContainer.innerHTML = '';
    persona.rules.forEach((rule, index) => {
        const div = document.createElement('div');
        div.className = 'rule-item';
        div.innerHTML = `
            <label class="switch switch-sm" title="${rule.enabled ? 'Rule enabled' : 'Rule disabled'}">
                <input type="checkbox" class="rule-enabled-checkbox" data-index="${index}"
                       ${rule.enabled ? 'checked' : ''}>
                <span class="slider round"></span>
            </label>
            <input type="text" value="${_escHtml(rule.text)}" data-index="${index}"
                   class="rule-input form-input${rule.enabled ? '' : ' rule-disabled'}"
                   placeholder="Describe a behaviour rule…">
            <button data-index="${index}" class="delete-rule-btn icon-btn" title="Remove rule">🗑️</button>
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

/** Write the structured prompt preview to the sidebar textarea. */
function syncToSystemPrompt(persona) {
    currentPersonaBadge.textContent = persona.name || 'Unnamed Persona';
    sysPromptInput.value = buildSystemPrompt(persona);
}
