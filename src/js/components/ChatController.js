import { api } from '../api.js';
import { state } from '../store.js';
import { renderSessionList } from './SessionManager.js';
import { getSettings, getTTSVolume } from './SettingsPanel.js';
import { getSelectedOutputDevice } from './AudioSettings.js';

const messageContainer = document.getElementById('message-container');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const ttsToggleBtn = document.getElementById('tts-toggle-btn');

/**
 * Called by ASRController when the backend returns a transcript.
 * Populates the chat input and immediately submits it.
 */
export function handleASRTranscript(text) {
    if (!text) return;
    userInput.value = text;
    userInput.style.height = 'auto';
    userInput.style.height = userInput.scrollHeight + 'px';
    handleSendAction();
}

/**
 * Called by ASRController when VAD detects speech_start while the AI is
 * speaking (barge-in).  Immediately stops TTS and aborts any in-progress
 * LLM generation so the user's new utterance takes over.
 */
export function handleASRBargeIn() {
    // Stop TTS immediately
    stopTTS();
    // Abort LLM stream if one is running
    if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
    }
}

// ------------------------------------------------------------------
// Live ASR streaming bubble (streaming mode only)
// ------------------------------------------------------------------

let _liveASRBubble = null;

/**
 * Insert a temporary "live" bubble at the bottom of the chat that shows
 * streaming partial ASR text as the user speaks.
 */
export function createLiveASRBubble() {
    // Remove any leftover bubble from a previous utterance
    _liveASRBubble?.remove();

    const el = document.createElement('div');
    el.className = 'asr-live-bubble';
    el.textContent = '';
    messageContainer.appendChild(el);
    _liveASRBubble = el;
    messageContainer.scrollTop = messageContainer.scrollHeight;
}

/**
 * Overwrite the live bubble with the latest accumulated partial text.
 * Each call replaces the previous content (the text grows as chunks arrive).
 */
export function appendLiveASRText(text) {
    if (!_liveASRBubble) return;
    _liveASRBubble.textContent = text;
    messageContainer.scrollTop = messageContainer.scrollHeight;
}

/**
 * Remove the live bubble and send the final recognised text as a user message.
 */
export function commitLiveASRBubble(finalText) {
    _liveASRBubble?.remove();
    _liveASRBubble = null;
    if (finalText) {
        sendMessage(finalText);
    }
}

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
        stopTTS();
    });
    userInput.addEventListener('input', function () {
        this.style.height = '56px';
        this.style.height = (this.scrollHeight) + 'px';
    });

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

let _audioCtx = null;
let _gainNode = null;

let _ttsQueue = [];
let _isTTSProcessing = false;
let _ttsSessionAbort = null;
let _ttsNextStart = 0;          // Web Audio scheduled playback timeline
let _isFirstChunkInSession = true;
let _activeTTSPlayBtn = null;   // inline play button currently animating

function _getAudioCtx() {
    if (!_audioCtx || _audioCtx.state === 'closed') {
        _audioCtx = new AudioContext();
        _gainNode = null;
    }
    return _audioCtx;
}

function _getGainNode(ctx) {
    if (!_gainNode) {
        _gainNode = ctx.createGain();
        _gainNode.connect(ctx.destination);
    }
    _gainNode.gain.value = getTTSVolume();
    return _gainNode;
}

async function _applyOutputDevice(ctx) {
    const deviceId = getSelectedOutputDevice();
    if (deviceId && typeof ctx.setSinkId === 'function') {
        try { await ctx.setSinkId(deviceId); } catch (_) { }
    }
}

function stopTTS() {
    if (_ttsSessionAbort) {
        _ttsSessionAbort.abort();
        _ttsSessionAbort = null;
    }
    _ttsQueue = [];
    _isTTSProcessing = false;
    _ttsNextStart = 0;
    _isFirstChunkInSession = true;

    _setTTSPlayBtnPlaying(_activeTTSPlayBtn, false);
    _activeTTSPlayBtn = null;
    _setTTSTogglePlaying(false);

    // Closing AudioContext is the cleanest way to flush all pending Web Audio buffers.
    if (_audioCtx && _audioCtx.state !== 'closed') {
        _audioCtx.close().catch(() => { });
        _audioCtx = null;
        _gainNode = null;
    }
}

