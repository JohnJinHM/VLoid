import { api } from '../api.js';
import { state } from '../store.js';
import { switchSession } from './ChatController.js';

const sessionListEl = document.getElementById('session-list');
const newChatBtn = document.getElementById('new-chat-btn');

export function initSessionManager() {
    newChatBtn.addEventListener('click', createNewSession);
}

export async function fetchAndRenderSessions() {
    try {
        const backendSessions = await api.getSessions();
        if (!Array.isArray(backendSessions) || backendSessions.length === 0) {
            await createNewSession(); // 【修复】加上 await
        } else {
            backendSessions.forEach(s => {
                state.sessionsData[s.id] = { title: s.title, messagesMap: {}, currentNodeId: null };
            });
            await switchSession(backendSessions[0].id);
        }
    } catch (err) {
        console.error("Failed to sync with backend:", err);
    }
}

export function renderSessionList() {
    sessionListEl.innerHTML = '';
    const sortedSessions = Object.entries(state.sessionsData).sort((a, b) => b[0].localeCompare(a[0]));

    for (const [id, session] of sortedSessions) {
        const div = document.createElement('div');
        div.className = `session-item ${id === state.currentSessionId ? 'active' : ''}`;
        div.style.display = 'flex';
        div.style.justifyContent = 'space-between';
        div.style.alignItems = 'center';

        // 标题区
        const titleSpan = document.createElement('span');
        titleSpan.textContent = session.title;
        titleSpan.style.flexGrow = '1';
        titleSpan.style.overflow = 'hidden';
        titleSpan.style.textOverflow = 'ellipsis';
        titleSpan.style.whiteSpace = 'nowrap';

        // 按钮操作区
        const actionsDiv = document.createElement('div');
        actionsDiv.style.display = 'flex';
        actionsDiv.style.gap = '8px';

        // 原始删除按钮
        const delBtn = document.createElement('button');
        delBtn.innerHTML = '🗑️';
        delBtn.title = 'Delete Session';
        delBtn.style.cssText = "background: none; border: none; cursor: pointer; opacity: 0.7; transition: 0.2s;";
        delBtn.onmouseover = () => delBtn.style.opacity = '1';
        delBtn.onmouseout = () => delBtn.style.opacity = '0.7';

        // 确认删除按钮 (默认隐藏)
        const confirmBtn = document.createElement('button');
        confirmBtn.innerHTML = '✔️';
        confirmBtn.title = 'Confirm Delete';
        confirmBtn.style.cssText = "background: none; border: none; cursor: pointer; color: #4caf50; display: none;";

        // 取消删除按钮 (默认隐藏)
        const cancelBtn = document.createElement('button');
        cancelBtn.innerHTML = '❌';
        cancelBtn.title = 'Cancel';
        cancelBtn.style.cssText = "background: none; border: none; cursor: pointer; color: #ff6b6b; display: none;";

        // --- 事件绑定 ---

        // 点击垃圾桶：隐藏垃圾桶，显示确认和取消
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            delBtn.style.display = 'none';
            confirmBtn.style.display = 'inline-block';
            cancelBtn.style.display = 'inline-block';
        });

        // 点击取消：恢复原状
        cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            delBtn.style.display = 'inline-block';
            confirmBtn.style.display = 'none';
            cancelBtn.style.display = 'none';
        });

        // 点击确认：执行删除逻辑 (不再使用原生 confirm)
        confirmBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await deleteSession(id);
        });

        // 组装 DOM
        actionsDiv.append(delBtn, confirmBtn, cancelBtn);
        div.append(titleSpan, actionsDiv);

        // 点击整行切换会话
        div.addEventListener('click', () => switchSession(id));
        sessionListEl.appendChild(div);
    }
}

export async function createNewSession() {
    const newId = "session_" + Date.now();
    state.sessionsData[newId] = { title: `New Chat`, messagesMap: {}, currentNodeId: null };
    await switchSession(newId); // 【修复】必须 await 保证状态切换完毕
}

async function deleteSession(id) {
    try {
        await api.deleteSession(id);
        delete state.sessionsData[id];

        const remainingIds = Object.keys(state.sessionsData);

        if (remainingIds.length === 0) {
            await createNewSession();
        } else if (id === state.currentSessionId) {
            await switchSession(remainingIds[0]);
        } else {
            renderSessionList();
        }

        setTimeout(() => {
            const userInput = document.getElementById('user-input');
            if (userInput) {
                userInput.disabled = false;
                userInput.focus();
            }
        }, 50);
    } catch (error) {
        console.error("Failed to delete session:", error);
    }
}