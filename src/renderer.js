import { CharacterCard } from "https://esm.run/@lenml/char-card-reader";

const API_BASE = "http://127.0.0.1:3000";
let currentSessionId = null;
let sessionsData = {}; 
let abortController = null; // 用于中断请求

// DOM 元素获取
const messageContainer = document.getElementById('message-container');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const sessionList = document.getElementById('session-list');

// 参数元素
const sysPromptInput = document.getElementById('sys-prompt');
const sliders = {
    temp: { el: document.getElementById('temp-slider'), val: document.getElementById('temp-val') },
    topp: { el: document.getElementById('topp-slider'), val: document.getElementById('topp-val') },
    rep: { el: document.getElementById('rep-slider'), val: document.getElementById('rep-val') },
    tokens: { el: document.getElementById('tokens-slider'), val: document.getElementById('tokens-val') }
};

// 绑定滑块数值更新
Object.values(sliders).forEach(slider => {
    slider.el.addEventListener('input', (e) => slider.val.innerText = e.target.value);
});

// 文本框自适应高度 (可选体验优化)
userInput.addEventListener('input', function () {
    this.style.height = '56px'; // 基础高度
    this.style.height = (this.scrollHeight) + 'px';
});

userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

sendBtn.addEventListener('click', sendMessage);

// 中断生成逻辑
stopBtn.addEventListener('click', () => {
    if (abortController) {
        abortController.abort();
        abortController = null;
    }
});


const api = {
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
    }
};

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const backendSessions = await api.getSessions();

        // 【防御性修改】确保后端返回的确实是一个数组
        if (!Array.isArray(backendSessions) || backendSessions.length === 0) {
            console.warn("No valid sessions found or backend returned error. Creating local session.");
            createNewSession();
        } else {
            backendSessions.forEach(s => {
                sessionsData[s.id] = { title: s.title, messages: null };
            });
            await switchSession(backendSessions[0].id);
        }
    } catch (err) {
        console.error("Failed to sync with backend:", err);
        messageContainer.innerHTML = `<div class="message system" style="color:#ff6b6b">❌ Failed to connect to local API server. Is it running?</div>`;
    }
});

function appendMessageToUI(role, content) {
    const div = document.createElement('div');
    div.classList.add('message', role);
    div.textContent = content;
    messageContainer.appendChild(div);
    messageContainer.scrollTop = messageContainer.scrollHeight;
    return div;
}

// 1. 渲染左侧会话列表
function renderSessionList() {
    sessionList.innerHTML = '';
    const sortedSessions = Object.entries(sessionsData).sort((a, b) => b[0].localeCompare(a[0]));

    for (const [id, session] of sortedSessions) {
        const div = document.createElement('div');
        div.className = `session-item ${id === currentSessionId ? 'active' : ''}`;

        const titleSpan = document.createElement('span');
        titleSpan.textContent = session.title;
        div.appendChild(titleSpan);

        // 新增删除按钮
        const delBtn = document.createElement('button');
        delBtn.className = 'delete-session-btn';
        delBtn.innerHTML = '🗑️';
        delBtn.title = 'Delete Session';

        // 绑定删除事件
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation(); // 阻止触发切换会话
            if (confirm(`Are you sure you want to delete "${session.title}"?`)) {
                await deleteChatSession(id);
            }
        });

        div.appendChild(delBtn);
        div.addEventListener('click', () => switchSession(id));
        sessionList.appendChild(div);
    }
}

async function deleteChatSession(sessionId) {
    try {
        await api.deleteSession(sessionId);
        delete sessionsData[sessionId]; // 本地移除

        // 如果删除的是当前处于激活状态的会话，需要切换到另一个
        if (currentSessionId === sessionId) {
            const remainingKeys = Object.keys(sessionsData);
            if (remainingKeys.length > 0) {
                await switchSession(remainingKeys[0]);
            } else {
                createNewSession(); // 全删光了，新建一个
            }
        } else {
            renderSessionList(); // 仅刷新列表
        }
    } catch (error) {
        console.error("Failed to delete session:", error);
        alert("Error deleting session.");
    }
}

// 2. 切换会话 (保留包含后端请求的 async 唯一版本)
async function switchSession(sessionId) {
    if (currentSessionId === sessionId) return; // 点击当前会话无视
    currentSessionId = sessionId;

    // 如果该会话的消息还没拉取过，则向后端请求 (懒加载)
    if (sessionsData[sessionId].messages === null) {
        try {
            const msgs = await api.getMessages(sessionId);
            // 确保格式安全
            sessionsData[sessionId].messages = Array.isArray(msgs) ? msgs : [];
        } catch (err) {
            console.error("Failed to load messages:", err);
            sessionsData[sessionId].messages = [];
        }
    }

    renderSessionList(); // 更新 UI 激活状态

    // 清空当前聊天面板，重新渲染选中会话的历史记录
    messageContainer.innerHTML = '';
    const history = sessionsData[sessionId].messages;

    // if (history.length === 0) {
    //     appendMessageToUI('system', 'Hello! I am your local AI. How can I help you?');
    // } else {
    //     history.forEach(msg => {
    //         // 屏蔽 system prompt 不在前端对话框显示
    //         if (msg.role !== 'system') {
    //             appendMessageToUI(msg.role, msg.content);
    //         }
    //     });
    // }
    history.forEach(msg => {
        // 屏蔽 system prompt 不在前端对话框显示
        if (msg.role !== 'system') {
            appendMessageToUI(msg.role, msg.content);
        }
    });
}

