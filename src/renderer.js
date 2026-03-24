const API_BASE = "http://127.0.0.1:3000";
let currentSessionId = "session_" + Date.now();
let messageHistory = [];

// UI 元素
const messageContainer = document.getElementById('message-container');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const sysPromptInput = document.getElementById('sys-prompt');
const tempSlider = document.getElementById('temp-slider');
const tokensSlider = document.getElementById('tokens-slider');

// 参数实时反馈显示
tempSlider.addEventListener('input', (e) => document.getElementById('temp-val').innerText = e.target.value);
tokensSlider.addEventListener('input', (e) => document.getElementById('tokens-val').innerText = e.target.value);

// 快捷键发送 (Enter发送，Shift+Enter换行)
userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
sendBtn.addEventListener('click', sendMessage);

function appendMessageToUI(role, content) {
    const div = document.createElement('div');
    div.classList.add('message', role);
    div.textContent = content;
    messageContainer.appendChild(div);
    messageContainer.scrollTop = messageContainer.scrollHeight;
    return div; // 返回DOM节点以便流式更新
}

async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    // 1. 更新 UI 和历史记录
    userInput.value = '';
    appendMessageToUI('user', text);
    messageHistory.push({ role: 'user', content: text });

    // 2. 准备发往 FastAPI 的数据
    const payload = {
        session_id: currentSessionId,
        messages: [
            { role: 'system', content: sysPromptInput.value },
            ...messageHistory
        ],
        temperature: parseFloat(tempSlider.value),
        max_tokens: parseInt(tokensSlider.value),
        use_rag: document.getElementById('rag-toggle').checked
    };

    sendBtn.disabled = true;
    const assistantMsgNode = appendMessageToUI('assistant', ''); // 预留空气泡用于流式输出
    let assistantFullText = '';

    try {
        // 3. 发起流式请求 (SSE)
        const response = await fetch(`${API_BASE}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        // 解析 SSE 流
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
                        // 兼容 OpenAI 格式的数据块
                        const delta = dataObj.choices[0]?.delta?.content || '';
                        assistantFullText += delta;
                        assistantMsgNode.textContent = assistantFullText; // 更新UI
                        messageContainer.scrollTop = messageContainer.scrollHeight;
                    } catch (err) {
                        console.error("Parse JSON stream error:", err, dataStr);
                    }
                }
            }
        }

        // 回答结束后，将其存入历史记录
        messageHistory.push({ role: 'assistant', content: assistantFullText });

    } catch (error) {
        console.error("Chat Error:", error);
        assistantMsgNode.textContent = "❌ Error connecting to backend: " + error.message;
        assistantMsgNode.style.color = "#ff5555";
    } finally {
        sendBtn.disabled = false;
        userInput.focus();
    }
}