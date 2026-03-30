import { CharacterCard } from "https://esm.run/@lenml/char-card-reader";
import { state } from '../store.js';
import { api } from '../api.js';

// 视图与导航
const chatView = document.getElementById('chat-view');
const personaView = document.getElementById('persona-view');
const settingsView = document.getElementById('settings-view');
const navChatBtn = document.getElementById('nav-chat-btn');
const navPersonaBtn = document.getElementById('nav-persona-btn');
const navSettingsBtn = document.getElementById('nav-settings-btn');

// 列表与表单
const personaListEl = document.getElementById('persona-list');
const newPersonaBtn = document.getElementById('new-persona-btn');
const personaNameInput = document.getElementById('persona-name');
const personaDescInput = document.getElementById('persona-desc');
const rulesContainer = document.getElementById('rules-container');
const addRuleBtn = document.getElementById('add-rule-btn');

// 同步与操作
const sysPromptInput = document.getElementById('sys-prompt');
const currentPersonaBadge = document.getElementById('current-persona-badge');
const saveBtn = document.getElementById('save-persona-btn');
const resetBtn = document.getElementById('reset-persona-btn');
const deleteBtn = document.getElementById('delete-persona-btn');

// TTS 相关 DOM 元素
const ttsModeToggle = document.getElementById('tts-mode-toggle');
const voiceDesignSection = document.getElementById('voice-design-section');
const voiceCloneSection = document.getElementById('voice-clone-section');
const vdInstructInput = document.getElementById('vd-instruct');
const vdLanguageSelect = document.getElementById('vd-language');
const vcRefTextInput = document.getElementById('vc-ref-text');
const vcLanguageSelect = document.getElementById('vc-language');
const vcAudioUploadBtn = document.getElementById('vc-audio-upload-btn');
const vcAudioFileInput = document.getElementById('vc-audio-file');
const vcAudioStatus = document.getElementById('vc-audio-status');
const vcAudioPreview = document.getElementById('vc-audio-preview');
const vcAudioClearBtn = document.getElementById('vc-audio-clear-btn');

// 我们需要一个镜像字典来保存从后端拉取的真实数据，用于 Reset 功能
let savedPersonasData = {};

export async function initPersonaManager() {
    // 1. 从后端加载数据
    await loadPersonasFromDB();

    // 2. 绑定基础事件
    navChatBtn.addEventListener('click', () => switchView('chat'));
    navPersonaBtn.addEventListener('click', () => switchView('persona'));
    navSettingsBtn.addEventListener('click', () => switchView('settings'));
    newPersonaBtn.addEventListener('click', createNewPersona);

    // 3. 表单实时绑定 (更新草稿并同步 Chat)
    personaNameInput.addEventListener('input', (e) => updateDraft('name', e.target.value));
    personaDescInput.addEventListener('input', (e) => updateDraft('description', e.target.value));

    addRuleBtn.addEventListener('click', () => {
        const p = state.personasData[state.currentPersonaId];
        if (p) {
            p.rules.push("");
            renderRules(p);
            updateDraft('rules', p.rules);
        }
    });

    rulesContainer.addEventListener('input', (e) => {
        if (e.target.classList.contains('rule-input')) {
            const index = e.target.dataset.index;
            const p = state.personasData[state.currentPersonaId];
            p.rules[index] = e.target.value;
            updateDraft('rules', p.rules);
        }
    });

    rulesContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.delete-rule-btn');
        if (btn) {
            const index = parseInt(btn.dataset.index, 10);
            const p = state.personasData[state.currentPersonaId];
            p.rules.splice(index, 1);
            renderRules(p);
            updateDraft('rules', p.rules);
        }
    });

    // 4. 持久化操作按钮
    saveBtn.addEventListener('click', handleSave);
    resetBtn.addEventListener('click', handleReset);
    deleteBtn.addEventListener('click', handleDelete);

    // 5. TTS 相关事件绑定
    initTTSEvents();
}

// ============== TTS 事件初始化 ==============

