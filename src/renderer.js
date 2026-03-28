import { initSessionManager, fetchAndRenderSessions } from './js/components/SessionManager.js';
import { initChatController } from './js/components/ChatController.js';
import { initPersonaManager } from './js/components/PersonaEditor.js';
import { initSettingsPanel } from './js/components/SettingsPanel.js';

// 监听 DOM 加载完毕，初始化各个模块
document.addEventListener('DOMContentLoaded', async () => {
    console.log("Initializing AI Assistant UI...");

    // 绑定基础事件监听
    initSessionManager();
    initChatController();
    initPersonaManager();
    initSettingsPanel();

    // 发起首次后端同步
    await fetchAndRenderSessions();
});