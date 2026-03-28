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
            rules: ['Always answer in a polite tone.', 'Use Markdown formatting.']
        }
    }
};