// content.js - Panel Unificado de Asesor de Ventas para Google Meet
// Sidebar moderno con controles de captura, config y transcripcion

let assistantPanel = null;
let fullTranscript = '';
let isMinimized = false;
let isCapturing = false;
let serverUrl = 'ws://localhost:3001';
// Speakers se auto-detectan con IA en el backend
let speakerNames = { 0: 'Persona 1', 1: 'Persona 2' };

// Cargar config guardada al iniciar
chrome.storage.local.get(['serverUrl'], (result) => {
  if (result.serverUrl) {
    serverUrl = result.serverUrl;
  }
});

// Escuchar mensajes del background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'TOGGLE_PANEL':
      togglePanel();
      sendResponse({ success: true });
      break;

    case 'SHOW_PANEL':
    case 'START_AUDIO_CAPTURE':
      createAssistantPanel();
      sendResponse({ success: true });
      break;

    case 'HIDE_PANEL':
    case 'STOP_AUDIO_CAPTURE':
      removeAssistantPanel();
      sendResponse({ success: true });
      break;

    case 'CAPTURE_STARTED':
      isCapturing = true;
      updateControlsUI();
      sendResponse({ success: true });
      break;

    case 'CAPTURE_STOPPED':
      isCapturing = false;
      updateControlsUI();
      sendResponse({ success: true });
      break;

    case 'TRANSCRIPT':
      // Actualizar fullTranscript del servidor (formato Vendedor/Cliente completo)
      if (message.fullTranscript) {
        fullTranscript = message.fullTranscript;
      }
      // Renderizar transcript completo + texto interim actual
      renderFullTranscript(message.text, message.is_final, message.speaker);
      sendResponse({ success: true });
      break;

    case 'RECOMMENDATIONS':
      showRecommendations(message.properties);
      sendResponse({ success: true });
      break;
  }
  return true;
});

function togglePanel() {
  if (assistantPanel) {
    removeAssistantPanel();
  } else {
    createAssistantPanel();
  }
}

