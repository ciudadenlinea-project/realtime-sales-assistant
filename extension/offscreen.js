// offscreen.js - Captura de audio: MICRÓFONO + TAB
// Con PLAYBACK para que el usuario escuche la llamada
// Con SPEAKER DIARIZATION habilitado

let playbackContext = null;  // Para reproducir audio
let processContext = null;   // Para procesar y enviar a Deepgram
let tabStream = null;
let micStream = null;
let processor = null;
let websocket = null;
let isCapturing = false;
let wsKeepAliveInterval = null;

function log(...args) {
  console.log('[Offscreen]', ...args);
}

log('Script cargado - Captura MIC + TAB con Playback y Diarization');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log('Mensaje recibido:', message.type, 'target:', message.target);

  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'START_CAPTURE':
      log('Iniciando captura...');
      startCapture(message.streamId, message.serverUrl)
        .then(() => {
          log('Captura iniciada exitosamente');
          sendResponse({ success: true });
        })
        .catch(err => {
          log('ERROR iniciando captura:', err.message);
          sendResponse({ success: false, error: err.message });
        });
      return true;

    case 'STOP_CAPTURE':
      log('Deteniendo captura...');
      stopCapture();
      sendResponse({ success: true });
      break;
  }
});

async function startCapture(streamId, serverUrl) {
  log('=== INICIO DE CAPTURA (MIC + TAB + PLAYBACK) ===');

  if (isCapturing) {
    throw new Error('Ya hay una captura en progreso');
  }

  // Paso 1: Obtener audio del TAB
  log('Paso 1: Obteniendo audio del tab...');
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
    log('✅ Audio del tab obtenido');
  } catch (err) {
    log('⚠️ No se pudo obtener audio del tab:', err.message);
    tabStream = null;
  }

  // Paso 2: Obtener MICRÓFONO
  log('Paso 2: Obteniendo micrófono...');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true
      },
      video: false
    });
    log('✅ Micrófono obtenido');
  } catch (err) {
    log('⚠️ No se pudo obtener micrófono:', err.message);
    micStream = null;
  }

  // Verificar que tenemos al menos uno
  if (!tabStream && !micStream) {
    throw new Error('No se pudo obtener ninguna fuente de audio');
  }

  // Paso 3: Configurar PLAYBACK del audio del tab (para que el usuario escuche)
  if (tabStream) {
    log('Paso 3: Configurando playback del audio...');
    try {
      playbackContext = new AudioContext(); // Sample rate nativo del sistema
      const playbackSource = playbackContext.createMediaStreamSource(tabStream);

      // Conectar directamente a los parlantes
      playbackSource.connect(playbackContext.destination);

      if (playbackContext.state === 'suspended') {
        await playbackContext.resume();
      }
      log('✅ Playback configurado - El usuario puede escuchar la llamada');
    } catch (err) {
      log('⚠️ Error en playback:', err.message);
    }
  }

  // Paso 4: Conectar WebSocket
  log('Paso 4: Conectando WebSocket...');
  const wsUrl = serverUrl.replace('http://', 'ws://').replace('https://', 'wss://');

  try {
    websocket = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket timeout')), 5000);
      websocket.onopen = () => { clearTimeout(timeout); log('✅ WebSocket conectado'); resolve(); };
      websocket.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket failed')); };
    });
  } catch (err) {
    log('❌ ERROR WebSocket:', err.message);
    stopCapture();
    throw err;
  }

  // Handlers del WebSocket
  websocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      log('📩 Servidor:', data.type, data.text ? data.text.substring(0, 30) : '', data.speaker !== undefined ? `[Speaker ${data.speaker}]` : '');
      chrome.runtime.sendMessage({ type: 'SERVER_MESSAGE', data }).catch(() => {});
    } catch (e) {}
  };

  // KeepAlive: ping cada 10s para mantener WebSocket vivo
  wsKeepAliveInterval = setInterval(() => {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      try {
        websocket.send(JSON.stringify({ type: 'ping' }));
      } catch (e) {}
    }
  }, 10000);

  websocket.onclose = () => {
    log('WebSocket cerrado');
    if (wsKeepAliveInterval) {
      clearInterval(wsKeepAliveInterval);
      wsKeepAliveInterval = null;
    }
    chrome.runtime.sendMessage({ type: 'WEBSOCKET_CLOSED' }).catch(() => {});
    if (isCapturing) stopCapture();
  };

  // Paso 5: Crear AudioContext para PROCESAR (16kHz para Deepgram)
  log('Paso 5: Configurando AudioContext para Deepgram...');
  try {
    processContext = new AudioContext({ sampleRate: 16000 });

    if (processContext.state === 'suspended') {
      await processContext.resume();
    }
    log('AudioContext (proceso) state:', processContext.state);

    // Crear merger para combinar fuentes en mono
    const merger = processContext.createChannelMerger(2);
    const gainNode = processContext.createGain();
    gainNode.gain.value = 1.0;

    // Conectar fuentes disponibles
    if (tabStream) {
      const tabSource = processContext.createMediaStreamSource(tabStream);
      tabSource.connect(merger, 0, 0);
      log('✅ Tab conectado al mixer (procesamiento)');
    }

    if (micStream) {
      const micSource = processContext.createMediaStreamSource(micStream);
      micSource.connect(merger, 0, 1);
      log('✅ Micrófono conectado al mixer');
    }

    merger.connect(gainNode);

    // Crear processor
    const bufferSize = 4096;
    processor = processContext.createScriptProcessor(bufferSize, 2, 1);

    let chunkCount = 0;
    let totalBytes = 0;

    processor.onaudioprocess = (event) => {
      if (!websocket || websocket.readyState !== WebSocket.OPEN) return;

      // Mezclar los dos canales en mono
      const left = event.inputBuffer.getChannelData(0);
      const right = event.inputBuffer.numberOfChannels > 1
        ? event.inputBuffer.getChannelData(1)
        : left;

      const mixed = new Float32Array(left.length);
      let maxAmp = 0;

      for (let i = 0; i < left.length; i++) {
        mixed[i] = (left[i] + right[i]) / 2;
        const abs = Math.abs(mixed[i]);
        if (abs > maxAmp) maxAmp = abs;
      }

      // Convertir y enviar
      const int16Data = float32ToInt16(mixed);
      websocket.send(int16Data.buffer);

      chunkCount++;
      totalBytes += int16Data.buffer.byteLength;

      if (chunkCount <= 5 || chunkCount % 50 === 0) {
        log(`🎵 Chunk #${chunkCount}: ${int16Data.buffer.byteLength}B, amp: ${maxAmp.toFixed(4)}, total: ${totalBytes}B`);
      }
    };

    gainNode.connect(processor);
    processor.connect(processContext.destination);

    isCapturing = true;
    log('=== CAPTURA ACTIVA (MIC + TAB + PLAYBACK) ===');
    log('Fuentes activas:', { mic: !!micStream, tab: !!tabStream, playback: !!playbackContext });

  } catch (err) {
    log('❌ ERROR AudioContext:', err.message);
    stopCapture();
    throw err;
  }
}

function stopCapture() {
  log('=== DETENIENDO CAPTURA ===');
  isCapturing = false;

  if (processor) {
    try { processor.disconnect(); } catch (e) {}
    processor = null;
  }

  if (processContext) {
    try { processContext.close(); } catch (e) {}
    processContext = null;
  }

  if (playbackContext) {
    try { playbackContext.close(); } catch (e) {}
    playbackContext = null;
  }

  if (tabStream) {
    tabStream.getTracks().forEach(t => t.stop());
    tabStream = null;
  }

  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }

  if (wsKeepAliveInterval) {
    clearInterval(wsKeepAliveInterval);
    wsKeepAliveInterval = null;
  }

  if (websocket) {
    try { websocket.close(); } catch (e) {}
    websocket = null;
  }

  log('=== CAPTURA DETENIDA ===');
}

function float32ToInt16(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16Array;
}

log('Offscreen listo - esperando comandos');
