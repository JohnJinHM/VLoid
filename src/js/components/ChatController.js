import { api } from '../api.js';
import { state } from '../store.js';
import { renderSessionList } from './SessionManager.js';
import { getSettings } from './SettingsPanel.js';

const messageContainer = document.getElementById('message-container');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');

export function initChatController() {
    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendAction();
        }
    });

    sendBtn.addEventListener('click', handleSendAction);

    stopBtn.addEventListener('click', () => {
        if (state.abortController) {
            state.abortController.abort();
            state.abortController = null;
        }
    });

    userInput.addEventListener('input', function () {
        this.style.height = '56px';
        this.style.height = (this.scrollHeight) + 'px';
    });
}

// ==========================================
// 1. 数据同步与树状提取逻辑
// ==========================================
export async function syncMessages(sessionId) {
    try {
        const rawMessages = await api.getMessages(sessionId);
        const session = state.sessionsData[sessionId];
        session.messagesMap = {};
        rawMessages.forEach(msg => { session.messagesMap[msg.id] = msg; });
        return rawMessages;
    } catch (err) {
        console.error("Failed to sync messages:", err);
        return [];
    }
}

function getCurrentBranch(sessionId) {
    const session = state.sessionsData[sessionId];
    if (!session || !session.currentNodeId || !session.messagesMap) return [];

    const branch = [];
    let currId = session.currentNodeId;
    while (currId && session.messagesMap[currId]) {
        const msg = session.messagesMap[currId];
        branch.unshift(msg);
        currId = msg.parent_id;
    }
    return branch;
}

function getLatestLeafId(startNodeId, messagesMap) {
    let currentId = startNodeId;
    while (true) {
        const children = Object.values(messagesMap).filter(m => m.parent_id === currentId);
        if (children.length === 0) return currentId;
        children.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        currentId = children[0].id;
    }
}

// ==========================================
// 2. 渲染逻辑与内联组件
// ==========================================
export async function switchSession(sessionId) {
    if (state.currentSessionId === sessionId) return;
    if (!state.sessionsData[sessionId]) return;

    state.currentSessionId = sessionId;

    const rawMessages = await syncMessages(sessionId);
    const session = state.sessionsData[sessionId];

    if (!session) return;

    if (!session.currentNodeId && rawMessages.length > 0) {
        session.currentNodeId = rawMessages[rawMessages.length - 1].id;
    }

    renderSessionList();
    renderChatBranch(sessionId);

    setTimeout(() => {
        const userInput = document.getElementById('user-input');
        if (userInput) {
            userInput.focus();
        }
    }, 50);
}

