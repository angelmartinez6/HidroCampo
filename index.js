const mongoose = require('mongoose');
const mqtt = require('mqtt');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

// --- 1. IMPORTAR IA DE GOOGLE ---
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Conexión a MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Conectado a MongoDB Atlas"))
  .catch(err => console.error("❌ Error Mongo:", err));

// --- MODELOS ---
const MedicionSchema = new mongoose.Schema({
  cultivo: String,
  etapa: String,
  ph: Number,
  caudal: Number,
  temperatura: Number,
  alerta: String,
  fecha: { type: Date, default: Date.now }
});
const Medicion = mongoose.model('Medicion', MedicionSchema);

const CultivoConfigSchema = new mongoose.Schema({
  nombre: String,
  etapa: String,
  horario: String,
  tiempoRiego: String,   
  sistemaRiego: String,  
  tamanoTerreno: Number,
  fecha: { type: Date, default: Date.now }
});
const CultivoConfig = mongoose.model('CultivoConfig', CultivoConfigSchema);

// --- INICIALIZAR LA IA ---
// Asegúrate de tener GEMINI_API_KEY en tu archivo .env
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- RUTAS API ---

app.get('/api/historial', async (req, res) => {
  try {
    const historial = await Medicion.find().sort({ fecha: -1 }).limit(20);
    res.json(historial);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener datos" });
  }
});

app.post('/api/cultivo', async (req, res) => {
  try {
    const nuevoCultivo = new CultivoConfig(req.body);
    await nuevoCultivo.save();
    console.log("📍 Nuevo cultivo configurado:", req.body.nombre);
    res.status(201).json({ message: "Configuración actualizada en el servidor" });
  } catch (err) {
    res.status(500).json({ error: "Error al guardar configuración" });
  }
});

// --- RUTA NUEVA: ASISTENTE IA ---
app.post('/api/asistente', async (req, res) => {
  try {
    const { pregunta, cultivo } = req.body;

    // Buscamos las últimas 5 mediciones EXACTAS de ese cultivo usando tu modelo Medicion
    const historialReciente = await Medicion.find({ cultivo: cultivo })
                                            .sort({ fecha: -1 })
                                            .limit(5);

    // Preparamos los datos para que la IA los lea
    let datosTexto = "No hay datos recientes.";
    if (historialReciente.length > 0) {
      datosTexto = historialReciente.map(m => 
        `pH: ${m.ph}, Temp: ${m.temperatura}°C, Caudal: ${m.caudal}L/min`
      ).join(" | ");
    }

    // Le damos personalidad y contexto al modelo
    const promptExperto = `
      Eres un ingeniero agrónomo experto ayudando a un productor. 
      El cultivo actual que se está monitoreando es: ${cultivo}. 
      Los últimos datos reales de los sensores IoT son: ${datosTexto}.
      
      El productor te pregunta: "${pregunta}".
      
      Reglas de tu respuesta:
      - Sé directo, profesional y muy conciso (máximo 3 líneas).
      - Basa tu consejo estrictamente en los datos de los sensores proporcionados.
      - No uses formatos complejos como negritas o listas largas.
    `;

    // Llamamos a Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(promptExperto);
    
    // Devolvemos el texto a la aplicación móvil
    res.status(200).json({ respuesta: result.response.text() });

  } catch (error) {
    console.error("❌ Error con la IA:", error);
    res.status(500).json({ error: "El asistente está descansando, intenta en un momento." });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor API corriendo en puerto ${PORT}`));

// --- LÓGICA MQTT (SENSORES) ---

const client = mqtt.connect(process.env.MQTT_URL, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS
});

client.on('connect', () => {
  console.log("✅ Conectado al Broker HiveMQ");
  client.subscribe('finca/monitoreo');
});

client.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    
    const configActiva = await CultivoConfig.findOne().sort({ fecha: -1 });
    
    if (configActiva) {
      data.cultivo = configActiva.nombre;
      data.etapa = configActiva.etapa;
      
      if (data.cultivo === 'Tomate' && (data.ph < 6.0 || data.ph > 7.5)) {
        data.alerta = "pH fuera de rango óptimo";
      }
    }

    const nuevaMedicion = new Medicion(data);
    await nuevaMedicion.save();
    console.log("💾 Datos de sensores guardados con validación");
  } catch (err) {
    console.error("❌ Error al procesar mensaje MQTT:", err);
  }
});