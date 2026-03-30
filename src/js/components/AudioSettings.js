/**
 * AudioSettings.js
 * Manages audio input/output device enumeration and selection.
 * Selected devices are persisted in localStorage and consumed by ChatController.
 */

const LS_OUTPUT = 'audio_output_device';
const LS_INPUT  = 'audio_input_device';

let _outputSelect = null;
let _inputSelect  = null;

export function initAudioSettings() {
    _outputSelect = document.getElementById('audio-output-device');
    _inputSelect  = document.getElementById('audio-input-device');
    const refreshBtn = document.getElementById('audio-devices-refresh');
    const permBtn    = document.getElementById('audio-devices-perm');

    if (!_outputSelect) return;

    refreshBtn?.addEventListener('click', enumerateDevices);
    permBtn?.addEventListener('click', async () => {
        await _requestMicPermission();
        await enumerateDevices();
    });

    _outputSelect.addEventListener('change', () => {
        localStorage.setItem(LS_OUTPUT, _outputSelect.value);
    });

    _inputSelect?.addEventListener('change', () => {
        localStorage.setItem(LS_INPUT, _inputSelect.value);
    });

    // Initial enumeration (labels may be empty until mic permission granted)
    enumerateDevices();
}

async function _requestMicPermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach(t => t.stop());
    } catch (e) {
        console.warn('Mic permission denied:', e);
    }
}

async function enumerateDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();

        const outputs = devices.filter(d => d.kind === 'audiooutput');
        const inputs  = devices.filter(d => d.kind === 'audioinput');

        _populate(_outputSelect, outputs);
        _populate(_inputSelect,  inputs);

        // Restore saved selections
        const savedOut = localStorage.getItem(LS_OUTPUT);
        const savedIn  = localStorage.getItem(LS_INPUT);
        if (savedOut && _outputSelect) _outputSelect.value = savedOut;
        if (savedIn  && _inputSelect)  _inputSelect.value  = savedIn;
    } catch (err) {
        console.warn('Failed to enumerate audio devices:', err);
    }
}

function _populate(select, devices) {
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">— System Default —</option>';
    devices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Device (${d.deviceId.slice(0, 8)}…)`;
        select.appendChild(opt);
    });
    // Try to preserve selection after repopulating
    if (current) select.value = current;
}

/** Returns the user-selected output device ID, or '' for system default. */
export function getSelectedOutputDevice() {
    return localStorage.getItem(LS_OUTPUT) || '';
}

/** Returns the user-selected input device ID, or '' for system default. */
export function getSelectedInputDevice() {
    return localStorage.getItem(LS_INPUT) || '';
}
