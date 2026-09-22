// Explicit ownership by highest-cost dependency; mixed legacy files stay intact.
// The runner rejects missing, duplicate and unclassified files.
export const layers = {
  unit: [
    'agent-commands', 'auth-login-switch', 'auth-popup', 'bootstrap-races',
    'chat-scroll-follow', 'desktop-backend-manager', 'desktop-reliability',
    'desktop-shell', 'desktop-tray', 'installer-upgrade', 'ipc-policy',
    'markdown-renderer', 'model-config-schema', 'model-controls-visibility',
    'modularization', 'pi-admin', 'product-constraints', 'reading-resize',
    'service-client', 'settings-ui-optimization', 'shared-assistant-client',
    'task-longterm', 'task-multiline', 'task-writer', 'tasks', 'test-runner',
    'ui-dialog', 'ui-token-contrast', 'windows-output-encoding',
  ],
  integration: [
    'app-data-context', 'atomic-file', 'daily-record-api', 'daily-record-manager',
    'desktop-log-writer', 'holiday-calendar', 'large-agent-events',
    'pi-admin-maintenance', 'pi-sdk-api', 'pi-sdk-integration', 'pi-sdk-switch',
    'pi-sdk', 'pi-session-store', 'review-regressions', 'runtime-turn-files',
    'service-process', 'session-model', 'session-sync-races', 'session-text-search',
    'shell-output-guard', 'skill-cli', 'skill-collisions', 'skill-directory-cache',
    'skill-manager', 'skill-transfer', 'slow-connections', 'smoke-contract',
    'task-store', 'test-screenshots', 'vskill-manager', 'work-apps', 'work-document-picker',
    'work-document-removal', 'work-documents', 'workspace-layout-sdk',
    'workspace-layout', 'workspace-migration', 'workspace-operation-races',
    'workspace-registry', 'workspace',
  ],
  browser: [
    'assistant-theme', 'browser-smoke', 'card-order', 'chat-lazy-load',
    'composer-controls', 'conversation-directory', 'desktop-page',
    'execution-process', 'glass-surfaces', 'holiday-browser', 'holiday-cache',
    'home-cold-start', 'home-responsive', 'home-settings', 'longterm-card-order',
    'project-prompt', 'prompt-images', 'reading-and-file-panel', 'reply-actions',
    'session-search-browser', 'settings-layout', 'settings-providers', 'sidebar-resize',
    'skill-collisions-browser', 'skill-editor-browser', 'skill-transfer-browser', 'task-longterm-browser',
    'task-card-layout', 'task-summary-browser', 'ui-unification', 'work-apps-browser',
    'work-document-editor-layout', 'work-document-picker-browser',
    'work-document-sort', 'work-documents-browser',
  ],
  desktop: ['desktop-draft-exit', 'desktop-longterm'],
};
for (const group of Object.keys(layers)) layers[group] = layers[group].map(name => `${name}.test.mjs`);
