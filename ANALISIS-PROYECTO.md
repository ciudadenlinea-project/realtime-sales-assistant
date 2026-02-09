# Real Estate Sales Assistant - Analisis Tecnico Completo

## Resumen del Proyecto

Asistente de ventas inmobiliarias en tiempo real que funciona como extension de Chrome para Google Meet. Captura audio de la llamada, transcribe con Deepgram (speaker diarization), y usa OpenAI para recomendar propiedades con pitches de venta personalizados.

## Arquitectura

```
Google Meet (Tab)
    |
    v
Chrome Extension (Manifest V3)
    |-- content.js     → Sidebar UI (panel lateral en Google Meet)
    |-- background.js  → Service worker, orquesta todo
    |-- offscreen.js   → Captura audio (tab + mic), mezcla y envia por WebSocket
    |
    v  (WebSocket ws://localhost:3001)
    |
Backend Node.js (server.js)
    |-- Deepgram SDK   → Transcripcion en tiempo real (nova-2, español, diarization)
    |-- OpenAI API     → Analisis de conversacion + recomendacion de propiedades
    |-- properties.json → Base de datos de 55 propiedades inmobiliarias
```

## Flujo de Audio

1. **Captura**: `offscreen.js` obtiene 2 streams:
   - `tabStream` via `tabCapture` (audio remoto del Meet - lo que dice el otro)
   - `micStream` via `getUserMedia` (microfono local - lo que dices tu)

2. **Playback**: El audio del tab se reproduce para que el usuario escuche la llamada normalmente

3. **Procesamiento**: `AudioContext` a 16kHz mezcla ambos streams en un canal mono

4. **Envio**: PCM int16 via WebSocket al backend cada ~256ms (buffer 4096 samples @ 16kHz)

5. **Transcripcion**: Deepgram recibe el audio mono y transcribe con diarization

## Configuracion Actual de Deepgram

```javascript
{
  model: 'nova-2',
  language: 'es',
  smart_format: true,
  punctuate: true,
  diarize: true,           // Deteccion de speakers
  interim_results: true,    // Resultados parciales en tiempo real
  utterance_end_ms: 1000,  // Detecta fin de utterance despues de 1s de silencio
  endpointing: 300,        // Detecta fin de frase despues de 300ms
  sample_rate: 16000,
  encoding: 'linear16',
  channels: 1              // ← PROBLEMA: mono mezclado
}
```

## Problema Principal: Audio Mono Mezclado

### Situacion actual
El `offscreen.js` mezcla mic + tab en un solo canal mono:
```javascript
mixed[i] = (left[i] + right[i]) / 2;
```

Deepgram recibe 1 canal con ambas voces mezcladas y debe adivinar quien habla usando analisis de voz (pitch, tono, patron). Esto causa:

- **Confusion de speakers**: A veces aparece "Participante 3" con palabras sueltas ("con", "Por") - son errores de diarization en transiciones de speaker
- **Asignacion incorrecta**: El speaker 0 no siempre es la misma persona consistentemente
- **Perdida de contexto**: Cuando ambos hablan a la vez, el audio se mezcla y Deepgram no puede separar

### Solucion propuesta: Multichannel
Enviar 2 canales separados en estereo:
- **Canal 0**: Audio del tab (persona remota = generalmente el Cliente)
- **Canal 1**: Audio del microfono (persona local = generalmente el Vendedor)

Configuracion Deepgram:
```javascript
{
  multichannel: true,
  channels: 2,
  // ... resto igual
}
```

**Ventajas**:
- Deepgram procesa cada canal independientemente
- Identificacion de speaker 100% precisa (canal = persona)
- No necesita AI para detectar roles (canal 0 = remoto, canal 1 = local)
- Mejor calidad de transcripcion (sin interferencia cruzada)

### Cambios necesarios para multichannel

**offscreen.js**: En vez de mezclar a mono, enviar estereo (interleaved PCM int16):
```javascript
// En vez de mezclar, enviar 2 canales interleaved
const interleaved = new Int16Array(left.length * 2);
for (let i = 0; i < left.length; i++) {
  interleaved[i * 2] = float32ToInt16Sample(left[i]);     // Canal 0: tab
  interleaved[i * 2 + 1] = float32ToInt16Sample(right[i]); // Canal 1: mic
}
websocket.send(interleaved.buffer);
```

**server.js**: Cambiar config de Deepgram:
```javascript
{
  multichannel: true,
  channels: 2,
  // Los Results vienen con channel_index [0,2] o [1,2]
}
```