function createAssistantPanel() {
  if (assistantPanel) return;

  fullTranscript = '';
  isMinimized = false;

  // Inyectar estilos
  const styles = document.createElement('style');
  styles.id = 'sales-assistant-styles';
  styles.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

    #sales-assistant-sidebar * {
      box-sizing: border-box;
    }

    #sales-assistant-sidebar {
      position: fixed;
      top: 0;
      right: 0;
      width: 580px;
      height: 100vh;
      z-index: 999999;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }

    #sales-assistant-sidebar.minimized {
      transform: translateX(540px);
    }

    .sa-sidebar-inner {
      height: 100%;
      background: linear-gradient(165deg, #0a0a0f 0%, #12121a 40%, #1a1a28 100%);
      border-left: 1px solid rgba(139, 92, 246, 0.2);
      display: flex;
      flex-direction: column;
      box-shadow: -20px 0 60px rgba(0, 0, 0, 0.7);
      overflow: hidden;
    }

    /* Toggle Button */
    .sa-minimize-btn {
      position: absolute;
      left: -48px;
      top: 50%;
      transform: translateY(-50%);
      width: 48px;
      height: 100px;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
      border: none;
      border-radius: 16px 0 0 16px;
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      box-shadow: -8px 0 30px rgba(99, 102, 241, 0.4);
      transition: all 0.3s ease;
      z-index: 1;
    }

    .sa-minimize-btn:hover {
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #9333ea 100%);
      width: 56px;
      left: -56px;
    }

    /* Header */
    .sa-header {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 40%, #a855f7 100%);
      padding: 20px 24px;
      position: relative;
      overflow: hidden;
      flex-shrink: 0;
    }

    .sa-header::before {
      content: '';
      position: absolute;
      top: -50%;
      right: -50%;
      width: 100%;
      height: 200%;
      background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 60%);
    }

    .sa-header-content {
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: relative;
      z-index: 1;
    }

    .sa-logo {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .sa-logo-icon {
      width: 48px;
      height: 48px;
      background: rgba(255,255,255,0.2);
      backdrop-filter: blur(10px);
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    }

    .sa-logo-text {
      color: white;
    }

    .sa-logo-title {
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -0.5px;
      margin-bottom: 2px;
    }

    .sa-logo-subtitle {
      font-size: 11px;
      font-weight: 500;
      opacity: 0.85;
      letter-spacing: 0.5px;
    }

    .sa-header-status {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(0,0,0,0.25);
      backdrop-filter: blur(10px);
      padding: 8px 16px;
      border-radius: 30px;
      border: 1px solid rgba(255,255,255,0.1);
    }

    .sa-header-status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ef4444;
      transition: all 0.3s;
    }

    .sa-header-status-dot.connected {
      background: #4ade80;
      animation: sa-pulse 2s ease-in-out infinite;
      box-shadow: 0 0 20px rgba(74, 222, 128, 0.6);
    }

    .sa-header-status-text {
      color: white;
      font-size: 12px;
      font-weight: 600;
    }

    @keyframes sa-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.2); opacity: 0.7; }
    }

    /* Controls Section */
    .sa-controls {
      background: rgba(0,0,0,0.4);
      padding: 16px 24px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      flex-shrink: 0;
    }

    .sa-controls-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }

    .sa-controls-row:last-child {
      margin-bottom: 0;
    }

    .sa-mic-status {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 600;
      flex: 1;
    }

    .sa-mic-status.granted {
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: #4ade80;
    }

    .sa-mic-status.denied {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
      cursor: pointer;
    }

    .sa-mic-status.prompt {
      background: rgba(59, 130, 246, 0.15);
      border: 1px solid rgba(59, 130, 246, 0.3);
      color: #60a5fa;
      cursor: pointer;
    }

    .sa-btn-capture {
      flex: 1;
      padding: 12px 20px;
      border: none;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-family: inherit;
    }

    .sa-btn-start {
      background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
      color: #000;
      box-shadow: 0 4px 20px rgba(74, 222, 128, 0.3);
    }

    .sa-btn-start:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 8px 30px rgba(74, 222, 128, 0.5);
    }

    .sa-btn-stop {
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      color: white;
      box-shadow: 0 4px 20px rgba(239, 68, 68, 0.3);
    }

    .sa-btn-stop:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 8px 30px rgba(239, 68, 68, 0.5);
    }

    .sa-btn-capture:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }

    /* Config toggle */
    .sa-config-toggle {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      padding: 8px 14px;
      color: #94a3b8;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: inherit;
    }

    .sa-config-toggle:hover {
      background: rgba(255,255,255,0.1);
      color: #e2e8f0;
    }

    .sa-config-panel {
      display: none;
      margin-top: 12px;
      padding: 12px;
      background: rgba(0,0,0,0.3);
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.05);
    }

    .sa-config-panel.open {
      display: block;
    }

    .sa-config-label {
      font-size: 11px;
      color: #64748b;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }

    .sa-config-input {
      width: 100%;
      background: rgba(0,0,0,0.4);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      padding: 10px 14px;
      color: #e2e8f0;
      font-size: 13px;
      font-family: 'JetBrains Mono', monospace, inherit;
      transition: border-color 0.2s;
    }

    .sa-config-input:focus {
      outline: none;
      border-color: rgba(99, 102, 241, 0.5);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    }

    /* Speaker Legend */
    .sa-speakers-legend {
      background: rgba(0,0,0,0.3);
      padding: 12px 24px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      flex-shrink: 0;
    }

    .sa-speaker-chip {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .sa-speaker-chip:hover {
      transform: scale(1.05);
    }

    .sa-speaker-chip-0 {
      background: rgba(99, 102, 241, 0.2);
      border: 1px solid rgba(99, 102, 241, 0.4);
      color: #a5b4fc;
    }

    .sa-speaker-chip-1 {
      background: rgba(236, 72, 153, 0.2);
      border: 1px solid rgba(236, 72, 153, 0.4);
      color: #f9a8d4;
    }

    .sa-speaker-chip-2 {
      background: rgba(34, 211, 238, 0.2);
      border: 1px solid rgba(34, 211, 238, 0.4);
      color: #67e8f9;
    }

    .sa-speaker-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    .sa-speaker-dot-0 { background: #6366f1; box-shadow: 0 0 10px rgba(99, 102, 241, 0.5); }
    .sa-speaker-dot-1 { background: #ec4899; box-shadow: 0 0 10px rgba(236, 72, 153, 0.5); }
    .sa-speaker-dot-2 { background: #22d3ee; box-shadow: 0 0 10px rgba(34, 211, 238, 0.5); }

    /* Tabs Navigation */
    .sa-tabs {
      display: flex;
      background: rgba(0,0,0,0.3);
      padding: 8px;
      gap: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      flex-shrink: 0;
    }

    .sa-tab {
      flex: 1;
      padding: 12px 16px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 12px;
      color: #64748b;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-family: inherit;
    }

    .sa-tab:hover {
      background: rgba(255,255,255,0.05);
      color: #94a3b8;
    }

    .sa-tab.active {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.2) 0%, rgba(139, 92, 246, 0.2) 100%);
      border-color: rgba(99, 102, 241, 0.3);
      color: #a5b4fc;
    }

    .sa-tab-icon {
      font-size: 16px;
    }

    .sa-tab-badge {
      background: #ef4444;
      color: white;
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 10px;
      min-width: 18px;
      text-align: center;
    }

    .sa-tab-content {
      display: none;
      flex-direction: column;
      flex: 1;
      overflow: hidden;
    }

    .sa-tab-content.active {
      display: flex;
    }

    /* Transcript Area */
    .sa-transcript {
      overflow-y: auto;
      padding: 0 20px 20px;
      flex: 1;
    }

    .sa-transcript-content {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .sa-transcript-empty {
      text-align: center;
      padding: 50px 30px;
      color: #475569;
    }

    .sa-transcript-empty-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.5;
    }

    .sa-transcript-empty-text {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 6px;
      color: #64748b;
    }

    .sa-transcript-empty-sub {
      font-size: 12px;
      color: #475569;
    }

    /* Section Headers */
    .sa-section-header {
      padding: 16px 24px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .sa-section-title {
      color: #64748b;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .sa-section-title::before {
      content: '';
      width: 4px;
      height: 16px;
      background: linear-gradient(180deg, #6366f1 0%, #a855f7 100%);
      border-radius: 2px;
    }

    /* Transcript Messages */
    .sa-message {
      display: flex;
      gap: 12px;
      animation: sa-fadeIn 0.3s ease;
    }

    @keyframes sa-fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .sa-message-avatar {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
      font-weight: 700;
    }

    .sa-message-avatar-0 {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
    }

    .sa-message-avatar-1 {
      background: linear-gradient(135deg, #ec4899 0%, #f472b6 100%);
      color: white;
    }

    .sa-message-avatar-2 {
      background: linear-gradient(135deg, #06b6d4 0%, #22d3ee 100%);
      color: white;
    }

    .sa-message-avatar-unknown {
      background: linear-gradient(135deg, #475569 0%, #64748b 100%);
      color: white;
    }

    .sa-message-content {
      flex: 1;
      min-width: 0;
    }

    .sa-message-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 4px;
    }

    .sa-message-name {
      font-size: 12px;
      font-weight: 700;
    }

    .sa-message-name-0 { color: #a5b4fc; }
    .sa-message-name-1 { color: #f9a8d4; }
    .sa-message-name-2 { color: #67e8f9; }
    .sa-message-name-unknown { color: #94a3b8; }

    .sa-message-time {
      font-size: 11px;
      color: #475569;
      font-weight: 500;
    }

    .sa-message-bubble {
      padding: 12px 16px;
      border-radius: 14px;
      font-size: 13px;
      line-height: 1.6;
      color: #e2e8f0;
      border: 1px solid;
    }

    .sa-message-bubble-0 {
      background: rgba(99, 102, 241, 0.1);
      border-color: rgba(99, 102, 241, 0.2);
    }

    .sa-message-bubble-1 {
      background: rgba(236, 72, 153, 0.1);
      border-color: rgba(236, 72, 153, 0.2);
    }

    .sa-message-bubble-2 {
      background: rgba(34, 211, 238, 0.1);
      border-color: rgba(34, 211, 238, 0.2);
    }

    .sa-message-bubble-unknown {
      background: rgba(71, 85, 105, 0.2);
      border-color: rgba(71, 85, 105, 0.3);
    }

    .sa-message-bubble-interim {
      background: rgba(251, 191, 36, 0.1);
      border-color: rgba(251, 191, 36, 0.3);
      color: #fcd34d;
      font-style: italic;
    }

    /* Search Button */
    .sa-search-section {
      padding: 16px 24px;
      background: rgba(0,0,0,0.2);
      flex-shrink: 0;
    }

    .sa-search-btn {
      width: 100%;
      padding: 16px 24px;
      background: linear-gradient(135deg, #4ade80 0%, #22c55e 50%, #16a34a 100%);
      border: none;
      border-radius: 14px;
      color: #000;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      box-shadow: 0 8px 30px rgba(74, 222, 128, 0.3);
      letter-spacing: 0.3px;
      font-family: inherit;
    }

    .sa-search-btn:hover:not(:disabled) {
      transform: translateY(-3px);
      box-shadow: 0 12px 40px rgba(74, 222, 128, 0.5);
    }

    .sa-search-btn:active:not(:disabled) {
      transform: translateY(-1px);
    }

    .sa-search-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    .sa-search-btn.loading {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
      color: white;
    }

    .sa-search-icon {
      font-size: 18px;
    }

    /* Recommendations */
    .sa-recommendations {
      flex: 1;
      overflow-y: auto;
      padding: 0 20px 20px;
    }

    .sa-rec-empty {
      text-align: center;
      padding: 50px 30px;
    }

    .sa-rec-empty-icon {
      font-size: 56px;
      margin-bottom: 16px;
      opacity: 0.4;
    }

    .sa-rec-empty-text {
      color: #64748b;
      font-size: 13px;
      line-height: 1.6;
    }

    /* Property Cards */
    .sa-property-card {
      background: linear-gradient(145deg, rgba(30, 30, 45, 0.9) 0%, rgba(20, 20, 35, 0.9) 100%);
      border: 1px solid rgba(99, 102, 241, 0.15);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 14px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }

    .sa-property-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, #6366f1, #a855f7, #ec4899);
    }

    .sa-property-card:hover {
      border-color: rgba(99, 102, 241, 0.4);
      transform: translateY(-4px);
      box-shadow: 0 20px 50px rgba(99, 102, 241, 0.2);
    }

    .sa-property-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 16px;
    }

    .sa-property-name {
      color: #fff;
      font-size: 17px;
      font-weight: 700;
      margin-bottom: 6px;
      letter-spacing: -0.3px;
    }

    .sa-property-location {
      color: #94a3b8;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 500;
    }

    .sa-property-price {
      background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
      color: #000;
      padding: 8px 16px;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 800;
      box-shadow: 0 4px 20px rgba(74, 222, 128, 0.3);
      white-space: nowrap;
    }

    .sa-property-details {
      display: flex;
      gap: 8px;
      margin: 14px 0;
      padding: 12px;
      background: rgba(0,0,0,0.3);
      border-radius: 12px;
      justify-content: space-around;
    }

    .sa-property-detail {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
    }

    .sa-property-detail-icon {
      font-size: 18px;
    }

    .sa-property-detail-value {
      color: #fff;
      font-size: 14px;
      font-weight: 700;
    }

    .sa-property-detail-label {
      color: #64748b;
      font-size: 11px;
      font-weight: 500;
    }

    /* Pitch Card */
    .sa-property-pitch {
      background: linear-gradient(135deg, rgba(251, 191, 36, 0.12) 0%, rgba(245, 158, 11, 0.08) 100%);
      border: 1px solid rgba(251, 191, 36, 0.25);
      border-radius: 12px;
      padding: 14px 16px;
      margin-top: 12px;
    }

    .sa-pitch-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    .sa-pitch-label {
      color: #fbbf24;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .sa-pitch-label-icon {
      font-size: 14px;
    }

    .sa-copy-btn {
      background: rgba(251, 191, 36, 0.2);
      border: 1px solid rgba(251, 191, 36, 0.3);
      color: #fbbf24;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: inherit;
    }

    .sa-copy-btn:hover {
      background: rgba(251, 191, 36, 0.3);
      transform: scale(1.05);
    }

    .sa-pitch-text {
      color: #fef3c7;
      font-size: 14px;
      line-height: 1.7;
      font-style: italic;
    }

    /* Scrollbar */
    #sales-assistant-sidebar ::-webkit-scrollbar {
      width: 8px;
    }

    #sales-assistant-sidebar ::-webkit-scrollbar-track {
      background: rgba(255,255,255,0.03);
      border-radius: 4px;
    }

    #sales-assistant-sidebar ::-webkit-scrollbar-thumb {
      background: linear-gradient(180deg, #6366f1 0%, #a855f7 100%);
      border-radius: 4px;
    }

    #sales-assistant-sidebar ::-webkit-scrollbar-thumb:hover {
      background: linear-gradient(180deg, #4f46e5 0%, #9333ea 100%);
    }
  `;

  document.head.appendChild(styles);

  // Crear panel
  assistantPanel = document.createElement('div');
  assistantPanel.id = 'sales-assistant-sidebar';
  assistantPanel.innerHTML = `
    <div class="sa-sidebar-inner">
      <button class="sa-minimize-btn" id="sa-toggle">\u25C0</button>

      <!-- Header -->
      <div class="sa-header">
        <div class="sa-header-content">
          <div class="sa-logo">
            <div class="sa-logo-icon">\uD83C\uDFE0</div>
            <div class="sa-logo-text">
              <div class="sa-logo-title">Sales Assistant</div>
              <div class="sa-logo-subtitle">Asistente IA en Tiempo Real</div>
            </div>
          </div>
          <div class="sa-header-status">
            <div class="sa-header-status-dot" id="sa-status-dot"></div>
            <span class="sa-header-status-text" id="sa-status-text">Desconectado</span>
          </div>
        </div>
      </div>

      <!-- Controls Section -->
      <div class="sa-controls">
        <div class="sa-controls-row">
          <div class="sa-mic-status prompt" id="sa-mic-status">
            \uD83C\uDF99\uFE0F Microfono: Verificando...
          </div>
          <button class="sa-config-toggle" id="sa-config-toggle">
            \u2699\uFE0F Config
          </button>
        </div>
        <div class="sa-controls-row">
          <button class="sa-btn-capture sa-btn-start" id="sa-btn-start">
            \u25B6 Iniciar Captura
          </button>
          <button class="sa-btn-capture sa-btn-stop" id="sa-btn-stop" disabled>
            \u23F9 Detener
          </button>
        </div>
        <div class="sa-config-panel" id="sa-config-panel">
          <div class="sa-config-label">Servidor Backend</div>
          <input type="text" class="sa-config-input" id="sa-server-url" value="${serverUrl}" placeholder="ws://localhost:3001">
        </div>
      </div>

      <!-- Speaker Legend -->
      <div class="sa-speakers-legend">
        <div class="sa-speaker-chip sa-speaker-chip-0">
          <div class="sa-speaker-dot sa-speaker-dot-0"></div>
          <span>Vendedor</span>
        </div>
        <div class="sa-speaker-chip sa-speaker-chip-1">
          <div class="sa-speaker-dot sa-speaker-dot-1"></div>
          <span>Cliente</span>
        </div>
      </div>

      <!-- Tabs Navigation -->
      <div class="sa-tabs">
        <button class="sa-tab active" id="sa-tab-transcript" data-tab="transcript">
          <span class="sa-tab-icon">\uD83D\uDCAC</span>
          <span>Conversacion</span>
          <span class="sa-tab-badge" id="sa-message-badge">0</span>
        </button>
        <button class="sa-tab" id="sa-tab-recommendations" data-tab="recommendations">
          <span class="sa-tab-icon">\uD83C\uDFE0</span>
          <span>Propiedades IA</span>
          <span class="sa-tab-badge" id="sa-rec-badge" style="display:none;">0</span>
        </button>
      </div>

      <!-- Tab: Transcript -->
      <div class="sa-tab-content active" id="sa-content-transcript">
        <div class="sa-transcript" id="sa-transcript">
          <div class="sa-transcript-content" id="sa-transcript-content">
            <div class="sa-transcript-empty">
              <div class="sa-transcript-empty-icon">\uD83C\uDF99\uFE0F</div>
              <div class="sa-transcript-empty-text">Esperando conversacion...</div>
              <div class="sa-transcript-empty-sub">Inicia la captura para ver la transcripcion en tiempo real</div>
            </div>
          </div>
        </div>

        <div class="sa-search-section">
          <button class="sa-search-btn" id="sa-search-btn">
            <span class="sa-search-icon">\uD83D\uDD0D</span>
            <span>Analizar y Buscar Propiedades</span>
          </button>
        </div>
      </div>

      <!-- Tab: Recommendations -->
      <div class="sa-tab-content" id="sa-content-recommendations">
        <div class="sa-recommendations" id="sa-recommendations">
          <div class="sa-rec-empty">
            <div class="sa-rec-empty-icon">\uD83C\uDFD8\uFE0F</div>
            <div class="sa-rec-empty-text">
              <strong>Propiedades Recomendadas</strong><br><br>
              Ve a la pestana "Conversacion"<br>
              y haz clic en "Analizar y Buscar"<br>
              para obtener recomendaciones de la IA<br>
              basadas en lo que el cliente necesita
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(assistantPanel);

  // === Event Listeners ===

  // Toggle minimize
  document.getElementById('sa-toggle').addEventListener('click', () => {
    isMinimized = !isMinimized;
    assistantPanel.classList.toggle('minimized', isMinimized);
    document.getElementById('sa-toggle').textContent = isMinimized ? '\u25B6' : '\u25C0';
  });

  // Tab switching
  assistantPanel.querySelectorAll('.sa-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      assistantPanel.querySelectorAll('.sa-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      assistantPanel.querySelectorAll('.sa-tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById(`sa-content-${tabName}`).classList.add('active');
    });
  });

  // Start capture
  document.getElementById('sa-btn-start').addEventListener('click', () => startCapture());

  // Stop capture
  document.getElementById('sa-btn-stop').addEventListener('click', () => stopCapture());

  // Config toggle
  document.getElementById('sa-config-toggle').addEventListener('click', () => {
    const panel = document.getElementById('sa-config-panel');
    panel.classList.toggle('open');
  });

  // Server URL change
  document.getElementById('sa-server-url').addEventListener('change', (e) => {
    serverUrl = e.target.value;
    chrome.storage.local.set({ serverUrl });
  });

  // Search button
  document.getElementById('sa-search-btn').addEventListener('click', async () => {
    if (fullTranscript.trim().length > 10) {
      const btn = document.getElementById('sa-search-btn');
      btn.classList.add('loading');
      btn.innerHTML = '<span class="sa-search-icon">\u23F3</span><span>Analizando con IA...</span>';
      btn.disabled = true;

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'SEARCH_PROPERTIES',
          transcript: fullTranscript
        });

        if (response && response.success && response.recommendations) {
          showRecommendations(response.recommendations);
        } else {
          showRecommendations([]);
          console.error('Search failed:', response?.error);
        }
      } catch (e) {
        console.error('Search error:', e);
        showRecommendations([]);
      }

      btn.classList.remove('loading');
      btn.innerHTML = '<span class="sa-search-icon">\uD83D\uDD0D</span><span>Analizar y Buscar Propiedades</span>';
      btn.disabled = false;
    }
  });

  // Check mic permission and current state
  checkMicPermission();
  checkCurrentState();
  updateControlsUI();

  console.log('Sales Assistant: Panel unificado creado v4');
}

// === Capture Logic (migrated from popup.js) ===

async function checkMicPermission() {
  const micStatus = document.getElementById('sa-mic-status');
  if (!micStatus) return;

  try {
    const result = await navigator.permissions.query({ name: 'microphone' });
    updateMicUI(result.state);
    result.addEventListener('change', () => updateMicUI(result.state));
  } catch (e) {
    updateMicUI('unknown');
  }
}

function updateMicUI(state) {
  const micStatus = document.getElementById('sa-mic-status');
  if (!micStatus) return;

  micStatus.className = 'sa-mic-status';

  switch (state) {
    case 'granted':
      micStatus.classList.add('granted');
      micStatus.textContent = '\uD83C\uDF99\uFE0F Microfono: Permitido';
      micStatus.style.cursor = 'default';
      micStatus.onclick = null;
      break;
    case 'denied':
      micStatus.classList.add('denied');
      micStatus.innerHTML = '\uD83C\uDF99\uFE0F Microfono: BLOQUEADO';
      micStatus.style.cursor = 'pointer';
      micStatus.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
      break;
    default:
      micStatus.classList.add('prompt');
      micStatus.innerHTML = '\uD83C\uDF99\uFE0F Microfono: No configurado';
      micStatus.style.cursor = 'pointer';
      micStatus.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
      break;
  }
}

async function checkCurrentState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response) {
      isCapturing = response.isCapturing;
      if (response.serverUrl) {
        serverUrl = response.serverUrl;
        const input = document.getElementById('sa-server-url');
        if (input) input.value = serverUrl;
      }
      updateControlsUI();
    }
  } catch (e) {
    console.log('No se pudo obtener estado:', e);
  }
}

