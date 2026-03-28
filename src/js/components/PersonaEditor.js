import { CharacterCard } from "https://esm.run/@lenml/char-card-reader";
import { state } from '../store.js';
import { api } from '../api.js';

// 视图与导航
const chatView = document.getElementById('chat-view');
const personaView = document.getElementById('persona-view');
const navChatBtn = document.getElementById('nav-chat-btn');
const navPersonaBtn = document.getElementById('nav-persona-btn');

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

// 我们需要一个镜像字典来保存从后端拉取的真实数据，用于 Reset 功能
let savedPersonasData = {};

export async function initPersonaManager() {
    // 1. 从后端加载数据
    await loadPersonasFromDB();

    // 2. 绑定基础事件
    navChatBtn.addEventListener('click', () => switchView('chat'));
    navPersonaBtn.addEventListener('click', () => switchView('persona'));
    newPersonaBtn.addEventListener('click', createNewPersona);

    // 3. 表单实时绑定 (更新草稿并同步 Chat)
    personaNameInput.addEventListener('input', (e) => updateDraft('name', e.target.value));
    personaDescInput.addEventListener('input', (e) => updateDraft('description', e.target.value));

    addRuleBtn.addEventListener('click', () => {
        const p = state.personasData[state.currentPersonaId];
        if (p) {
            p.rules.push("");
            renderRules(p); // 仅在新增时重绘
            updateDraft('rules', p.rules);
        }
    });

    rulesContainer.addEventListener('input', (e) => {
        if (e.target.classList.contains('rule-input')) {
            const index = e.target.dataset.index;
            const p = state.personasData[state.currentPersonaId];
            p.rules[index] = e.target.value;
            // 注意：这里去掉了 renderRules，避免打字时失去焦点
            updateDraft('rules', p.rules);
        }
    });

    rulesContainer.addEventListener('click', (e) => {
        // 【核心修复】使用 closest 向上查找，防止点击到 emoji 字符上导致判断失效
        const btn = e.target.closest('.delete-rule-btn');
        if (btn) {
            const index = parseInt(btn.dataset.index, 10);
            const p = state.personasData[state.currentPersonaId];
            p.rules.splice(index, 1);
            renderRules(p); // 仅在删除时重绘
            updateDraft('rules', p.rules);
        }
    });

    // 4. 持久化操作按钮
    saveBtn.addEventListener('click', handleSave);
    resetBtn.addEventListener('click', handleReset);
    deleteBtn.addEventListener('click', handleDelete);

    // 文件导入支持...
    // document.getElementById('char-file').addEventListener('change', handleFileUpload);
}

// ============== 核心数据逻辑 ==============

async function loadPersonasFromDB() {
    try {
        const personas = await api.getPersonas();
        state.personasData = {};
        savedPersonasData = {};

        // 确保有一个默认兜底
        if (personas.length === 0) {
            const defaultId = "default_1";
            const defaultData = {
                id: defaultId, name: 'Default Assistant',
                description: 'You are a helpful AI.', rules: ['Always be polite.']
            };
            state.personasData[defaultId] = { ...defaultData };
            savedPersonasData[defaultId] = { ...defaultData };
        } else {
            personas.forEach(p => {
                // structuredClone 确保草稿和保存态的数据引用彻底分离
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

// 每次输入时调用：只修改内存状态，不保存数据库
function updateDraft(field, value) {
    const p = state.personasData[state.currentPersonaId];
    if (!p) return;
    p[field] = value;

    if (field === 'name') renderPersonaList();

    syncToSystemPrompt(p);

    const saveBtn = document.getElementById('save-persona-btn');
    if (saveBtn) {
        saveBtn.style.background = '#e74c3c';
        saveBtn.textContent = '💾 Save Changes*';
    }
}

async function handleSave() {
    const currentDraft = state.personasData[state.currentPersonaId];
    if (!currentDraft) return;

    try {
        const response = await api.savePersona(currentDraft);

        // 1. 如果是新建的角色，后端会返回真实的数字 ID，我们需要更新字典 Key
        if (response.id !== currentDraft.id) {
            const oldId = currentDraft.id;
            currentDraft.id = response.id;
            state.personasData[response.id] = currentDraft;
            delete state.personasData[oldId];
            state.currentPersonaId = response.id;
        }

        // 2. 将成功保存的状态同步到 saved 镜像中
        savedPersonasData[state.currentPersonaId] = structuredClone(currentDraft);

        // 3. UI 恢复原样
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
        // 如果是已有的角色，恢复到最后保存的状态
        state.personasData[id] = structuredClone(savedPersonasData[id]);
    } else {
        // 如果是刚点 "Create" 还没保存的新角色，Reset 就直接清空表单
        state.personasData[id] = { id: id, name: 'New Character', description: '', rules: [] };
    }

    saveBtn.style.background = '#5b6ea0';
    saveBtn.textContent = '💾 Save Persona';
    switchPersona(id); // 重新渲染表单
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

        // 无论后端是否成功，强制清除前端内存状态
        delete state.personasData[id];
        delete savedPersonasData[id];

        const remainingIds = Object.keys(state.personasData);
        if (remainingIds.length > 0) {
            switchPersona(remainingIds[0]);
        } else {
            createNewPersona(); // 全删光了，新建一个兜底
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
    if (viewName === 'chat') {
        chatView.classList.remove('hidden');
        personaView.classList.add('hidden');
        navChatBtn.classList.add('active');
        navPersonaBtn.classList.remove('active');
    } else {
        chatView.classList.add('hidden');
        personaView.classList.remove('hidden');
        navChatBtn.classList.remove('active');
        navPersonaBtn.classList.add('active');
    }
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

    personaNameInput.value = persona.name;
    personaDescInput.value = persona.description;

    renderRules(persona);
    renderPersonaList();
    syncToSystemPrompt(persona);

    // 切换角色时，恢复保存按钮状态
    saveBtn.style.background = '#5b6ea0';
    saveBtn.textContent = '💾 Save Persona';
}

function createNewPersona() {
    const newId = 'temp_' + Date.now(); // 使用 temp_ 前缀，告诉后端这是新建的
    state.personasData[newId] = {
        id: newId,
        name: 'New Character',
        description: '',
        rules: ['Always stay in character.']
    };
    switchPersona(newId);

    // 触发 UI 的“未保存”状态
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