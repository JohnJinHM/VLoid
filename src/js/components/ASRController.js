/**
 * ASRController.js
 *
 * Full-duplex speech input using FunASR (backend) + Web Audio API (frontend).
 *
 * Responsibilities:
 *   - Capture microphone audio with AEC/ANS/AGC via getUserMedia constraints.
 *   - Stream 16-bit PCM (16 kHz, mono) to the backend WebSocket continuously.
 *   - React to VAD events from the backend:
 *       speech_start → enable barge-in (stop TTS if AI is speaking);
 *                      in streaming mode, open a live chat bubble.
 *       partial      → update live bubble with growing recognised text (streaming mode).
 *       transcript   → in streaming mode, commit live bubble and send message;
 *                      in non-streaming mode, insert text into input and auto-send.
 *   - Expose start/stop controls and a live status indicator to the UI.
 *   - Persist "streaming enabled" preference in localStorage.
 */

import { state } from '../store.js';
import { getSelectedInputDevice } from './AudioSettings.js';
import {
    handleASRTranscript,
    handleASRBargeIn,
    createLiveASRBubble,
    appendLiveASRText,
    commitLiveASRBubble,
} from './ChatController.js';

const ASR_WS_URL  = 'ws://127.0.0.1:3000/api/asr/ws';
const SAMPLE_RATE = 16000;
const LS_STREAMING = 'asr_streaming_enabled';

const logger = {
    info:  (...a) => console.log('[ASRController]', ...a),
    warn:  (...a) => console.warn('[ASRController]', ...a),
    error: (...a) => console.error('[ASRController]', ...a),
};

// ScriptProcessor frame size — 4096 samples ≈ 256 ms; small enough for low
// latency, large enough to avoid callback starvation on slower machines.
const FRAME_SIZE  = 4096;

// ------------------------------------------------------------------
// Module-level state
// ------------------------------------------------------------------

let _ws          = null;
let _audioCtx    = null;
let _sourceNode  = null;
let _procNode    = null;
let _micStream   = null;
let _isListening = false;
let _asrLoaded   = false;    // reported by backend on connect

// Whether the backend reports that the streaming model is loaded and available.
// Set once from the 'status' message; does not change per-utterance.
let _serverStreamingAvailable = false;

// Whether streaming is active for the current utterance.
// Re-evaluated at each speech_start so toggle changes take effect immediately.
let _streamingActive = false;

// Mic button DOM reference
let _micBtn = null;

// Callbacks installed by the host (ChatController / renderer)
let _onTranscript   = null;  // (text: string) => void
let _onSpeechStart  = null;  // () => void  — barge-in hook
let _onStatusChange = null;  // (listening: bool) => void

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Called by renderer.js once the DOM is ready.
 * Binds the mic button, wires callbacks, and sets up the streaming toggle.
 */
export function initASRController() {
    _micBtn = document.getElementById('asr-mic-btn');

    setASRCallbacks({
        onTranscript:   handleASRTranscript,
        onSpeechStart:  handleASRBargeIn,
        onStatusChange: _updateMicButtonUI,
    });

    if (_micBtn) {
        _micBtn.addEventListener('click', async () => {
            if (_isListening) {
                stopListening();
            } else {
                await startListening();
            }
        });
    }

    // Wire streaming toggle in Settings
    const streamingToggle = document.getElementById('asr-streaming-toggle');
    if (streamingToggle) {
        streamingToggle.checked = localStorage.getItem(LS_STREAMING) === 'true';
        streamingToggle.addEventListener('change', () => {
            localStorage.setItem(LS_STREAMING, streamingToggle.checked ? 'true' : 'false');
            // Notify the server immediately if the mic is already open
            if (_ws && _ws.readyState === WebSocket.OPEN) {
                _ws.send(JSON.stringify({ type: 'control', streaming: streamingToggle.checked }));
            }
        });
    }
}

function _updateMicButtonUI(listening) {
    state.asrListening = listening;
    if (!_micBtn) return;
    _micBtn.classList.toggle('active', listening);
    _micBtn.title = listening ? 'Stop microphone (ASR active)' : 'Start microphone (ASR)';
}

/**
 * Register callbacks before calling startListening().
 *   onTranscript(text)  — called with every recognised utterance (non-streaming)
 *   onSpeechStart()     — called when VAD detects speech (use for barge-in)
 *   onStatusChange(bool)— called when listening state changes
 */
export function setASRCallbacks({ onTranscript, onSpeechStart, onStatusChange }) {
    _onTranscript   = onTranscript   || null;
    _onSpeechStart  = onSpeechStart  || null;
    _onStatusChange = onStatusChange || null;
}

/**
 * Start capturing the microphone and streaming to the backend ASR WebSocket.
 * No-op if already listening.
 */
