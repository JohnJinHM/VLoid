export const state = {
    currentSessionId: null,
    sessionsData: {},
    abortController: null,
    currentPersonaId: 'default',
    personasData: {
        'default': {
            id: 'default',
            name: 'Default Assistant',
            description: 'You are a helpful, smart, kind, and efficient AI assistant.',
            rules: ['Always answer in a polite tone.', 'Use Markdown formatting.'],
            // TTS voice settings
            ttsMode: 'voice_design', // 'voice_design' or 'voice_clone'
            ttsVoiceDesign: {
                instruct: '',       // Natural language voice description
                language: 'auto'    // Target language
            },
            ttsVoiceClone: {
                refAudioPath: '',    // Path/name of uploaded reference audio
                refAudioData: null,  // Base64 encoded audio data
                refText: '',         // Transcript of reference audio
                language: 'auto'     // Target language
            }
        }
    },
    // Global TTS playback toggle for chat
    ttsEnabled: false
};