**server.js**: Parsear Results por canal:
```javascript
connection.on('Results', (data) => {
  const channelIndex = data.channel_index?.[0]; // 0 = tab/remoto, 1 = mic/local
  const speaker = channelIndex === 0 ? 'Cliente' : 'Vendedor';
  // ... ya no necesita diarize ni deteccion de roles
});
```

## Deteccion de Roles con IA (Implementacion Actual)

Como solucion intermedia mientras se usa mono, se implemento deteccion automatica de roles:

1. Las primeras utterances se etiquetan como "Persona 1" / "Persona 2"
2. Despues de 3+ utterances con 2 speakers distintos, se envia a OpenAI
3. OpenAI analiza el CONTEXTO de lo que dice cada persona:
   - Vendedor: saluda profesionalmente, ofrece, presenta
   - Cliente: pregunta, pide, expresa necesidades
4. Se re-etiqueta todo el transcript retroactivamente
5. Se notifica a la extension con roles actualizados

## Mecanismos de Conexion (KeepAlive)

- **Deepgram**: `keepAlive()` cada 3 segundos (timeout es 10s, error NET-0001)
- **WebSocket extension→backend**: ping JSON cada 10 segundos
- **Deepgram SDK v3.13.0**: `vad_events: true` ROMPE los Results (bug conocido, no usar)

## Extension Chrome - Sidebar Unificado

El sidebar reemplaza el popup original y contiene:

### Seccion de Controles
- Indicador de estado del microfono
- Boton Iniciar/Detener Captura
- Config colapsable del servidor backend

### Tab Conversacion
- Transcripcion en tiempo real con formato Vendedor/Cliente
- Chips de colores por speaker
- Scroll automatico

### Tab Propiedades
- Boton "Analizar y Buscar Propiedades" que envia transcript a OpenAI
- Cards con propiedades recomendadas + pitch de venta personalizado
- Relevancia (alta/media)

## Flujo de Recomendacion de Propiedades

1. Usuario hace clic en "Analizar y Buscar"
2. Extension envia transcript completo al backend via REST POST `/search-properties`
3. Backend envia a OpenAI (gpt-4o-mini) con:
   - El transcript completo (formato Vendedor/Cliente)
   - Lista de 55 propiedades con detalles
4. OpenAI analiza necesidades del cliente y selecciona 3-5 propiedades
5. Para cada propiedad genera un pitch de venta personalizado
6. Se muestran como cards en el sidebar

## Bugs Resueltos

| Bug | Causa | Solucion |
|-----|-------|----------|
| Transcripcion se corta despues de 4-5 frases | Sin keepAlive, Deepgram cierra a los 10s | keepAlive cada 3s + WebSocket ping cada 10s |
| Boton IA no retorna nada | sendMessage era fire-and-forget | Cambiado a async/await con manejo de response |
| `vad_events: true` rompe transcripcion | Bug en @deepgram/sdk v3.13.0 | Removido del config |
| Speaker 0 siempre = Vendedor (hardcoded) | Mapeo fijo sin inteligencia | Deteccion de roles con IA |
| Popup y sidebar duplicados | Dos UIs separadas | Eliminado popup, unificado en sidebar |

## Archivos del Proyecto

```
realtime-sales-assistant/
  backend/
    server.js          → Backend principal (WebSocket + REST + Deepgram + OpenAI)
    properties.json    → BD de 55 propiedades inmobiliarias
    package.json       → Dependencias Node.js
    .env               → API keys (Deepgram + OpenAI)
    .env.example       → Template sin keys
    Dockerfile         → Para deploy a Cloud Run
  extension/
    manifest.json      → Manifest V3 (sin popup)
    offscreen.html     → HTML del offscreen document
    offscreen.js       → Captura audio (tab + mic), WebSocket
    permissions.html   → Pagina de permisos de microfono
    permissions.js     → Logica de permisos
    src/
      background.js    → Service worker (orquestador)
      content.js       → Sidebar UI completo (inyectado en Google Meet)
    icons/             → Iconos de la extension
  .firebaserc          → Proyecto Firebase: realtime-sales-assistant
  firebase.json        → Config Firebase (hosting + Cloud Run)
  .gitignore
  README.md
```

## Repositorio

GitHub: https://github.com/ciudadenlinea-project/realtime-sales-assistant

## Proximos Pasos

1. **Multichannel audio** - Enviar 2 canales separados para speaker ID perfecto
2. **Deploy a Cloud Run** - Backend en la nube (Firebase project ya creado)
3. **Auto-busqueda** - Buscar propiedades automaticamente al detectar pausa larga
4. **Historial** - Guardar conversaciones y recomendaciones en Firestore
5. **Multi-idioma** - Soporte para ingles ademas de español