// 3. 创建新会话
function createNewSession() {
    const newId = "session_" + Date.now();
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // 此时仅在前端创建状态，不发请求。等用户发送第一条消息时，后端路由会自动落盘创建记录。
    sessionsData[newId] = {
        title: `New Chat ${timeStr}`,
        messages: []
    };

    switchSession(newId);
}
newChatBtn.addEventListener('click', createNewSession);

// 初始化渲染一次列表
renderSessionList();

async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    // 重置输入框
    userInput.value = '';
    userInput.style.height = '56px';
    appendMessageToUI('user', text);
    sessionsData[currentSessionId].messages.push({ role: 'user', content: text });

    const payload = {
        session_id: currentSessionId,
        messages: [
            { role: 'system', content: sysPromptInput.value },
            ...sessionsData[currentSessionId].messages
        ],
        temperature: parseFloat(sliders.temp.el.value),
        top_p: parseFloat(sliders.topp.el.value),
        repetition_penalty: parseFloat(sliders.rep.el.value),
        max_tokens: parseInt(sliders.tokens.el.value),
        use_rag: document.getElementById('rag-toggle').checked
    };

    // UI 状态切换
    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    const assistantMsgNode = appendMessageToUI('assistant', '...'); // 加载提示
    let assistantFullText = '';

    abortController = new AbortController();

    try {
        const response = await fetch(`${API_BASE}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: abortController.signal // 绑定中断信号
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        assistantMsgNode.textContent = ''; // 清除加载提示
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataStr = line.replace('data: ', '').trim();
                    if (dataStr === '[DONE]') continue;

                    try {
                        const dataObj = JSON.parse(dataStr);
                        const delta = dataObj.choices[0]?.delta?.content || '';
                        assistantFullText += delta;
                        assistantMsgNode.textContent = assistantFullText;

                        // 简单的自动滚动，避免阻碍用户手动往上翻
                        const isAtBottom = messageContainer.scrollHeight - messageContainer.scrollTop <= messageContainer.clientHeight + 50;
                        if (isAtBottom) messageContainer.scrollTop = messageContainer.scrollHeight;

                    } catch (err) {
                        console.error("Parse error:", err);
                    }
                }
            }
        }
        sessionsData[currentSessionId].messages.push({ role: 'assistant', content: assistantFullText });
        // 如果是新会话的第一句话，可以把这句当做标题 (可选体验优化)
        if (sessionsData[currentSessionId].messages.length === 2) {
            sessionsData[currentSessionId].title = text.substring(0, 15) + (text.length > 15 ? '...' : '');
            renderSessionList();
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('Generation stopped by user');
            assistantMsgNode.textContent += ' ⏹ [Stopped]';
            sessionsData[currentSessionId].messages.push({ role: 'assistant', content: assistantFullText }); // 保存已生成的部分
        } else {
            console.error("Chat Error:", error);
            assistantMsgNode.textContent = "❌ Error: " + error.message;
            assistantMsgNode.style.color = "#ff6b6b";
        }
    } finally {
        sendBtn.classList.remove('hidden');
        stopBtn.classList.add('hidden');
        userInput.focus();
        abortController = null;
    }
}

const memoryModal = document.getElementById('memory-modal');
const openMemoryBtn = document.getElementById('open-memory-btn');
const closeMemoryBtn = document.getElementById('close-memory-btn');
const charFileInput = document.getElementById('char-file');
const charPreview = document.getElementById('char-preview');
const applyCharBtn = document.getElementById('apply-char-btn');
let loadedCharacter = null; // 暂存读取到的角色数据

openMemoryBtn.addEventListener('click', () => memoryModal.classList.remove('hidden'));
closeMemoryBtn.addEventListener('click', () => memoryModal.classList.add('hidden'));

// 处理文件上传解析
charFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
        let card = null;
        if (file.type.startsWith("image/")) {
            const arrayBuffer = await file.arrayBuffer();
            card = await CharacterCard.from_file(arrayBuffer);
        } else if (file.type === "application/json") {
            const jsonText = await file.text();
            const jsonData = JSON.parse(jsonText);
            card = CharacterCard.from_json(jsonData);
        }

        if (card) {
            // 提取 V3 标准数据以供渲染
            loadedCharacter = card.toSpecV3();

            // 更新 UI
            document.getElementById('char-name').textContent = loadedCharacter.data.name;
            document.getElementById('char-desc').value = loadedCharacter.data.description || 'No description provided.';

            // 简单处理：如果是图片文件，直接本地预览头像
            if (file.type.startsWith("image/")) {
                document.getElementById('char-avatar').src = URL.createObjectURL(file);
            }

            charPreview.classList.remove('hidden');
            applyCharBtn.classList.remove('hidden');
        }
    } catch (err) {
        console.error("Failed to parse character card:", err);
        alert("Failed to read Character Card. Ensure it is a valid SillyTavern file.");
    }
});

// 应用角色卡到当前 Prompt
    applyCharBtn.addEventListener('click', () => {
    if (!loadedCharacter) return;
    const charData = loadedCharacter.data;

    // 组装 System Prompt (SillyTavern 常用格式)
    const newSystemPrompt = `You are playing the character of ${charData.name}.
        Description: ${charData.description || ''}
        Personality: ${charData.personality || ''}
        Scenario: ${charData.scenario || ''}
        Always stay in character.`;

    // 填入右侧的参数面板
    sysPromptInput.value = newSystemPrompt;

    createNewSession();

    // 如果角色卡有 First Message，让它成为新开会话的第一句话
    if (charData.first_mes) {
        appendMessageToUI('assistant', charData.first_mes);
        sessionsData[currentSessionId].messages.push({ role: 'assistant', content: charData.first_mes });
        sessionsData[currentSessionId].title = `Chat with ${charData.name}`;
        renderSessionList();
    }

    memoryModal.classList.add('hidden'); // 关闭弹窗
});