function renderChatBranch(sessionId) {
    messageContainer.innerHTML = '';
    const branchMessages = getCurrentBranch(sessionId);
    const session = state.sessionsData[sessionId];

    branchMessages.forEach(msg => {
        if (msg.role === 'system') return;

        const wrapper = document.createElement('div');
        wrapper.className = `message-wrapper ${msg.role}-wrapper`;
        wrapper.style.display = 'flex';
        wrapper.style.flexDirection = 'column';
        wrapper.style.alignItems = msg.role === 'user' ? 'flex-end' : 'flex-start';
        wrapper.style.marginBottom = '24px';

        const bubble = document.createElement('div');
        bubble.classList.add('message', msg.role);
        bubble.textContent = msg.content;
        wrapper.appendChild(bubble);

        const actionRow = document.createElement('div');
        actionRow.className = 'message-actions';
        actionRow.style.display = 'flex';
        actionRow.style.gap = '15px';
        actionRow.style.marginTop = '6px';
        actionRow.style.padding = '0 5px';
        actionRow.style.fontSize = '0.85rem';
        actionRow.style.color = '#888';

        // 分支切换器 < 1 / 2 >
        const siblings = Object.values(session.messagesMap).filter(m => m.parent_id === msg.parent_id);
        if (siblings.length > 1) {
            siblings.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            const currentIndex = siblings.findIndex(m => m.id === msg.id);

            const branchSelector = document.createElement('div');
            branchSelector.style.display = 'flex';
            branchSelector.style.alignItems = 'center';
            branchSelector.style.gap = '8px';

            const createNavBtn = (text, isDisabled, targetNodeId) => {
                const btn = document.createElement('button');
                btn.textContent = text;
                btn.disabled = isDisabled;
                btn.style.background = 'none';
                btn.style.border = 'none';
                btn.style.color = isDisabled ? '#444' : '#888';
                btn.style.cursor = isDisabled ? 'not-allowed' : 'pointer';
                if (!isDisabled) {
                    btn.onclick = () => {
                        session.currentNodeId = getLatestLeafId(targetNodeId, session.messagesMap);
                        renderChatBranch(sessionId);
                    };
                }
                return btn;
            };

            branchSelector.appendChild(createNavBtn('◀', currentIndex === 0, siblings[currentIndex - 1]?.id));
            const label = document.createElement('span');
            label.textContent = `${currentIndex + 1} / ${siblings.length}`;
            branchSelector.appendChild(label);
            branchSelector.appendChild(createNavBtn('▶', currentIndex === siblings.length - 1, siblings[currentIndex + 1]?.id));
            actionRow.appendChild(branchSelector);
        }

        // Edit / Regenerate 按钮
        const actionBtn = document.createElement('button');
        actionBtn.style.background = 'none';
        actionBtn.style.border = 'none';
        actionBtn.style.color = '#5b6ea0';
        actionBtn.style.cursor = 'pointer';

        if (msg.role === 'user') {
            actionBtn.innerHTML = '✏️';
            actionBtn.onclick = () => enableInlineEdit(wrapper, bubble, msg, sessionId);
        } else if (msg.role === 'assistant') {
            actionBtn.innerHTML = '🔄';
            actionBtn.onclick = () => {
                // 重新生成：向上找它的提问节点，然后以此为起点再发一次请求
                const userMsg = session.messagesMap[msg.parent_id];
                if (userMsg) sendMessage(userMsg.content, userMsg.parent_id);
            };
        }

        actionRow.appendChild(actionBtn);
        wrapper.appendChild(actionRow);
        messageContainer.appendChild(wrapper);
    });

    messageContainer.scrollTop = messageContainer.scrollHeight;
}

// 【新增】内联气泡编辑逻辑
function enableInlineEdit(wrapper, bubbleDOM, msg, sessionId) {
    const actionRow = wrapper.querySelector('.message-actions');
    actionRow.style.display = 'none'; // 隐藏底下的操作按钮

    const textarea = document.createElement('textarea');
    textarea.value = msg.content;
    textarea.style.cssText = `
        width: 100%;
        min-width: 300px;
        min-height: 80px;
        background: #1e1e1e;
        color: #e0e0e0;
        border: 1px solid #5b6ea0;
        border-radius: 8px;
        padding: 12px;
        font-family: inherit;
        font-size: 0.95rem;
        resize: vertical;
        outline: none;
        line-height: 1.5;
    `;

    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = "margin-top: 10px; display: flex; gap: 10px; justify-content: flex-end;";

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = "padding: 6px 16px; background: transparent; color: #aaa; border: 1px solid #555; border-radius: 6px; cursor: pointer;";
    cancelBtn.onclick = () => renderChatBranch(sessionId); // 点击取消，恢复原状

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Submit';
    saveBtn.style.cssText = "padding: 6px 16px; background: #5b6ea0; color: white; border: none; border-radius: 6px; cursor: pointer;";
    saveBtn.onclick = () => {
        const newText = textarea.value.trim();
        if (!newText) return;
        // 把修改后的文本发出，并指示它应该作为被修改消息的"兄弟"（挂载在同一父级下）
        sendMessage(newText, msg.parent_id);
    };

    btnContainer.append(cancelBtn, saveBtn);

    bubbleDOM.innerHTML = ''; // 清空原有文本
    bubbleDOM.style.background = 'transparent'; // 移除气泡背景色
    bubbleDOM.style.border = 'none';
    bubbleDOM.style.padding = '0';
    bubbleDOM.appendChild(textarea);
    bubbleDOM.appendChild(btnContainer);

    textarea.focus();
}

