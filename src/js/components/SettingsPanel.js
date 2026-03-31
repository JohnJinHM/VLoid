const LS_VOLUME         = 'tts_volume';
const LS_SPLIT_MODE     = 'tts_split_mode';
const LS_NATIVE_STREAM  = 'tts_native_streaming';

const sysPromptInput = document.getElementById('sys-prompt');
const ragToggle      = document.getElementById('rag-toggle');

const sliders = {
    temp:   { el: document.getElementById('temp-slider'),   val: document.getElementById('temp-val') },
    topp:   { el: document.getElementById('topp-slider'),   val: document.getElementById('topp-val') },
    rep:    { el: document.getElementById('rep-slider'),    val: document.getElementById('rep-val') },
    tokens: { el: document.getElementById('tokens-slider'), val: document.getElementById('tokens-val') },
};

const volumeSlider       = document.getElementById('tts-volume-slider');
const volumeVal          = document.getElementById('tts-volume-val');
const splitModeSelect    = document.getElementById('tts-split-mode');
const nativeStreamToggle = document.getElementById('tts-native-stream-toggle');

export function initSettingsPanel() {
    // LLM parameter sliders
    Object.values(sliders).forEach(slider => {
        slider.el.addEventListener('input', (e) => {
            slider.val.innerText = e.target.value;
        });
    });

    // TTS volume slider — restore + persist
    if (volumeSlider) {
        const savedVolume = localStorage.getItem(LS_VOLUME);
        if (savedVolume !== null) volumeSlider.value = savedVolume;
        _updateVolumeLabel();

        volumeSlider.addEventListener('input', () => {
            _updateVolumeLabel();
            localStorage.setItem(LS_VOLUME, volumeSlider.value);
        });
    }

    // TTS split mode — restore + persist
    if (splitModeSelect) {
        const savedMode = localStorage.getItem(LS_SPLIT_MODE);
        if (savedMode) splitModeSelect.value = savedMode;

        splitModeSelect.addEventListener('change', () => {
            localStorage.setItem(LS_SPLIT_MODE, splitModeSelect.value);
        });
    }

    // Native streaming toggle — restore + persist
    if (nativeStreamToggle) {
        const saved = localStorage.getItem(LS_NATIVE_STREAM);
        if (saved !== null) nativeStreamToggle.checked = saved === 'true';

        nativeStreamToggle.addEventListener('change', () => {
            localStorage.setItem(LS_NATIVE_STREAM, nativeStreamToggle.checked);
        });
    }
}

function _updateVolumeLabel() {
    if (volumeVal && volumeSlider) {
        volumeVal.textContent = Math.round(parseFloat(volumeSlider.value) * 100) + '%';
    }
}

/** Returns current TTS volume in [0, 1]. */
export function getTTSVolume() {
    if (volumeSlider) return parseFloat(volumeSlider.value);
    const saved = localStorage.getItem(LS_VOLUME);
    return saved !== null ? parseFloat(saved) : 1.0;
}

/** Returns true when native model-streaming mode is enabled. */
export function getTTSNativeStreaming() {
    if (nativeStreamToggle) return nativeStreamToggle.checked;
    return localStorage.getItem(LS_NATIVE_STREAM) === 'true';
}

/** Returns the selected TTS text-split mode string. */
export function getTTSSplitMode() {
    if (splitModeSelect) return splitModeSelect.value;
    return localStorage.getItem(LS_SPLIT_MODE) || 'sentence';
}

/**
 * Returns all LLM generation parameters for use in chat requests.
 */
export function getSettings() {
    return {
        system_prompt:      sysPromptInput.value.trim(),
        temperature:        parseFloat(sliders.temp.el.value),
        top_p:              parseFloat(sliders.topp.el.value),
        repetition_penalty: parseFloat(sliders.rep.el.value),
        max_tokens:         parseInt(sliders.tokens.el.value, 10),
        use_rag:            ragToggle.checked,
    };
}