async function startCapture() {
  const statusText = document.getElementById('sa-status-text');
  const statusDot = document.getElementById('sa-status-dot');

  // Health check
  const httpUrl = serverUrl.replace('ws://', 'http://').replace('wss://', 'https://');
  if (statusText) statusText.textContent = 'Conectando...';

  try {
    const healthCheck = await fetch(httpUrl + '/health', { method: 'GET' });
    if (!healthCheck.ok) throw new Error('Server not available');
  } catch (e) {
    if (statusText) statusText.textContent = 'Error de conexion';
    console.error('Health check failed:', e);
    return;
  }

  // Get current tab ID to pass to background
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      tabId: await getCurrentTabId(),
      serverUrl: serverUrl
    });

    if (response && response.success) {
      isCapturing = true;
      updateControlsUI();
    } else {
      if (statusText) statusText.textContent = 'Error al iniciar';
      console.error('Start capture failed:', response?.error);
    }
  } catch (e) {
    if (statusText) statusText.textContent = 'Error';
    console.error('Start capture error:', e);
  }
}

async function stopCapture() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
    if (response && response.success) {
      isCapturing = false;
      updateControlsUI();
    }
  } catch (e) {
    console.error('Stop capture error:', e);
  }
}

function getCurrentTabId() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
      // We need the tab ID - the background can get it from the sender
      // But for START_CAPTURE we need to pass it explicitly
      // Use a workaround: ask background to use sender.tab.id
      resolve(null);
    });
  });
}

