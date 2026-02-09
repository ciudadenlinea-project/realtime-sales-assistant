// background.js - Service Worker para captura de audio con offscreen document

let isCapturing = false;
let currentTabId = null;
let transcript = '';
let serverUrl = 'http://localhost:3001';
let offscreenCreated = false;

// Toggle sidebar cuando se hace clic en el icono de la extension
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && tab.url.includes('meet.google.com')) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
    } catch (e) {
      // Content script might not be injected yet, try injecting it
      console.log('Content script not ready, injecting...');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content.js']
      });
      // Retry after injection
      setTimeout(async () => {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
        } catch (err) {
          console.error('Failed to toggle panel after injection:', err);
        }
      }, 500);
    }
  }
});

// Escuchar mensajes del content script y offscreen
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true;
});

async function handleMessage(message, sender, sendResponse) {
  switch (message.type) {
    case 'GET_STATE':
      sendResponse({
        isCapturing,
        transcript,
        serverUrl
      });
      break;

    case 'START_CAPTURE':
      try {
        serverUrl = message.serverUrl || serverUrl;
        // Use sender.tab.id if tabId not provided (from content script)
        const tabId = message.tabId || (sender && sender.tab && sender.tab.id);
        if (!tabId) throw new Error('No tab ID available');
        currentTabId = tabId;
        await startCapture(tabId);
        sendResponse({ success: true });
      } catch (error) {
        console.error('Error starting capture:', error);
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'STOP_CAPTURE':
      try {
        await stopCapture();
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'SEARCH_PROPERTIES':
      try {
        const recommendations = await searchProperties(message.transcript);
        sendResponse({ success: true, recommendations });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'SERVER_MESSAGE':
      // Mensaje del servidor recibido desde offscreen
      handleServerMessage(message.data);
      break;

    case 'WEBSOCKET_CLOSED':
      if (isCapturing) {
        stopCapture();
      }
      break;

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
  }
}

async function startCapture(tabId) {
  if (isCapturing) {
    throw new Error('Ya hay una captura en progreso');
  }

  try {
    // Crear offscreen document si no existe
    await setupOffscreenDocument();

    // Obtener streamId para captura del tab
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId
    });

    console.log('StreamId obtenido:', streamId);

    // Enviar al offscreen para capturar
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'START_CAPTURE',
      streamId: streamId,
      serverUrl: serverUrl
    });

    if (!response.success) {
      throw new Error(response.error || 'Error iniciando captura');
    }

    isCapturing = true;
    transcript = '';

    // Notificar al content script que la captura inicio
    chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_STARTED' }).catch(() => {});

    console.log('Captura iniciada exitosamente');

  } catch (error) {
    console.error('Error en startCapture:', error);
    throw error;
  }
}

async function setupOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    return; // Ya existe
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Captura de audio del tab para transcripcion en tiempo real'
  });

  console.log('Offscreen document creado');
}

async function closeOffscreenDocument() {
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    // Ignorar si no existe
  }
}

function handleServerMessage(data) {
  console.log('Mensaje del servidor:', data);

  switch (data.type) {
    case 'transcript':
      if (data.text) {
        // Usar el fullTranscript formateado del servidor (Vendedor/Cliente)
        if (data.fullTranscript) {
          transcript = data.fullTranscript;
        }
        // Enviar al content script para UI
        if (currentTabId) {
          chrome.tabs.sendMessage(currentTabId, {
            type: 'TRANSCRIPT',
            text: data.text,
            is_final: data.is_final,
            speaker: data.speaker,
            fullTranscript: data.fullTranscript || transcript
          }).catch(() => {});
        }
      }
      break;

    case 'recommendations':
      if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, {
          type: 'RECOMMENDATIONS',
          properties: data.properties
        }).catch(() => {});
      }
      break;

    case 'error':
      console.error('Server error:', data.message);
      break;
  }
}

async function stopCapture() {
  console.log('Deteniendo captura...');
  isCapturing = false;

  // Detener captura en offscreen
  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'STOP_CAPTURE'
    });
  } catch (e) {
    console.log('Error enviando stop a offscreen:', e);
  }

  // Notificar al content script que la captura se detuvo (panel se queda visible)
  const tabToNotify = currentTabId;
  currentTabId = null;

  if (tabToNotify) {
    try {
      await chrome.tabs.sendMessage(tabToNotify, { type: 'CAPTURE_STOPPED' });
    } catch (e) {
      console.log('Tab may be closed');
    }
  }
}

async function searchProperties(conversationText) {
  // Convertir ws:// a http:// para llamadas REST
  const httpUrl = serverUrl.replace('ws://', 'http://').replace('wss://', 'https://');
  console.log('Buscando propiedades en:', httpUrl, 'con transcript:', conversationText?.substring(0, 50));

  const response = await fetch(`${httpUrl}/search-properties`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ transcript: conversationText })
  });

  if (!response.ok) {
    throw new Error('Error en la busqueda');
  }

  const data = await response.json();
  console.log('Recomendaciones recibidas:', data.recommendations?.length);
  return data.recommendations;
}

// Limpiar al cerrar
chrome.runtime.onSuspend.addListener(() => {
  stopCapture();
  closeOffscreenDocument();
});
