/**
 * Real Estate Sales Assistant - Backend Server
 * CON LOGS DETALLADOS PARA DEBUGGING
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const { createClient } = require('@deepgram/sdk');
const OpenAI = require('openai');

// Configuración
const PORT = process.env.PORT || 3001;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Base de datos mock de propiedades inmobiliarias
const properties = require('./properties.json');

// Logger con timestamp
function log(emoji, ...args) {
  const time = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${time}] ${emoji}`, ...args);
}

// Inicializar clientes
let deepgram = null;
let openai = null;

log('⚙️', 'Inicializando servidor...');
log('⚙️', 'DEEPGRAM_API_KEY:', DEEPGRAM_API_KEY ? `${DEEPGRAM_API_KEY.substring(0, 8)}...` : 'NO CONFIGURADA');
log('⚙️', 'OPENAI_API_KEY:', OPENAI_API_KEY ? `${OPENAI_API_KEY.substring(0, 8)}...` : 'NO CONFIGURADA');

if (DEEPGRAM_API_KEY) {
  deepgram = createClient(DEEPGRAM_API_KEY);
  log('✅', 'Deepgram cliente creado');
} else {
  log('⚠️', 'DEEPGRAM_API_KEY no configurada - usando modo simulación');
}

if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  log('✅', 'OpenAI cliente creado');
} else {
  log('⚠️', 'OPENAI_API_KEY no configurada - usando modo simulación');
}

// Express app
const app = express();
app.use(cors());
app.use(express.json());

// HTTP Server
const server = http.createServer(app);

// WebSocket Server
const wss = new WebSocketServer({ server });
log('✅', 'WebSocket Server creado');

// Contador de conexiones
let connectionCount = 0;

// Manejar conexiones WebSocket
wss.on('connection', (ws, req) => {
  connectionCount++;
  const clientId = connectionCount;
  const clientIP = req.socket.remoteAddress;

  log('📱', `[Cliente ${clientId}] CONECTADO desde ${clientIP}`);
  log('📱', `[Cliente ${clientId}] Headers:`, JSON.stringify(req.headers['user-agent'] || 'N/A').substring(0, 50));

  let deepgramConnection = null;
  let transcriptBuffer = '';       // Formato: "Vendedor: texto\nCliente: texto\n"
  let audioChunksReceived = 0;
  let totalBytesReceived = 0;
  let deepgramReady = false;
  let deepgramKeepAliveInterval = null;

  // Speaker labels (diarize: Speaker 0 y 1, se detectan roles con IA)
  const speakerLabels = { 0: 'Persona 1', 1: 'Persona 2', 2: 'Participante 3' };
  let rolesDetected = false;
  let roleDetectionPending = false;
  const rawUtterances = []; // Para detección de roles con IA
  let currentUtterance = '';
  let currentSpeaker = null;

  // Detección automática de roles con IA
  async function triggerRoleDetection(wsConn, cId) {
    const uniqueSpeakers = new Set(rawUtterances.map(u => u.speaker));
    if (uniqueSpeakers.size < 2 || rawUtterances.length < 3 || roleDetectionPending) return;

    roleDetectionPending = true;
    log('🧠', `[Cliente ${cId}] Detectando roles con IA (${rawUtterances.length} utterances)...`);

    try {
      const conversationForAI = rawUtterances.map(u => `Speaker ${u.speaker}: ${u.text}`).join('\n');

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Analiza esta conversación de venta inmobiliaria y determina quién es el VENDEDOR y quién es el CLIENTE.
El vendedor: saluda, ofrece, presenta opciones. El cliente: expresa necesidades, pregunta, menciona presupuesto.
Responde SOLO en JSON: {"speaker_0": "vendedor" o "cliente", "speaker_1": "vendedor" o "cliente", "confianza": "alta/media/baja"}`
          },
          { role: 'user', content: conversationForAI }
        ],
        temperature: 0.2,
        max_tokens: 150
      });

      let content = response.choices[0].message.content;
      content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const roles = JSON.parse(content);
      log('🧠', `[Cliente ${cId}] Roles:`, JSON.stringify(roles));

      if (roles.speaker_0 && roles.speaker_1) {
        speakerLabels[0] = roles.speaker_0 === 'vendedor' ? 'Vendedor' : 'Cliente';
        speakerLabels[1] = roles.speaker_1 === 'vendedor' ? 'Vendedor' : 'Cliente';
        rolesDetected = true;

        log('🧠', `[Cliente ${cId}] ✅ Speaker 0=${speakerLabels[0]}, Speaker 1=${speakerLabels[1]}`);

        // Re-etiquetar transcript existente
        transcriptBuffer = rawUtterances.map(u => {
          const label = speakerLabels[u.speaker] || `Persona ${u.speaker + 1}`;
          return `${label}: ${u.text}`;
        }).join('\n') + '\n';

        wsConn.send(JSON.stringify({
          type: 'transcript',
          text: '',
          is_final: true,
          speaker: null,
          fullTranscript: transcriptBuffer
        }));
      }
    } catch (e) {
      log('❌', `[Cliente ${cId}] Error detectando roles:`, e.message);
    }
    roleDetectionPending = false;
  }

  // Función para iniciar conexión con Deepgram
  const startDeepgram = async () => {
    if (!deepgram) {
      log('⚠️', `[Cliente ${clientId}] Modo simulación activo (sin Deepgram)`);
      return null;
    }

    try {
      log('🎙️', `[Cliente ${clientId}] Iniciando conexión con Deepgram...`);

      const connection = deepgram.listen.live({
        model: 'nova-2',
        language: 'es',
        smart_format: true,
        punctuate: true,
        diarize: true,
        interim_results: true,
        utterance_end_ms: 1000,
        endpointing: 300,
        sample_rate: 16000,
        encoding: 'linear16',
        channels: 1,
      });

      connection.on('open', () => {
        deepgramReady = true;
        log('🎙️', `[Cliente ${clientId}] ✅ Deepgram CONECTADO y LISTO`);

        // KeepAlive cada 3s (timeout es 10s)
        deepgramKeepAliveInterval = setInterval(() => {
          if (deepgramReady && connection) {
            try {
              connection.keepAlive();
            } catch (e) {
              log('⚠️', `[Cliente ${clientId}] Error en keepAlive:`, e.message);
            }
          }
        }, 3000);
      });

      // Contador de Results para debug
      let resultsCount = 0;

      // Evento principal de transcripcion (DIARIZE + AI role detection)
      connection.on('Results', (data) => {
        resultsCount++;
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        const words = data.channel?.alternatives?.[0]?.words || [];
        const isFinal = data.is_final;
        const speechFinal = data.speech_final;

        // Log cada 20 Results para saber que la conexión sigue viva
        if (resultsCount <= 3 || resultsCount % 20 === 0) {
          log('🔄', `[Cliente ${clientId}] Results #${resultsCount}: "${(transcript || '').substring(0, 30)}" final:${isFinal} speech_final:${speechFinal}`);
        }

        // Speaker: solo confiable en is_final
        let speaker = null;
        if (isFinal && words.length > 0 && words[0].speaker !== undefined) {
          const speakerCounts = {};
          words.forEach(word => {
            if (word.speaker !== undefined) {
              speakerCounts[word.speaker] = (speakerCounts[word.speaker] || 0) + 1;
            }
          });
          speaker = Object.entries(speakerCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
          if (speaker !== null && speaker !== undefined) {
            speaker = parseInt(speaker);
          }
        }

        if (transcript) {
          if (isFinal) {
            currentUtterance += transcript + ' ';
            if (speaker !== null) currentSpeaker = speaker;
            log('📝', `[Cliente ${clientId}] [Final] Speaker ${speaker}: "${transcript.substring(0, 50)}"`);
          }

          if (speechFinal && currentUtterance.trim()) {
            const label = speakerLabels[currentSpeaker] || `Persona ${currentSpeaker !== null ? currentSpeaker + 1 : '?'}`;
            transcriptBuffer += `${label}: ${currentUtterance.trim()}\n`;
            log('📝', `[Cliente ${clientId}] [Utterance] ${label}: "${currentUtterance.trim().substring(0, 60)}"`);
            log('📝', `[Cliente ${clientId}] Buffer total: ${transcriptBuffer.length} chars`);

            // Guardar para detección de roles con IA
            if (!rolesDetected && currentSpeaker !== null) {
              rawUtterances.push({ speaker: currentSpeaker, text: currentUtterance.trim() });
              triggerRoleDetection(ws, clientId);
            }

            currentUtterance = '';
            currentSpeaker = null;
          }

          ws.send(JSON.stringify({
            type: 'transcript',
            text: transcript,
            is_final: isFinal,
            speech_final: speechFinal,
            speaker: isFinal ? speaker : null,
            fullTranscript: transcriptBuffer
          }));

          if (isFinal) {
            log('📤', `[Cliente ${clientId}] Enviado: "${transcript.substring(0, 40)}..." [${speakerLabels[speaker] || 'N/A'}]`);
          }
        }
      });

      connection.on('UtteranceEnd', (data) => {
        log('📝', `[Cliente ${clientId}] [UtteranceEnd]`);
        if (currentUtterance.trim()) {
          const label = speakerLabels[currentSpeaker] || 'Desconocido';
          transcriptBuffer += `${label}: ${currentUtterance.trim()}\n`;
          log('📝', `[Cliente ${clientId}] [Flush] ${label}: "${currentUtterance.trim().substring(0, 60)}"`);

          if (!rolesDetected && currentSpeaker !== null) {
            rawUtterances.push({ speaker: currentSpeaker, text: currentUtterance.trim() });
            triggerRoleDetection(ws, clientId);
          }

          currentUtterance = '';
          currentSpeaker = null;
        }
      });

      connection.on('SpeechStarted', (data) => {
        log('🗣️', `[Cliente ${clientId}] [SpeechStarted] ts: ${data.timestamp}`);
      });

      connection.on('error', (err) => {
        log('❌', `[Cliente ${clientId}] ERROR Deepgram:`, err.message || err);
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Error en transcripción: ' + (err.message || 'desconocido')
        }));
      });

      connection.on('close', () => {
        deepgramReady = false;
        if (deepgramKeepAliveInterval) {
          clearInterval(deepgramKeepAliveInterval);
          deepgramKeepAliveInterval = null;
        }
        log('🎙️', `[Cliente ${clientId}] Deepgram DESCONECTADO`);
      });

      connection.on('warning', (warning) => {
        log('⚠️', `[Cliente ${clientId}] Deepgram warning:`, warning);
      });

      connection.on('metadata', (metadata) => {
        log('ℹ️', `[Cliente ${clientId}] Deepgram metadata:`, JSON.stringify(metadata).substring(0, 100));
      });

      return connection;

    } catch (error) {
      log('❌', `[Cliente ${clientId}] Error conectando Deepgram:`, error.message);
      return null;
    }
  };

  // Iniciar Deepgram cuando se conecta el cliente
  log('🎙️', `[Cliente ${clientId}] Iniciando Deepgram...`);
  startDeepgram().then(conn => {
    deepgramConnection = conn;
    if (conn) {
      log('🎙️', `[Cliente ${clientId}] Conexión Deepgram establecida`);
    } else {
      log('⚠️', `[Cliente ${clientId}] No se pudo establecer conexión Deepgram`);
    }
  });

  // Recibir mensajes del cliente
  ws.on('message', async (data) => {
    if (data instanceof Buffer) {
      // Es audio
      audioChunksReceived++;
      totalBytesReceived += data.length;

      // Log cada chunk inicialmente, luego cada 25
      if (audioChunksReceived <= 5 || audioChunksReceived % 25 === 0) {
        log('🎵', `[Cliente ${clientId}] Audio chunk #${audioChunksReceived}:`, {
          bytes: data.length,
          totalBytes: totalBytesReceived,
          deepgramReady: deepgramReady
        });
      }

      // Enviar a Deepgram
      if (deepgramConnection && deepgramReady) {
        try {
          deepgramConnection.send(data);
          if (audioChunksReceived <= 3) {
            log('🎵', `[Cliente ${clientId}] ✅ Audio enviado a Deepgram`);
          }
        } catch (e) {
          log('❌', `[Cliente ${clientId}] Error enviando a Deepgram:`, e.message);
        }
      } else {
        if (audioChunksReceived <= 3) {
          log('⚠️', `[Cliente ${clientId}] Deepgram no listo, audio descartado`);
        }
        // Modo simulación
        simulateTranscript(ws, clientId);
      }
    } else {
      // Es un mensaje JSON
      try {
        const message = JSON.parse(data.toString());
        log('📩', `[Cliente ${clientId}] Mensaje JSON recibido:`, message.type);
        handleClientMessage(ws, message, transcriptBuffer, clientId);
      } catch (e) {
        log('❌', `[Cliente ${clientId}] Error parsing JSON:`, e.message);
        log('❌', `[Cliente ${clientId}] Data recibida:`, data.toString().substring(0, 100));
      }
    }
  });

  ws.on('close', (code, reason) => {
    log('📴', `[Cliente ${clientId}] DESCONECTADO`, {
      code,
      reason: reason?.toString() || 'N/A',
      audioChunks: audioChunksReceived,
      totalBytes: totalBytesReceived
    });

    if (deepgramKeepAliveInterval) {
      clearInterval(deepgramKeepAliveInterval);
      deepgramKeepAliveInterval = null;
    }

    if (deepgramConnection) {
      log('🎙️', `[Cliente ${clientId}] Cerrando conexión Deepgram...`);
      deepgramConnection.finish();
    }
  });

  ws.on('error', (error) => {
    log('❌', `[Cliente ${clientId}] Error WebSocket:`, error.message);
  });

  // Enviar mensaje de bienvenida
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Conectado al servidor',
    clientId: clientId
  }));
  log('📤', `[Cliente ${clientId}] Mensaje de bienvenida enviado`);
});

// Simulador de transcripción
let simulationCounter = 0;
const simulatedPhrases = [
  "Hola, estoy buscando una propiedad para invertir",
  "Me interesa algo en zona norte, cerca de centros comerciales",
  "Mi presupuesto es de aproximadamente 3 millones de pesos",
  "Necesito al menos 3 recámaras y 2 baños"
];

function simulateTranscript(ws, clientId) {
  if (Math.random() > 0.98) {
    const phrase = simulatedPhrases[simulationCounter % simulatedPhrases.length];
    simulationCounter++;

    log('🤖', `[Cliente ${clientId}] Simulando transcripción:`, phrase.substring(0, 30));

    ws.send(JSON.stringify({
      type: 'transcript',
      text: phrase,
      is_final: true
    }));
  }
}

// Manejar mensajes del cliente
async function handleClientMessage(ws, message, transcript, clientId) {
  log('📩', `[Cliente ${clientId}] Procesando mensaje:`, message.type);

  switch (message.type) {
    case 'search_properties':
      log('🔍', `[Cliente ${clientId}] Buscando propiedades...`);
      const results = await searchProperties(message.transcript || transcript);
      log('🔍', `[Cliente ${clientId}] Encontradas ${results.length} propiedades`);
      ws.send(JSON.stringify({
        type: 'recommendations',
        properties: results
      }));
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      log('⚠️', `[Cliente ${clientId}] Tipo de mensaje desconocido:`, message.type);
  }
}

// Endpoint REST para búsqueda de propiedades
app.post('/search-properties', async (req, res) => {
  log('🌐', 'REST: Búsqueda de propiedades');
  try {
    const { transcript } = req.body;
    const recommendations = await searchProperties(transcript);
    res.json({ recommendations });
  } catch (error) {
    log('❌', 'REST: Error en búsqueda:', error.message);
    res.status(500).json({ error: 'Error en búsqueda de propiedades' });
  }
});

// Función principal de búsqueda de propiedades - USA OPENAI PARA ANALIZAR TODO
async function searchProperties(transcript) {
  log('🔍', 'Analizando conversación completa:', transcript?.substring(0, 100) || '(vacío)');

  if (openai && transcript?.length > 20) {
    try {
      // Preparar lista de propiedades para OpenAI
      const propsForAI = properties.map((p, i) => ({
        id: i,
        nombre: p.name,
        ubicacion: p.location,
        precio: p.price,
        recamaras: p.bedrooms,
        banos: p.bathrooms,
        area: p.area,
        tipo: p.type,
        amenidades: p.amenities?.join(', ') || ''
      }));

      log('🤖', 'Enviando a OpenAI para análisis inteligente...');

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Eres un asistente de ventas inmobiliarias experto. Analiza la conversación entre el VENDEDOR y el CLIENTE para recomendar las MEJORES propiedades.

FORMATO DE LA CONVERSACIÓN:
- Las líneas con "Vendedor:" son del agente de ventas
- Las líneas con "Cliente:" son del comprador potencial
- Enfócate en lo que DICE EL CLIENTE: sus necesidades, presupuesto, ubicación deseada, número de recámaras, estilo de vida, etc.

INSTRUCCIONES:
1. Analiza qué busca el CLIENTE (ubicación, presupuesto, recámaras, estilo de vida, amenidades, etc.)
2. Selecciona las 3-5 propiedades MÁS relevantes de la lista
3. Para cada propiedad, genera un PITCH DE VENTA personalizado que el vendedor pueda usar
4. El pitch debe conectar las necesidades específicas del cliente con los beneficios de la propiedad

Responde SOLO en JSON con este formato:
{
  "analisis": "Resumen de lo que busca el cliente",
  "recomendaciones": [
    {
      "id": 0,
      "relevancia": "alta/media",
      "pitch": "Pitch de venta personalizado para este cliente..."
    }
  ]
}`
          },
          {
            role: 'user',
            content: `CONVERSACIÓN DEL CLIENTE:
${transcript}

PROPIEDADES DISPONIBLES:
${JSON.stringify(propsForAI, null, 2)}`
          }
        ],
        temperature: 0.7,
        max_tokens: 1500
      });

      // Limpiar respuesta de markdown si viene envuelta en ```json
      let content = response.choices[0].message.content;
      content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      log('🤖', 'Respuesta IA (limpia):', content.substring(0, 100));

      const aiResponse = JSON.parse(content);
      log('🤖', 'Análisis IA:', aiResponse.analisis);
      log('🤖', 'Recomendaciones:', aiResponse.recomendaciones?.length || 0);

      // Combinar propiedades con pitches de IA
      const results = (aiResponse.recomendaciones || []).map(rec => {
        const prop = properties[rec.id] || properties[0];
        return {
          ...prop,
          pitch: rec.pitch,
          relevancia: rec.relevancia
        };
      });

      return results.length > 0 ? results : properties.slice(0, 5).map(p => ({
        ...p,
        pitch: `Excelente opción en ${p.location}. ${p.bedrooms} recámaras, ideal para su estilo de vida.`
      }));

    } catch (error) {
      log('❌', 'Error en análisis IA:', error.message);
    }
  }

  // Fallback: usar filtro simple
  log('⚠️', 'Usando búsqueda simple (sin IA)');
  const criteria = extractCriteriaSimple(transcript || '');
  const matched = filterProperties(criteria);
  return matched.slice(0, 5).map(p => ({
    ...p,
    pitch: `Propiedad destacada en ${p.location}. ${p.bedrooms} recámaras, ${p.bathrooms} baños.`
  }));
}

// Extraer criterios de búsqueda
async function extractCriteria(transcript) {
  if (openai && transcript.length > 10) {
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `Extrae criterios de búsqueda inmobiliaria. Devuelve JSON con: min_price, max_price, min_bedrooms, min_bathrooms, location, property_type, features (array), min_area. Usa null si no se menciona.`
          },
          { role: 'user', content: transcript }
        ],
        temperature: 0.3,
        max_tokens: 300
      });
      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      log('⚠️', 'Error OpenAI, usando extracción simple:', error.message);
    }
  }
  return extractCriteriaSimple(transcript);
}

function extractCriteriaSimple(transcript) {
  const lower = (transcript || '').toLowerCase();
  const criteria = {
    min_price: null, max_price: null, min_bedrooms: null,
    min_bathrooms: null, location: null, property_type: null,
    features: [], min_area: null
  };

  const priceMatch = lower.match(/(\d+(?:,\d{3})*(?:\.\d+)?)\s*(millones?|mil|m)/);
  if (priceMatch) {
    let price = parseFloat(priceMatch[1].replace(/,/g, ''));
    if (priceMatch[2].includes('millon')) price *= 1000000;
    else if (priceMatch[2] === 'mil') price *= 1000;
    criteria.max_price = price * 1.2;
    criteria.min_price = price * 0.8;
  }

  const bedroomMatch = lower.match(/(\d+)\s*(?:recámara|recamara|habitacion|cuarto)/);
  if (bedroomMatch) criteria.min_bedrooms = parseInt(bedroomMatch[1]);

  const bathroomMatch = lower.match(/(\d+)\s*(?:baño|bano)/);
  if (bathroomMatch) criteria.min_bathrooms = parseInt(bathroomMatch[1]);

  const locations = ['norte', 'sur', 'centro', 'poniente', 'oriente', 'polanco', 'condesa', 'roma', 'santa fe'];
  for (const loc of locations) {
    if (lower.includes(loc)) { criteria.location = loc; break; }
  }

  if (lower.includes('casa')) criteria.property_type = 'casa';
  else if (lower.includes('departamento') || lower.includes('depa')) criteria.property_type = 'departamento';

  const amenities = ['alberca', 'piscina', 'gimnasio', 'gym', 'jardín', 'jardin', 'terraza', 'estacionamiento'];
  criteria.features = amenities.filter(a => lower.includes(a));

  return criteria;
}

function filterProperties(criteria) {
  // Calcular score para cada propiedad
  const scored = properties.map(prop => {
    let score = 0;
    let matches = 0;

    // Precio
    if (criteria.max_price && prop.price <= criteria.max_price) { score += 20; matches++; }
    if (criteria.min_price && prop.price >= criteria.min_price * 0.5) { score += 10; matches++; }

    // Habitaciones
    if (criteria.min_bedrooms && prop.bedrooms >= criteria.min_bedrooms) { score += 25; matches++; }

    // Ubicación (flexible)
    if (criteria.location) {
      const loc = criteria.location.toLowerCase();
      const propLoc = prop.location.toLowerCase();
      if (propLoc.includes(loc) || loc.includes(propLoc.split(',')[0])) {
        score += 30;
        matches++;
      }
    }

    // Tipo de propiedad (flexible)
    if (criteria.property_type) {
      const type = criteria.property_type.toLowerCase();
      const propType = prop.type.toLowerCase();
      if (propType.includes(type) || type.includes(propType) ||
          (type.includes('apart') && propType.includes('depart')) ||
          (type.includes('depart') && propType.includes('apart'))) {
        score += 15;
        matches++;
      }
    }

    return { ...prop, score, matches };
  });

  // Ordenar por score y devolver las mejores (mínimo 3 si hay propiedades)
  const filtered = scored
    .filter(p => p.score > 0 || scored.every(s => s.score === 0))
    .sort((a, b) => b.score - a.score);

  // Si no hay matches, devolver las primeras 5 propiedades
  if (filtered.length === 0 || filtered.every(p => p.score === 0)) {
    log('⚠️', 'Sin coincidencias exactas, mostrando propiedades destacadas');
    return properties.slice(0, 5);
  }

  return filtered.slice(0, 10);
}

async function generatePitches(properties, transcript, criteria) {
  const results = [];
  for (const prop of properties) {
    let pitch = `Excelente opción en ${prop.location}. ${prop.bedrooms} recámaras, ${prop.bathrooms} baños.`;

    if (openai && transcript?.length > 10) {
      try {
        const response = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Genera un pitch de venta de 1-2 oraciones para esta propiedad.' },
            { role: 'user', content: `Propiedad: ${prop.name}, ${prop.location}, $${prop.price}, ${prop.bedrooms} rec. Cliente busca: ${transcript.substring(0, 200)}` }
          ],
          temperature: 0.7,
          max_tokens: 100
        });
        pitch = response.choices[0].message.content;
      } catch (e) {
        log('⚠️', 'Error generando pitch:', e.message);
      }
    }

    results.push({ ...prop, pitch });
  }
  return results;
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    deepgram: !!DEEPGRAM_API_KEY,
    openai: !!OPENAI_API_KEY,
    properties: properties.length,
    connections: wss.clients.size
  });
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║   🏠 Real Estate Sales Assistant Backend                  ║
║   Servidor corriendo en http://localhost:${PORT}             ║
╠═══════════════════════════════════════════════════════════╣
║   WebSocket: ws://localhost:${PORT}                          ║
║   Health:    http://localhost:${PORT}/health                 ║
╠═══════════════════════════════════════════════════════════╣
║   Deepgram:  ${DEEPGRAM_API_KEY ? '✓ Configurado' : '✗ No configurado'}                            ║
║   OpenAI:    ${OPENAI_API_KEY ? '✓ Configurado' : '✗ No configurado'}                            ║
║   Props DB:  ${properties.length} propiedades                              ║
╠═══════════════════════════════════════════════════════════╣
║   📋 LOGS DETALLADOS ACTIVADOS                            ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