function _setTTSPlayBtnPlaying(btn, isPlaying) {
    if (!btn) return;
    btn.classList.toggle('playing', isPlaying);
    btn.title = isPlaying ? 'Playing... (click to stop)' : 'Play TTS';
    btn.innerHTML = isPlaying ? '⏸' : '🔊';
}

function _setTTSTogglePlaying(isPlaying) {
    // Only animate when TTS is actively enabled; avoids misleading pulse
    // when audio is triggered by the play button while TTS toggle is off.
    if (ttsToggleBtn) ttsToggleBtn.classList.toggle('playing', isPlaying && state.ttsEnabled);
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
 * Streaming audio player: schedules each PCM frame as it arrives from the
 * HTTP response body.  Designed for live-chat TTS where low first-sound
 * latency matters more than perfect gaplessness within a sentence.
 *
 * Used by processTTSQueue (live chat).
 */
async function _playNativeStream(res, ctx, abortCtrl) {
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    let sampleRate = null;
    let channels = null;
    let headerParsed = false;

    let schedulingChain = Promise.resolve();
    let chunkIndex = 0;

    const PRE_BUFFER_MS = 150;
    const SENTENCE_PAUSE_MS = 350;
    const PCM_MAGIC = 0x50434D00;

    while (true) {
        if (abortCtrl.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf);
        merged.set(value, buf.length);
        buf = merged;

        if (!headerParsed) {
            if (buf.length < 12) continue;
            const hdr = new DataView(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 12));
            if (hdr.getUint32(0, false) !== PCM_MAGIC) break;
            sampleRate = hdr.getUint32(4, false);
            channels = hdr.getUint32(8, false);
            buf = buf.slice(12);
            headerParsed = true;
        }

        while (buf.length >= 4) {
            const frameLen = new DataView(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 4)).getUint32(0, false);
            if (buf.length < 4 + frameLen) break;

            const frameSlice = buf.slice(4, 4 + frameLen);
            buf = buf.slice(4 + frameLen);

            const pcmBuf = frameSlice.buffer.slice(frameSlice.byteOffset, frameSlice.byteOffset + frameSlice.byteLength);
            const capturedSr = sampleRate;
            const capturedCh = channels;
            const capturedIndex = chunkIndex++;

            schedulingChain = schedulingChain.then(() => {
                if (abortCtrl.signal.aborted) return;
                const float32 = new Float32Array(pcmBuf);
                const numFrames = Math.floor(float32.length / capturedCh);

                if (numFrames === 0) return;

                const audioBuf = ctx.createBuffer(capturedCh, numFrames, capturedSr);
                for (let ch = 0; ch < capturedCh; ch++) {
                    audioBuf.copyToChannel(float32.subarray(ch * numFrames, (ch + 1) * numFrames), ch);
                }

                let when;
                if (_isFirstChunkInSession) {
                    when = ctx.currentTime + (PRE_BUFFER_MS / 1000);
                    _ttsNextStart = when;
                    _isFirstChunkInSession = false;
                } else {
                    if (capturedIndex === 0) {
                        _ttsNextStart += (SENTENCE_PAUSE_MS / 1000);
                    }

                    if (_ttsNextStart < ctx.currentTime) {
                        when = ctx.currentTime + 0.1;
                        _ttsNextStart = when;
                    } else {
                        when = _ttsNextStart;
                    }
                }

                const source = ctx.createBufferSource();
                source.buffer = audioBuf;
                source.connect(_getGainNode(ctx));
                source.start(when);

                _ttsNextStart = when + audioBuf.duration;
            });
        }
    }

    await schedulingChain;
}

