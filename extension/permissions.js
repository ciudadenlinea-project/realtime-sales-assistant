// permissions.js - Manejo de permisos de micrófono

const statusEl = document.getElementById('status');
const requestBtn = document.getElementById('requestBtn');
const closeBtn = document.getElementById('closeBtn');
const successActions = document.getElementById('successActions');
const deniedInstructions = document.getElementById('deniedInstructions');

async function checkPermission() {
  try {
    const result = await navigator.permissions.query({ name: 'microphone' });
    updateUI(result.state);

    result.addEventListener('change', () => {
      updateUI(result.state);
    });
  } catch (e) {
    console.log('No se pudo verificar permiso:', e);
    updateUI('prompt');
  }
}

function updateUI(state) {
  statusEl.className = 'status';
  deniedInstructions.style.display = 'none';
  successActions.classList.remove('show');

  switch (state) {
    case 'granted':
      statusEl.classList.add('granted');
      statusEl.innerHTML = '✅ Estado: PERMITIDO';
      requestBtn.disabled = true;
      requestBtn.textContent = 'Permiso Concedido';
      successActions.classList.add('show');

      // Notificar al popup/background que el permiso está listo
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.sendMessage({ type: 'PERMISSION_GRANTED' }).catch(() => {});
      }
      break;

    case 'denied':
      statusEl.classList.add('denied');
      statusEl.innerHTML = '❌ Estado: BLOQUEADO';
      requestBtn.disabled = true;
      requestBtn.textContent = 'Permiso Bloqueado';
      deniedInstructions.style.display = 'block';
      break;

    case 'prompt':
    default:
      statusEl.classList.add('pending');
      statusEl.innerHTML = '⏳ Estado: Pendiente de autorización';
      requestBtn.disabled = false;
      requestBtn.textContent = 'Permitir Acceso al Micrófono';
      break;
  }
}

async function requestPermission() {
  requestBtn.disabled = true;
  requestBtn.textContent = 'Solicitando...';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // Permiso concedido - detener el stream
    stream.getTracks().forEach(track => track.stop());

    updateUI('granted');
    console.log('Permiso de micrófono concedido');

  } catch (err) {
    console.error('Error:', err.name, err.message);

    if (err.name === 'NotAllowedError') {
      updateUI('denied');
    } else if (err.name === 'NotFoundError') {
      statusEl.className = 'status denied';
      statusEl.innerHTML = '❌ No se encontró micrófono';
      requestBtn.textContent = 'Sin micrófono detectado';
    } else {
      statusEl.className = 'status denied';
      statusEl.innerHTML = '❌ Error: ' + err.message;
      requestBtn.disabled = false;
      requestBtn.textContent = 'Reintentar';
    }
  }
}

// Event listeners
requestBtn.addEventListener('click', requestPermission);
closeBtn.addEventListener('click', () => window.close());

// Verificar estado al cargar
checkPermission();

console.log('Página de permisos cargada');