function initTTSEvents() {
    // TTS 模式切换开关
    ttsModeToggle.addEventListener('change', (e) => {
        const mode = e.target.checked ? 'voice_clone' : 'voice_design';
        updateTTSMode(mode);
        updateDraft('ttsMode', mode);
    });

    // VoiceDesign instruct 输入
    vdInstructInput.addEventListener('input', (e) => {
        const p = state.personasData[state.currentPersonaId];
        if (p && p.ttsVoiceDesign) {
            p.ttsVoiceDesign.instruct = e.target.value;
            markUnsaved();
        }
    });

    // VoiceDesign 语言选择
    vdLanguageSelect.addEventListener('change', (e) => {
        const p = state.personasData[state.currentPersonaId];
        if (p && p.ttsVoiceDesign) {
            p.ttsVoiceDesign.language = e.target.value;
            markUnsaved();
        }
    });

    // Voice Clone 参考文本输入
    vcRefTextInput.addEventListener('input', (e) => {
        const p = state.personasData[state.currentPersonaId];
        if (p && p.ttsVoiceClone) {
            p.ttsVoiceClone.refText = e.target.value;
            markUnsaved();
        }
    });

    // Voice Clone 语言选择
    vcLanguageSelect.addEventListener('change', (e) => {
        const p = state.personasData[state.currentPersonaId];
        if (p && p.ttsVoiceClone) {
            p.ttsVoiceClone.language = e.target.value;
            markUnsaved();
        }
    });

    // Voice Clone 音频上传按钮 -> 触发隐藏的 file input
    vcAudioUploadBtn.addEventListener('click', () => {
        vcAudioFileInput.click();
    });

    // Voice Clone 音频文件选择
    vcAudioFileInput.addEventListener('change', handleAudioFileSelect);

    // Voice Clone 清除音频按钮
    vcAudioClearBtn.addEventListener('click', clearRefAudio);
}

function updateTTSMode(mode) {
    const isClone = mode === 'voice_clone';
    ttsModeToggle.checked = isClone;
    voiceDesignSection.classList.toggle('hidden', isClone);
    voiceCloneSection.classList.toggle('hidden', !isClone);
}

async function handleAudioFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    const p = state.personasData[state.currentPersonaId];
    if (!p || !p.ttsVoiceClone) return;

    // 验证文件类型
    const validTypes = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/x-wav'];
    if (!validTypes.includes(file.type) && !file.name.match(/\.(wav|mp3|ogg|flac)$/i)) {
        vcAudioStatus.textContent = '⚠ Unsupported format. Use WAV, MP3, OGG, or FLAC.';
        vcAudioStatus.style.color = '#f14c4c';
        return;
    }

    // 验证文件大小 (最大 50MB)
    if (file.size > 50 * 1024 * 1024) {
        vcAudioStatus.textContent = '⚠ File too large. Max 50MB.';
        vcAudioStatus.style.color = '#f14c4c';
        return;
    }

    // 读取文件为 base64
    try {
        const base64Data = await fileToBase64(file);
        p.ttsVoiceClone.refAudioPath = file.name;
        p.ttsVoiceClone.refAudioData = base64Data;

        // 更新 UI
        vcAudioStatus.textContent = `✓ ${file.name}`;
        vcAudioStatus.style.color = '#4ec9b0';
        vcAudioPreview.src = URL.createObjectURL(file);
        vcAudioPreview.classList.remove('hidden');
        vcAudioClearBtn.classList.remove('hidden');

        markUnsaved();
    } catch (err) {
        console.error('Failed to read audio file:', err);
        vcAudioStatus.textContent = '⚠ Failed to read file.';
        vcAudioStatus.style.color = '#f14c4c';
    }
}

function clearRefAudio() {
    const p = state.personasData[state.currentPersonaId];
    if (p && p.ttsVoiceClone) {
        p.ttsVoiceClone.refAudioPath = '';
        p.ttsVoiceClone.refAudioData = null;
    }
    vcAudioFileInput.value = '';
    vcAudioStatus.textContent = 'No audio uploaded';
    vcAudioStatus.style.color = '#969696';
    vcAudioPreview.classList.add('hidden');
    vcAudioPreview.src = '';
    vcAudioClearBtn.classList.add('hidden');
    markUnsaved();
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
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
            savedPersonasData[defaultId] = { ...defaultData };
        } else {
            personas.forEach(p => {
                // 确保老数据也有 TTS 字段
                ensureTTSFields(p);
                state.personasData[p.id] = structuredClone(p);
                savedPersonasData[p.id] = structuredClone(p);
            });
        }
        renderPersonaList();
        const firstId = Object.keys(state.personasData)[0];
        switchPersona(firstId);
    } catch (err) {
        console.error("Failed to load personas:", err);
    }
}