// ==========================================
// 3. 消息发送与流式请求
// ==========================================
function handleSendAction() {
    const text = userInput.value.trim();
    if (!text) return;
    sendMessage(text);
}

async function sendMessage(text, parentIdOverride = undefined) {
    const sessionId = state.currentSessionId;
    const session = state.sessionsData[sessionId];

    if (!session) {
        console.error("Critical State Error: Current session is undefined.");
        return;
    }

    const parentId = parentIdOverride !== undefined ? parentIdOverride : session.currentNodeId;

    const settings = getSettings();
    const branchMessages = getCurrentBranch(sessionId);

    let historyToSend = [];
    if (parentId !== null && parentId !== undefined) {
        const parentIndex = branchMessages.findIndex(m => m.id === parentId);
        historyToSend = parentIndex !== -1 ? branchMessages.slice(0, parentIndex + 1) : [];
    }

    session.currentNodeId = parentId;
    renderChatBranch(sessionId);

    const payloadMessages = [
        { role: 'system', content: settings.system_prompt },
        ...historyToSend.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: text }
    ];

    const payload = {
        session_id: sessionId,
        parent_id: parentId, // 如果是编辑第一句话，这里会向后端发送 null，作为新的根节点
        messages: payloadMessages,
        temperature: settings.temperature,
        top_p: settings.top_p,
        repetition_penalty: settings.repetition_penalty,
        max_tokens: settings.max_tokens,
        use_rag: settings.use_rag
    };

    userInput.value = '';
    userInput.style.height = '56px';
    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');

    createTempMessageDOM('user', text);
    const aiMsgNode = createTempMessageDOM('assistant', '...');
    let aiFullText = '';

    state.abortController = new AbortController();

    try {
        const response = await api.chatStream(payload, state.abortController.signal);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        aiMsgNode.textContent = '';
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
                        aiFullText += delta;
                        aiMsgNode.textContent = aiFullText;

                        const isAtBottom = messageContainer.scrollHeight - messageContainer.scrollTop <= messageContainer.clientHeight + 50;
                        if (isAtBottom) messageContainer.scrollTop = messageContainer.scrollHeight;
                    } catch (err) { }
                }
            }
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            aiMsgNode.textContent += ' ⏹ [Stopped]';
        } else {
            console.error("Chat Error:", error);
            aiMsgNode.textContent = "❌ Error: " + error.message;
            aiMsgNode.style.color = "#ff6b6b";
        }
    } finally {
        sendBtn.classList.remove('hidden');
        stopBtn.classList.add('hidden');
        userInput.focus();
        state.abortController = null;

        const rawMessages = await syncMessages(sessionId);
        if (rawMessages.length > 0) {
            session.currentNodeId = rawMessages[rawMessages.length - 1].id;
        }

        renderChatBranch(sessionId);

        if (Object.keys(session.messagesMap).length <= 2) {
            session.title = text.substring(0, 15) + (text.length > 15 ? '...' : '');
            renderSessionList();
        }
    }
}

function createTempMessageDOM(role, content) {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${role}-wrapper`;
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.alignItems = role === 'user' ? 'flex-end' : 'flex-start';
    wrapper.style.marginBottom = '24px';

    const div = document.createElement('div');
    div.classList.add('message', role);
    div.textContent = content;

    wrapper.appendChild(div);
    messageContainer.appendChild(wrapper);
    messageContainer.scrollTop = messageContainer.scrollHeight;

    return div;
}