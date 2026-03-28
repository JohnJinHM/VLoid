// 获取 DOM 元素
const sysPromptInput = document.getElementById('sys-prompt');
const ragToggle = document.getElementById('rag-toggle');

const sliders = {
    temp: { el: document.getElementById('temp-slider'), val: document.getElementById('temp-val') },
    topp: { el: document.getElementById('topp-slider'), val: document.getElementById('topp-val') },
    rep: { el: document.getElementById('rep-slider'), val: document.getElementById('rep-val') },
    tokens: { el: document.getElementById('tokens-slider'), val: document.getElementById('tokens-val') }
};

export function initSettingsPanel() {
    // 绑定滑块实时数值更新
    Object.values(sliders).forEach(slider => {
        slider.el.addEventListener('input', (e) => {
            slider.val.innerText = e.target.value;
        });
    });
}

/**
 * 供 ChatController 在发送消息时调用，获取最新的生成参数
 * @returns {Object} 包含所有 LLM 参数的对象
 */
export function getSettings() {
    return {
        system_prompt: sysPromptInput.value.trim(),
        temperature: parseFloat(sliders.temp.el.value),
        top_p: parseFloat(sliders.topp.el.value),
        repetition_penalty: parseFloat(sliders.rep.el.value),
        max_tokens: parseInt(sliders.tokens.el.value, 10),
        use_rag: ragToggle.checked
    };
}