import { api } from '../api.js';
import { state } from '../store.js';
import { renderSessionList } from './SessionManager.js';
import { getSettings, getTTSVolume, getTTSSplitMode, getTTSNativeStreaming } from './SettingsPanel.js';
import { getSelectedOutputDevice } from './AudioSettings.js';

const messageContainer = document.getElementById('message-container');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const ttsToggleBtn = document.getElementById('tts-toggle-btn');

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

    // TTS 开关按钮
    if (ttsToggleBtn) {
        ttsToggleBtn.addEventListener('click', toggleTTS);
        updateTTSButtonUI();
    }
}

export function getAudioCtxState() {
    return _audioCtx ? _audioCtx.state : 'none';
}

// ==========================================
// AudioContext for TTS playback
// ==========================================

let _audioCtx  = null;
let _gainNode  = null;
let _ttsSource = null;
let _ttsAbort  = null;   // AbortController for in-flight TTS requests

function _getAudioCtx() {
    if (!_audioCtx || _audioCtx.state === 'closed') {
        _audioCtx = new AudioContext();
        _gainNode = null;   // Gain node is tied to the context; reset with it
    }
    return _audioCtx;
}

/**
 * Returns the GainNode for volume control, creating it if necessary.
 * The gain value is refreshed from settings on every call so volume changes
 * take effect at the start of the next chunk.
 */
function _getGainNode(ctx) {
    if (!_gainNode) {
        _gainNode = ctx.createGain();
        _gainNode.connect(ctx.destination);
    }
    _gainNode.gain.value = getTTSVolume();
    return _gainNode;
}

/**
 * Route the AudioContext to the user-selected output device.
 * AudioContext.setSinkId() is supported in Chromium/Electron ≥ 110.
 */
async function _applyOutputDevice(ctx) {
    const deviceId = getSelectedOutputDevice();
    if (deviceId && typeof ctx.setSinkId === 'function') {
        try { await ctx.setSinkId(deviceId); } catch (_) {}
    }
}

/**
 * Filter AI response text before sending to TTS.
 * Removes non-speakable elements while preserving natural punctuation so the
 * sentence/punctuation split modes still work correctly.
 *
 * Handles English, Chinese, and Japanese text.
 */