export async function startListening() {
    if (_isListening) return;

    try {
        await _openWebSocket();
        await _startMic();
        _isListening = true;
        _onStatusChange?.(true);
    } catch (err) {
        logger.error('Failed to start listening:', err);
        _cleanup();
    }
}

/**
 * Stop capturing and close the WebSocket.
 */
export function stopListening() {
    if (!_isListening) return;
    _cleanup();
    _isListening = false;
    _streamingActive = false;
    _onStatusChange?.(false);
}

export function isListening() { return _isListening; }

// ------------------------------------------------------------------
// WebSocket
// ------------------------------------------------------------------

function _openWebSocket() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(ASR_WS_URL);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            _ws = ws;
            // Inform backend whether streaming mode is requested
            const streamingRequested = localStorage.getItem(LS_STREAMING) === 'true';
            ws.send(JSON.stringify({ type: 'control', streaming: streamingRequested }));
            resolve();
        };

        ws.onmessage = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                _handleServerMessage(msg);
            } catch (_) { }
        };

        ws.onerror = (err) => {
            logger.error('WebSocket error:', err);
            if (!_ws) reject(new Error('WebSocket failed to open'));
        };

        ws.onclose = (ev) => {
            if (_isListening) {
                logger.warn('WebSocket closed unexpectedly:', ev.code, ev.reason);
                _cleanup();
                _isListening    = false;
                _streamingActive = false;
                _onStatusChange?.(false);
            }
        };

        // Timeout if backend is unreachable
        setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                ws.close();
                reject(new Error('ASR WebSocket connection timed out'));
            }
        }, 5000);
    });
}

function _handleServerMessage(msg) {
    switch (msg.type) {
        case 'status':
            _asrLoaded = msg.loaded;
            _serverStreamingAvailable = msg.streaming_available === true;
            if (!_asrLoaded) {
                logger.warn('Backend ASR model not loaded.');
                stopListening();
            }
            break;

        case 'speech_start':
            // Re-evaluate streaming at utterance start so toggle changes mid-session work
            _streamingActive = _serverStreamingAvailable
                && localStorage.getItem(LS_STREAMING) === 'true';
            _onSpeechStart?.();
            if (_streamingActive) {
                createLiveASRBubble();
            }
            break;

        case 'speech_end':
            // Backend will follow up with 'transcript'; nothing to do here.
            break;

        case 'partial':
            if (_streamingActive && msg.text) {
                appendLiveASRText(msg.text);
            }
            break;

        case 'transcript':
            if (msg.text) {
                if (_streamingActive) {
                    commitLiveASRBubble(msg.text);
                } else {
                    _onTranscript?.(msg.text);
                }
            }
            break;

        case 'error':
            logger.error('Backend error:', msg.message);
            break;
    }
}

// ------------------------------------------------------------------
// Microphone capture
// ------------------------------------------------------------------

async function _startMic() {
    const deviceId = getSelectedInputDevice();
    const constraints = {
        audio: {
            sampleRate:        SAMPLE_RATE,
            channelCount:      1,
            echoCancellation:  true,   // AEC — prevents TTS feedback loop
            noiseSuppression:  true,   // ANS
            autoGainControl:   true,   // AGC
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
        video: false,
    };

    _micStream = await navigator.mediaDevices.getUserMedia(constraints);

    _audioCtx   = new AudioContext({ sampleRate: SAMPLE_RATE });
    _sourceNode = _audioCtx.createMediaStreamSource(_micStream);

    // ScriptProcessorNode is deprecated but universally supported in Electron
    // and does not require AudioWorklet registration ceremony.
    _procNode = _audioCtx.createScriptProcessor(FRAME_SIZE, 1, 1);
    _procNode.onaudioprocess = _onAudioProcess;

    _sourceNode.connect(_procNode);
    _procNode.connect(_audioCtx.destination);   // must be connected to fire
}

function _onAudioProcess(ev) {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) return;

    const float32 = ev.inputBuffer.getChannelData(0);

    // Convert float32 → int16 little-endian (PCM16)
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    _ws.send(int16.buffer);
}

// ------------------------------------------------------------------
// Cleanup
// ------------------------------------------------------------------

function _cleanup() {
    // Disconnect audio graph
    try { _procNode?.disconnect(); }   catch (_) { }
    try { _sourceNode?.disconnect(); } catch (_) { }
    try { _audioCtx?.close(); }        catch (_) { }
    _procNode = _sourceNode = _audioCtx = null;

    // Stop mic tracks
    _micStream?.getTracks().forEach(t => t.stop());
    _micStream = null;

    // Close WebSocket gracefully
    if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.close(1000, 'client stopped');
    }
    _ws = null;
}