function updateControlsUI() {
  const btnStart = document.getElementById('sa-btn-start');
  const btnStop = document.getElementById('sa-btn-stop');
  const statusDot = document.getElementById('sa-status-dot');
  const statusText = document.getElementById('sa-status-text');

  if (!btnStart || !btnStop) return;

  if (isCapturing) {
    btnStart.disabled = true;
    btnStop.disabled = false;
    if (statusDot) statusDot.classList.add('connected');
    if (statusText) statusText.textContent = 'En vivo';
  } else {
    btnStart.disabled = false;
    btnStop.disabled = true;
    if (statusDot) statusDot.classList.remove('connected');
    if (statusText) statusText.textContent = 'Desconectado';
  }
}

// === Transcript & Recommendations ===

let messageCount = 0;

function renderFullTranscript(currentText, isFinal, channel) {
  if (!assistantPanel) createAssistantPanel();

  const container = document.getElementById('sa-transcript-content');
  if (!container) return;

  // Parsear fullTranscript en lineas de "Vendedor: texto" / "Cliente: texto"
  const lines = fullTranscript.split('\n').filter(l => l.trim());

  if (lines.length === 0 && !currentText) return;

  // Limpiar mensaje inicial
  const empty = container.querySelector('.sa-transcript-empty');
  if (empty) empty.remove();

  // Construir HTML con todas las lineas completas
  let html = '';
  lines.forEach(line => {
    const match = line.match(/^(Vendedor|Cliente|Participante \d+|Canal \d+|Persona \d+|Desconocido):\s*(.+)/);
    if (match) {
      const role = match[1];
      const text = match[2];
      const isVendedor = role === 'Vendedor';
      const avatarClass = isVendedor ? '1' : '0';
      const initial = isVendedor ? 'V' : 'C';
      html += `
        <div class="sa-message">
          <div class="sa-message-avatar sa-message-avatar-${avatarClass}">${initial}</div>
          <div class="sa-message-content">
            <div class="sa-message-header">
              <span class="sa-message-name sa-message-name-${avatarClass}">${role}</span>
            </div>
            <div class="sa-message-bubble sa-message-bubble-${avatarClass}">${text}</div>
          </div>
        </div>`;
    }
  });

  // Agregar texto interim actual (lo que se esta hablando ahora)
  if (currentText && !isFinal) {
    const label = speakerNames[channel] || 'Hablante';
    const isVendedor = channel === 1;
    const avatarClass = isVendedor ? '1' : '0';
    const initial = isVendedor ? 'V' : 'C';
    html += `
      <div class="sa-message sa-message-interim">
        <div class="sa-message-avatar sa-message-avatar-${avatarClass}">${initial}</div>
        <div class="sa-message-content">
          <div class="sa-message-header">
            <span class="sa-message-name sa-message-name-${avatarClass}">${label}</span>
          </div>
          <div class="sa-message-bubble sa-message-bubble-interim">${currentText}...</div>
        </div>
      </div>`;
  }

  container.innerHTML = html;

  // Update badge
  messageCount = lines.length;
  const badge = document.getElementById('sa-message-badge');
  if (badge) badge.textContent = messageCount;

  // Auto-scroll al final
  const transcript = document.getElementById('sa-transcript');
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

function showRecommendations(properties) {
  const container = document.getElementById('sa-recommendations');
  if (!container) return;

  // Reset search button
  const btn = document.getElementById('sa-search-btn');
  if (btn) {
    btn.classList.remove('loading');
    btn.innerHTML = '<span class="sa-search-icon">\uD83D\uDD0D</span><span>Analizar y Buscar Propiedades</span>';
    btn.disabled = false;
  }

  // Update badge
  const badge = document.getElementById('sa-rec-badge');
  if (badge && properties && properties.length > 0) {
    badge.textContent = properties.length;
    badge.style.display = 'inline-block';
  }

  // Switch to recommendations tab
  const recTab = document.getElementById('sa-tab-recommendations');
  if (recTab) recTab.click();

  if (!properties || properties.length === 0) {
    container.innerHTML = `
      <div class="sa-rec-empty">
        <div class="sa-rec-empty-icon">\uD83D\uDE15</div>
        <div class="sa-rec-empty-text">
          No se encontraron propiedades<br>
          que coincidan con los criterios<br>
          mencionados en la conversacion
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = properties.slice(0, 5).map((prop, i) => `
    <div class="sa-property-card">
      <div class="sa-property-header">
        <div>
          <div class="sa-property-name">${prop.name || 'Propiedad ' + (i+1)}</div>
          <div class="sa-property-location">\uD83D\uDCCD ${prop.location || 'Ubicacion no disponible'}</div>
        </div>
        <div class="sa-property-price">$${(prop.price || 0).toLocaleString()}</div>
      </div>

      <div class="sa-property-details">
        <div class="sa-property-detail">
          <span class="sa-property-detail-icon">\uD83D\uDECF\uFE0F</span>
          <span class="sa-property-detail-value">${prop.bedrooms || 0}</span>
          <span class="sa-property-detail-label">Rec</span>
        </div>
        <div class="sa-property-detail">
          <span class="sa-property-detail-icon">\uD83D\uDEBF</span>
          <span class="sa-property-detail-value">${prop.bathrooms || 0}</span>
          <span class="sa-property-detail-label">Banos</span>
        </div>
        <div class="sa-property-detail">
          <span class="sa-property-detail-icon">\uD83D\uDCD0</span>
          <span class="sa-property-detail-value">${prop.area || 0}m\u00B2</span>
        </div>
      </div>

      ${prop.pitch ? `
        <div class="sa-property-pitch">
          <div class="sa-pitch-header">
            <span class="sa-pitch-label">
              <span class="sa-pitch-label-icon">\uD83D\uDCA1</span>
              Pitch de Venta IA
            </span>
            <button class="sa-copy-btn" data-pitch="${prop.pitch.replace(/"/g, '&quot;').replace(/\\/g, '\\\\')}">
              \uD83D\uDCCB Copiar
            </button>
          </div>
          <div class="sa-pitch-text">"${prop.pitch}"</div>
        </div>
      ` : ''}
    </div>
  `).join('');

  // Attach copy button handlers
  container.querySelectorAll('.sa-copy-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      navigator.clipboard.writeText(this.dataset.pitch);
      this.textContent = '\u2713 Copiado!';
      setTimeout(() => { this.textContent = '\uD83D\uDCCB Copiar'; }, 2000);
    });
  });
}

function removeAssistantPanel() {
  if (assistantPanel) {
    assistantPanel.remove();
    assistantPanel = null;
  }
  const styles = document.getElementById('sales-assistant-styles');
  if (styles) styles.remove();
  fullTranscript = '';
  messageCount = 0;
  console.log('Sales Assistant: Panel removido');
}

window.addEventListener('beforeunload', removeAssistantPanel);

console.log('Sales Assistant: Content script cargado v4');