/**
 * Batch audio player: collects ALL PCM frames from the response body, assembles
 * them into one AudioBuffer per sentence, then schedules a single AudioBufferSource.
 * Guarantees gapless within-sentence playback and consistent inter-sentence pause
 * timing regardless of how long model inference took.
 *
 * Used by executeFullTTS (play button).
 */
async function _playBatchedAudio(res, ctx, abortCtrl) {
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    let sampleRate = null;
    let channels = null;
    let headerParsed = false;
    const pcmChunks = [];
    let totalFrames = 0;
    const PCM_MAGIC = 0x50434D00;

    while (true) {
        if (abortCtrl.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf);
        merged.set(value, buf.length);
        buf = merged;

        if (!headerParsed) {
            if (buf.length < 12) continue;
            const hdr = new DataView(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 12));
            if (hdr.getUint32(0, false) !== PCM_MAGIC) break;
            sampleRate = hdr.getUint32(4, false);
            channels = hdr.getUint32(8, false);
            buf = buf.slice(12);
            headerParsed = true;
        }

        while (buf.length >= 4) {
            const frameLen = new DataView(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 4)).getUint32(0, false);
            if (buf.length < 4 + frameLen) break;
            const frameSlice = buf.slice(4, 4 + frameLen);
            buf = buf.slice(4 + frameLen);
            const float32 = new Float32Array(
                frameSlice.buffer.slice(frameSlice.byteOffset, frameSlice.byteOffset + frameSlice.byteLength)
            );
            pcmChunks.push(float32);
            totalFrames += Math.floor(float32.length / channels);
        }
    }

    if (totalFrames === 0 || abortCtrl.signal.aborted || !sampleRate) return;

    const audioBuf = ctx.createBuffer(channels, totalFrames, sampleRate);
    let offset = 0;
    for (const chunk of pcmChunks) {
        const numFrames = Math.floor(chunk.length / channels);
        for (let ch = 0; ch < channels; ch++) {
            audioBuf.copyToChannel(chunk.subarray(ch * numFrames, (ch + 1) * numFrames), ch, offset);
        }
        offset += numFrames;
    }

    const PRE_BUFFER_MS = 150;
    const SENTENCE_PAUSE_MS = 350;
    let when;

    if (_isFirstChunkInSession) {
        when = ctx.currentTime + (PRE_BUFFER_MS / 1000);
        _isFirstChunkInSession = false;
    } else {
        // Apply sentence pause relative to the end of the last scheduled audio.
        // Use Math.max to catch up gracefully if inference was slower than real-time.
        when = Math.max(_ttsNextStart, ctx.currentTime) + (SENTENCE_PAUSE_MS / 1000);
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuf;
    source.connect(_getGainNode(ctx));
    source.start(when);
    _ttsNextStart = when + audioBuf.duration;
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

// ==========================================
// Data sync and tree traversal
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
// Rendering and inline components
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

        // Branch navigator
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

        // Edit / Regenerate buttons
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

        if (msg.role === 'assistant') {
            const ttsPlayBtn = document.createElement('button');
            ttsPlayBtn.className = 'tts-play-btn';
            ttsPlayBtn.innerHTML = '🔊';
            ttsPlayBtn.title = 'Play TTS';
            ttsPlayBtn.onclick = () => {
                if (ttsPlayBtn.classList.contains('playing')) {
                    stopTTS();
                } else {
                    executeFullTTS(msg.content, ttsPlayBtn);
                }
            };
            actionRow.appendChild(ttsPlayBtn);
        }

        wrapper.appendChild(actionRow);
        messageContainer.appendChild(wrapper);
    });
    messageContainer.scrollTop = messageContainer.scrollHeight;
}

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
// Message sending and streaming
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
    let sentenceBuffer = '';

    state.abortController = new AbortController();

    stopTTS();
    _ttsSessionAbort = new AbortController();

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

                        if (state.ttsEnabled) {
                            sentenceBuffer += delta;
                            const persona = state.personasData[state.currentPersonaId];
                            const { chunks, remaining } = _extractLiveChunks(sentenceBuffer, persona);
                            sentenceBuffer = remaining;
                            for (const chunk of chunks) pushToTTSQueue(chunk);
                        }
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

        if (state.ttsEnabled && sentenceBuffer.trim()) {
            pushToTTSQueue(sentenceBuffer);
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

// ==========================================
// TTS text-splitting helpers
// ==========================================

/**
 * Split a fully-assembled text into TTS chunks for replay (old messages / executeFullTTS).
 * Uses persona TTS settings for the active model type.
 */
function _splitTextForReplay(text, persona) {
    if (state.ttsServerModelType === 'voice_clone') {
        const minChars = persona?.ttsVoiceClone?.splitChars ?? 0;
        const segs = text.split(/(?<=[.!?。！？\n]+)/);
        const chunks = [];
        let acc = '';
        for (const seg of segs) {
            acc += seg;
            if (acc.trim() && (minChars === 0 || acc.length >= minChars)) {
                chunks.push(acc);
                acc = '';
            }
        }
        if (acc.trim()) chunks.push(acc);
        return chunks;
    }

    const mode = persona?.ttsVoiceDesign?.splitMode || 'sentence';
    if (mode === 'whole')       return [text];
    if (mode === 'sentence')    return text.split(/(?<=[.!?。！？\n]+)/).filter(s => s.trim());
    if (mode === 'punctuation') return text.split(/(?<=[.!?,;:。！？，、；：…\n]+)/).filter(s => s.trim());
    if (mode === 'paragraph')   return text.split(/\n+/).filter(s => s.trim());
    return text.split(/(?<=[.!?。！？\n]+)/).filter(s => s.trim());
}

/**
 * Given the live sentenceBuffer being built as the AI streams, extract any complete
 * chunks that are ready for the TTS queue.  Returns { chunks, remaining }.
 *
 * For voice_clone: sentence split with min-chars accumulation.
 * For voice_design: split according to persona.ttsVoiceDesign.splitMode.
 *   "whole" accumulates everything — the caller flushes the remainder at stream-end.
 */
function _extractLiveChunks(buffer, persona) {
    const chunks = [];
    let remaining = buffer;

    if (state.ttsServerModelType === 'voice_clone') {
        const minChars = persona?.ttsVoiceClone?.splitChars ?? 0;
        let match;
        while ((match = remaining.match(/(.*?[.!?。！？\n]+)/)) !== null) {
            const chunk = match[1];
            // Only cut here if this chunk is long enough, OR there is more text after it
            // (so we're not holding back the last segment indefinitely).
            if (minChars > 0 && chunk.length < minChars && remaining.length === chunk.length) break;
            chunks.push(chunk);
            remaining = remaining.slice(chunk.length);
        }
        return { chunks, remaining };
    }

    const mode = persona?.ttsVoiceDesign?.splitMode || 'sentence';
    if (mode === 'whole') return { chunks: [], remaining };   // flush at stream-end

    let pattern;
    if (mode === 'sentence')    pattern = /(.*?[.!?。！？\n]+)/;
    else if (mode === 'punctuation') pattern = /(.*?[.!?,;:。！？，、；：…\n]+)/;
    else if (mode === 'paragraph')   pattern = /(.*?\n)/;
    else                             pattern = /(.*?[.!?。！？\n]+)/;

    let match;
    while ((match = remaining.match(pattern)) !== null) {
        chunks.push(match[1]);
        remaining = remaining.slice(match[1].length);
    }
    return { chunks, remaining };
}

// ==========================================
// TTS queue and playback
// ==========================================

function pushToTTSQueue(text) {
    const filtered = _filterTextForTTS(text);
    if (!filtered) return;
    _ttsQueue.push(filtered);
    processTTSQueue();
}

async function _fetchTTS(text, persona) {
    const modelType = state.ttsServerModelType;
    if (modelType === 'voice_clone') {
        const selectedAudio = (persona.ttsVoiceClone?.refAudios || []).find(a => a.selected);
        if (!selectedAudio) return null;
        return api.ttsStream({
            text,
            language: _normLang(persona.ttsVoiceClone.language),
            ref_audio_path: selectedAudio.path,
            ref_text: selectedAudio.refText || '',
        });
    } else {
        return api.ttsStream({
            text,
            language: _normLang(persona.ttsVoiceDesign.language),
            instruct: persona.ttsVoiceDesign.instruct,
        });
    }
}

/**
 * Live-chat TTS queue processor.  Processes one sentence at a time using the
 * streaming player so audio starts as soon as the first PCM frame arrives.
 */
async function processTTSQueue() {
    if (_isTTSProcessing || _ttsQueue.length === 0) return;
    _isTTSProcessing = true;

    const ctx = _getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    await _applyOutputDevice(ctx);

    const persona = state.personasData[state.currentPersonaId];
    if (!persona) {
        _isTTSProcessing = false;
        return;
    }

    _setTTSTogglePlaying(true);

    while (_ttsQueue.length > 0) {
        if (_ttsSessionAbort && _ttsSessionAbort.signal.aborted) break;

        const textChunk = _ttsQueue.shift();
        try {
            const res = await _fetchTTS(textChunk, persona);
            if (!res || !res.ok) continue;
            await _playNativeStream(res, ctx, _ttsSessionAbort);
        } catch (err) {
            if (err.name !== 'AbortError') console.error('TTS chunk error:', err);
        }
    }
    _isTTSProcessing = false;
    _setTTSTogglePlaying(false);
}

/**
 * Play button replay: processes a complete pre-existing message using the batch
 * player so each sentence is a single gapless AudioBuffer.  Runs its own
 * processing loop (bypasses the queue) and resumes queue processing when done
 * so any live-chat items enqueued concurrently are not lost.
 */
async function executeFullTTS(text, triggerBtn = null) {
    stopTTS();
    _ttsSessionAbort = new AbortController();
    const sessionAbort = _ttsSessionAbort;  // local ref survives a stopTTS() race

    _activeTTSPlayBtn = triggerBtn;
    _setTTSPlayBtnPlaying(triggerBtn, true);

    const ctx = _getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    await _applyOutputDevice(ctx);

    const persona = state.personasData[state.currentPersonaId];
    if (!persona) return;

    _isTTSProcessing = true;
    try {
        const filtered = _filterTextForTTS(text);
        for (const s of _splitTextForReplay(filtered, persona)) {
            if (sessionAbort.signal.aborted) break;
            if (!s.trim()) continue;
            try {
                const res = await _fetchTTS(s, persona);
                if (!res || !res.ok) continue;
                await _playBatchedAudio(res, ctx, sessionAbort);
            } catch (err) {
                if (err.name !== 'AbortError') console.error('TTS replay error:', err);
            }
        }

        // All PCM is scheduled into the Web Audio timeline but may not have
        // finished playing yet (fast inference RTF < 1).  Hold the playing state
        // until the last buffer actually plays out, or until the session is stopped.
        if (!sessionAbort.signal.aborted && ctx.state !== 'closed') {
            const remaining = (_ttsNextStart - ctx.currentTime) * 1000;
            if (remaining > 0) {
                await new Promise(resolve => {
                    const timer = setTimeout(resolve, remaining + 50);
                    sessionAbort.signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        resolve();
                    }, { once: true });
                });
            }
        }
    } finally {
        _isTTSProcessing = false;
        _setTTSPlayBtnPlaying(_activeTTSPlayBtn, false);
        _activeTTSPlayBtn = null;
        // Drain any live-chat items pushed while replay was running.
        processTTSQueue();
    }
}
