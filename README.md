# Real Estate Sales Assistant

Sistema de asistencia en tiempo real para vendedores inmobiliarios durante llamadas de Google Meet.

## Arquitectura

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│  Extension Chrome   │────▶│   Backend Node.js   │────▶│   Deepgram API  │
│  (captura audio)    │     │   (WebSocket)       │     │  (transcripción)│
└─────────────────────┘     └──────────┬──────────┘     └─────────────────┘
                                       │
                                       ▼
                            ┌─────────────────────┐
                            │     OpenAI API      │
                            │ (extrae criterios + │
                            │  genera pitches)    │
                            └─────────────────────┘
```

## Instalación Rápida

### Paso 1: Instalar Backend

```bash
cd backend
npm install
```

### Paso 2: Configurar API Keys (Opcional para modo completo)

```bash
cp .env.example .env
# Edita .env con tus API keys
```

**Para obtener las API Keys:**
- **Deepgram**: https://console.deepgram.com/ (hay trial gratuito)
- **OpenAI**: https://platform.openai.com/api-keys

> **Nota:** El sistema funciona en **modo simulación** sin API keys, útil para pruebas.

### Paso 3: Iniciar Backend

```bash
npm start
```

Verás:
```
╔═══════════════════════════════════════════════════════════╗
║   🏠 Real Estate Sales Assistant Backend                  ║
║   Servidor corriendo en http://localhost:3001             ║
╚═══════════════════════════════════════════════════════════╝
```

### Paso 4: Instalar Extensión Chrome

1. Abre Chrome y ve a `chrome://extensions/`
2. Activa **"Modo de desarrollador"** (esquina superior derecha)
3. Clic en **"Cargar descomprimida"**
4. Selecciona la carpeta `extension/`

## Uso

1. **Inicia el backend** (`npm start` en la carpeta backend)
2. **Abre Google Meet** y únete a una llamada
3. **Clic en el icono de la extensión** (casa verde en la barra de Chrome)
4. **Clic en "Iniciar Captura"**
5. **Conversa con tu cliente** - la transcripción aparecerá en tiempo real
6. **Clic en "Buscar Propiedades"** cuando quieras recomendaciones
7. **Clic en "Detener"** cuando termines

## Estructura del Proyecto

```
realtime-sales-assistant/
├── extension/                 # Extensión de Chrome
│   ├── manifest.json         # Configuración de la extensión
│   ├── popup.html            # UI del popup
│   ├── src/
│   │   ├── popup.js          # Lógica del popup
│   │   ├── background.js     # Service worker
│   │   ├── content.js        # Script inyectado en Meet
│   │   └── panel.css         # Estilos
│   └── icons/                # Iconos de la extensión
│
└── backend/                   # Servidor Node.js
    ├── server.js             # Servidor principal
    ├── properties.json       # Base de datos de propiedades
    ├── package.json          # Dependencias
    └── .env.example          # Variables de entorno
```

## Modo Simulación vs Modo Completo

### Modo Simulación (sin API keys)
- Simula transcripciones con frases predefinidas
- Usa extracción de criterios básica
- Genera pitches simples
- **Útil para probar la UI y el flujo**

### Modo Completo (con API keys)
- Transcripción real con Deepgram Nova-2
- Extracción inteligente de criterios con GPT
- Pitches personalizados generados por IA
- **Latencia ~300ms en transcripción**

## Personalización

### Agregar Propiedades

Edita `backend/properties.json`:

```json
{
  "id": "prop021",
  "name": "Mi Nueva Propiedad",
  "type": "Casa",
  "location": "Mi Ciudad",
  "price": 5000000,
  "bedrooms": 3,
  "bathrooms": 2,
  "area": 200,
  "parking": 2,
  "features": ["Alberca", "Jardín"],
  "description": "Descripción de la propiedad",
  "roi_estimate": "7% anual",
  "year_built": 2023
}
```

### Cambiar Puerto del Backend

En `.env`:
```
PORT=3002
```

Y actualiza la URL en el popup de la extensión.

## Troubleshooting

### "No se puede conectar al servidor"
- Verifica que el backend esté corriendo
- Verifica que el puerto sea correcto (default: 3001)

### "Error al iniciar captura"
- Asegúrate de estar en una pestaña de Google Meet
- Asegúrate de que la reunión esté activa

### La transcripción no aparece
- En modo simulación, las transcripciones aparecen cada ~3 segundos
- Con Deepgram, verifica tu API key y conexión a internet

## Tecnologías

- **Frontend**: Chrome Extension (Manifest V3)
- **Backend**: Node.js + Express + WebSocket
- **Transcripción**: Deepgram Nova-2
- **IA**: OpenAI GPT-3.5-turbo
- **Audio**: Web Audio API + tabCapture

## Licencia

MIT