/**
 * 确保 persona 对象拥有 TTS 相关字段，兼容旧数据
 */
function ensureTTSFields(persona) {
    if (!persona.ttsMode) persona.ttsMode = 'voice_design';
    if (!persona.ttsVoiceDesign) {
        persona.ttsVoiceDesign = { instruct: '', language: 'auto' };
    }
    if (!persona.ttsVoiceClone) {
        persona.ttsVoiceClone = { refAudioPath: '', refAudioData: null, refText: '', language: 'auto' };
    }
}

function createDefaultPersonaData(id, name, description, rules) {
    return {
        id,
        name,
        description,
        rules,
        ttsMode: 'voice_design',
        ttsVoiceDesign: { instruct: '', language: 'auto' },
        ttsVoiceClone: { refAudioPath: '', refAudioData: null, refText: '', language: 'auto' }
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
            const isDatabaseId = String(id).match(/^\d+$/);
            if (savedPersonasData[id] && isDatabaseId) {
                await api.deletePersona(id);
            }
        } catch (err) {
            console.warn("Backend deletion failed or skipped, proceeding with local cleanup.", err);
        }

        delete state.personasData[id];
        delete savedPersonasData[id];
        const remainingIds = Object.keys(state.personasData);
        if (remainingIds.length > 0) {
            switchPersona(remainingIds[0]);
        } else {
            createNewPersona();
        }
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
    chatView.classList.toggle('hidden', viewName !== 'chat');
    personaView.classList.toggle('hidden', viewName !== 'persona');
    settingsView.classList.toggle('hidden', viewName !== 'settings');
    navChatBtn.classList.toggle('active', viewName === 'chat');
    navPersonaBtn.classList.toggle('active', viewName === 'persona');
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

    // 确保 TTS 字段存在
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
            <input type="text" value="${rule}" data-index="${index}" class="rule-input form-input" style="flex-grow: 1;">
            <button data-index="${index}" class="delete-rule-btn icon-btn" style="color: #ff6b6b;">🗑️</button>
        `;
        rulesContainer.appendChild(div);
    });
}

/**
 * 渲染 TTS 表单字段，根据当前 persona 的 TTS 设置填充
 */
function renderTTSFields(persona) {
    // 设置模式开关
    updateTTSMode(persona.ttsMode || 'voice_design');

    // VoiceDesign 字段
    vdInstructInput.value = persona.ttsVoiceDesign?.instruct || '';
    vdLanguageSelect.value = persona.ttsVoiceDesign?.language || 'auto';

    // Voice Clone 字段
    vcRefTextInput.value = persona.ttsVoiceClone?.refText || '';
    vcLanguageSelect.value = persona.ttsVoiceClone?.language || 'auto';

    // 音频状态
    if (persona.ttsVoiceClone?.refAudioPath) {
        vcAudioStatus.textContent = `✓ ${persona.ttsVoiceClone.refAudioPath}`;
        vcAudioStatus.style.color = '#4ec9b0';
        vcAudioClearBtn.classList.remove('hidden');
        // 如果有 base64 数据，设置预览
        if (persona.ttsVoiceClone.refAudioData) {
            vcAudioPreview.src = `data:audio/wav;base64,${persona.ttsVoiceClone.refAudioData}`;
            vcAudioPreview.classList.remove('hidden');
        } else {
            vcAudioPreview.classList.add('hidden');
        }
    } else {
        vcAudioStatus.textContent = 'No audio uploaded';
        vcAudioStatus.style.color = '#969696';
        vcAudioPreview.classList.add('hidden');
        vcAudioPreview.src = '';
        vcAudioClearBtn.classList.add('hidden');
    }
    vcAudioFileInput.value = '';
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