function _filterTextForTTS(text) {
    let t = text;

    // Remove <think>...</think> and <thinking>...</thinking> (model CoT blocks)
    t = t.replace(/<think(?:ing)?[\s\S]*?<\/think(?:ing)?>/gi, '');

    // Remove fenced code blocks  (``` ... ```)
    t = t.replace(/```[\s\S]*?```/g, '');

    // Remove inline code  (`...`)
    t = t.replace(/`[^`\n]+`/g, '');

    // Remove markdown headers  (# Heading)
    t = t.replace(/^#{1,6}\s+/gm, '');

    // Strip markdown bold/italic markers, keep the inner text
    // **bold** / *italic* / __bold__ / _italic_
    t = t.replace(/\*{1,3}([^*\n]*)\*{1,3}/g, '$1');
    t = t.replace(/_{1,3}([^_\n]*)_{1,3}/g, '$1');

    // Remove any remaining HTML/XML tags (e.g. <br>, <|special|> model tokens)
    t = t.replace(/<[^>]{0,200}>/g, '');

    // Remove emojis — covers Emoji_Presentation + Extended_Pictographic ranges
    // These Unicode property escapes require ES2018+ (supported in Electron/Chrome)
    t = t.replace(/\p{Emoji_Presentation}/gu, '');
    t = t.replace(/\p{Extended_Pictographic}/gu, '');

    // Collapse multiple spaces/tabs but preserve newlines (needed for paragraph mode)
    t = t.replace(/[ \t]+/g, ' ');
    t = t.replace(/\n{3,}/g, '\n\n');

    return t.trim();
}

/**
 * executeTTS — entry point for all TTS playback.
 * Routes to native PCM streaming or batch WAV streaming based on settings.
 */
async function executeTTS(text) {
    text = _filterTextForTTS(text);
    if (!text) return;

    const persona = state.personasData[state.currentPersonaId];
    if (!persona) return;

    // Cancel any previous TTS playback / request
    if (_ttsAbort) { _ttsAbort.abort(); _ttsAbort = null; }
    if (_ttsSource) {
        try { _ttsSource.stop(); } catch (_) {}
        _ttsSource = null;
    }

    const ctx = _getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    await _applyOutputDevice(ctx);

    const abortCtrl = new AbortController();
    _ttsAbort = abortCtrl;

    try {
        const useNative = getTTSNativeStreaming();
        const splitMode = getTTSSplitMode();
        let res;

        if (persona.ttsMode === 'voice_clone') {
            const selectedAudio = (persona.ttsVoiceClone?.refAudios || []).find(a => a.selected);
            if (!selectedAudio) {
                console.error('TTS: No reference audio selected for voice clone.');
                return;
            }
            if (!selectedAudio.exists) {
                console.error(`TTS: Reference audio "${selectedAudio.filename}" is missing.`);
                return;
            }
            const payload = {
                text,
                language:       _normLang(persona.ttsVoiceClone.language),
                ref_audio_path: selectedAudio.path,
                ref_text:       selectedAudio.refText || '',
                split_mode:     splitMode,
            };
            res = useNative
                ? await api.ttsVoiceCloneStreamNative(payload)
                : await api.ttsVoiceCloneStream(payload);
        } else {
            const payload = {
                text,
                language:   _normLang(persona.ttsVoiceDesign.language),
                instruct:   persona.ttsVoiceDesign.instruct,
                split_mode: splitMode,
            };
            res = useNative
                ? await api.ttsVoiceDesignStreamNative(payload)
                : await api.ttsVoiceDesignStream(payload);
        }

        if (!res.ok) {
            console.error('TTS request failed:', res.status, await res.text());
            return;
        }

        if (useNative) {
            await _playNativeStream(res, ctx, abortCtrl);
        } else {
            await _playBatchStream(res, ctx, abortCtrl);
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('TTS playback error:', err);
        }
    } finally {
        if (_ttsAbort === abortCtrl) _ttsAbort = null;
    }
}

/**
 * _playBatchStream — plays sentence-level WAV chunks from the batch streaming endpoints.
 * Wire format: [4-byte uint32 BE length][WAV bytes]  repeated per sentence.
 *
 * Scheduling model: chunks are pre-scheduled in the Web Audio timeline as soon as
 * they are decoded — no waiting for the previous chunk to finish playing.
 * nextStart tracks the scheduled end-time of the last chunk so the next one can
 * be placed immediately after it with zero gap.
 */
async function _playBatchStream(res, ctx, abortCtrl) {
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    // schedulingChain serialises decodeAudioData calls and nextStart updates.
    // Each item resolves as soon as source.start() is called — NOT after onended.
    let schedulingChain = Promise.resolve();
    let lastSourcePromise = Promise.resolve();   // tracks when the final chunk ends
    let nextStart = 0;

    while (true) {
        if (abortCtrl.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf);
        merged.set(value, buf.length);
        buf = merged;

        while (buf.length >= 4) {
            const frameLen = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
            if (buf.length < 4 + frameLen) break;

            const wavBytes = buf.slice(4, 4 + frameLen).buffer;
            buf = buf.slice(4 + frameLen);

            schedulingChain = schedulingChain.then(async () => {
                if (abortCtrl.signal.aborted) return;
                try {
                    const audioBuffer = await ctx.decodeAudioData(wavBytes);
                    const source = ctx.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(_getGainNode(ctx));
                    _ttsSource = source;
                    const when = Math.max(ctx.currentTime, nextStart);
                    source.start(when);
                    nextStart = when + audioBuffer.duration;
                    // Record end-of-last-chunk promise; do NOT await here so the next
                    // chunk gets scheduled without waiting for this one to finish.
                    lastSourcePromise = new Promise(resolve => { source.onended = resolve; });
                } catch (e) {
                    console.error('TTS WAV chunk error:', e);
                }
            });
        }
    }
    await schedulingChain;       // all chunks scheduled
    await lastSourcePromise;     // last chunk finished playing
}

/**
 * _playNativeStream — plays raw float32 PCM frames from the native streaming endpoints.
 * Wire format:
 *   Header : b'PCM\0' (4) + uint32 BE sample_rate (4) + uint32 BE channels (4)
 *   Frames : uint32 BE byte_length (4) + float32 LE PCM bytes  (repeated)
 */
async function _playNativeStream(res, ctx, abortCtrl) {
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    let sampleRate = null;
    let channels = null;
    let headerParsed = false;
    // Same eager-scheduling pattern as _playBatchStream: no onended inside the chain.
    let schedulingChain = Promise.resolve();
    let lastSourcePromise = Promise.resolve();
    let nextStart = 0;

    const PCM_MAGIC = 0x50434D00;  // b'PCM\0'

    while (true) {
        if (abortCtrl.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf);
        merged.set(value, buf.length);
        buf = merged;

        // Parse 12-byte header on first receive
        if (!headerParsed) {
            if (buf.length < 12) continue;
            const hdr = new DataView(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 12));
            if (hdr.getUint32(0, false) !== PCM_MAGIC) {
                console.error('TTS native: unexpected stream magic');
                break;
            }
            sampleRate = hdr.getUint32(4, false);
            channels   = hdr.getUint32(8, false);
            buf = buf.slice(12);
            headerParsed = true;
        }

        // Parse PCM frames
        while (buf.length >= 4) {
            const frameLen = new DataView(
                buf.buffer.slice(buf.byteOffset, buf.byteOffset + 4)
            ).getUint32(0, false);
            if (buf.length < 4 + frameLen) break;

            const frameSlice = buf.slice(4, 4 + frameLen);
            buf = buf.slice(4 + frameLen);

            // Copy bytes into a fresh ArrayBuffer before handing off to the chain
            const pcmBuf = frameSlice.buffer.slice(
                frameSlice.byteOffset,
                frameSlice.byteOffset + frameSlice.byteLength
            );
            const capturedSr = sampleRate;
            const capturedCh = channels;

            schedulingChain = schedulingChain.then(() => {
                if (abortCtrl.signal.aborted) return;
                // PCM → AudioBuffer is fully synchronous; no async decode needed.
                const float32 = new Float32Array(pcmBuf);
                const numFrames = Math.floor(float32.length / capturedCh);
                const audioBuf = ctx.createBuffer(capturedCh, numFrames, capturedSr);
                for (let ch = 0; ch < capturedCh; ch++) {
                    audioBuf.copyToChannel(
                        float32.subarray(ch * numFrames, (ch + 1) * numFrames), ch
                    );
                }
                const source = ctx.createBufferSource();
                source.buffer = audioBuf;
                source.connect(_getGainNode(ctx));
                _ttsSource = source;
                const when = Math.max(ctx.currentTime, nextStart);
                source.start(when);
                nextStart = when + audioBuf.duration;
                lastSourcePromise = new Promise(resolve => { source.onended = resolve; });
            });
        }
    }
    await schedulingChain;       // all chunks scheduled
    await lastSourcePromise;     // last chunk finished playing
}

// ==========================================
// TTS Toggle
// ==========================================

function toggleTTS() {
    state.ttsEnabled = !state.ttsEnabled;
    // Prime AudioContext during this user gesture so it starts in 'running' state.
    if (state.ttsEnabled) {
        const ctx = _getAudioCtx();
        if (ctx.state === 'suspended') ctx.resume();
    }
    updateTTSButtonUI();
}

function updateTTSButtonUI() {
    if (!ttsToggleBtn) return;
    if (state.ttsEnabled) {
        ttsToggleBtn.classList.add('active');
        ttsToggleBtn.title = 'TTS Enabled (click to disable)';
    } else {
        ttsToggleBtn.classList.remove('active');
        ttsToggleBtn.title = 'TTS Disabled (click to enable)';
    }
}

// Normalize language value: frontend select uses "auto", model expects "Auto"
function _normLang(lang) {
    const v = (lang || 'auto').trim();
    return v === 'auto' ? 'Auto' : v;
}

/** Auto-play after AI response — filters text then respects the TTS toggle. */
async function requestTTS(text) {
    if (!state.ttsEnabled) return;
    const filtered = _filterTextForTTS(text);
    if (!filtered) return;
    await executeTTS(filtered);
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
                const userMsg = session.messagesMap[msg.parent_id];
                if (userMsg) sendMessage(userMsg.content, userMsg.parent_id);
            };
        }
        actionRow.appendChild(actionBtn);

        // AI 消息额外添加 TTS 播放按钮
        if (msg.role === 'assistant') {
            const ttsPlayBtn = document.createElement('button');
            ttsPlayBtn.style.background = 'none';
            ttsPlayBtn.style.border = 'none';
            ttsPlayBtn.style.color = '#5b6ea0';
            ttsPlayBtn.style.cursor = 'pointer';
            ttsPlayBtn.innerHTML = '🔊';
            ttsPlayBtn.title = 'Play TTS';
            ttsPlayBtn.onclick = () => executeTTS(msg.content);
            actionRow.appendChild(ttsPlayBtn);
        }

        wrapper.appendChild(actionRow);
        messageContainer.appendChild(wrapper);
    });
    messageContainer.scrollTop = messageContainer.scrollHeight;
}

// 内联气泡编辑逻辑
function enableInlineEdit(wrapper, bubbleDOM, msg, sessionId) {
    const actionRow = wrapper.querySelector('.message-actions');
    actionRow.style.display = 'none';

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
    cancelBtn.onclick = () => renderChatBranch(sessionId);

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Submit';
    saveBtn.style.cssText = "padding: 6px 16px; background: #5b6ea0; color: white; border: none; border-radius: 6px; cursor: pointer;";
    saveBtn.onclick = () => {
        const newText = textarea.value.trim();
        if (!newText) return;
        sendMessage(newText, msg.parent_id);
    };

    btnContainer.append(cancelBtn, saveBtn);
    bubbleDOM.innerHTML = '';
    bubbleDOM.style.background = 'transparent';
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
        parent_id: parentId,
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

        // 流式回复完成后，尝试 TTS
        if (aiFullText && state.ttsEnabled) {
            requestTTS(aiFullText);
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