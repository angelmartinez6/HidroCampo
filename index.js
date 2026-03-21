const mongoose = require('mongoose');
const mqtt = require('mqtt');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

// --- IMPORTAR IA DE GOOGLE ---
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. CONEXIÓN A MONGODB ATLAS ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Conectado a MongoDB Atlas"))
  .catch(err => console.error("❌ Error Mongo:", err));

// --- 2. MODELOS DE BASE DE DATOS ---
const MedicionSchema = new mongoose.Schema({
  cultivo: String,
  etapa: String,
  ph: Number,
  caudal: Number,
  temperatura: Number,
  alerta: String,
  recomendaciones: [String], 
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

const RecomendacionSchema = new mongoose.Schema({
  cultivo: String,
  etapa: String,
  parametros: Object 
});
const Recomendacion = mongoose.model('Recomendacion', RecomendacionSchema);

// --- 3. INICIALIZAR LA IA ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- 4. RUTAS API ACTUALIZADAS PARA MULTI-CULTIVO ---

// Enviar historial a la App (Aumentamos a 100 para que puedas ver el de cultivos anteriores)
app.get('/api/historial', async (req, res) => {
  try {
    const historial = await Medicion.find().sort({ fecha: -1 }).limit(100);
    res.json(historial);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener datos" });
  }
});

// Guardar un NUEVO cultivo en la lista (Sin borrar los demás)
app.post('/api/cultivos', async (req, res) => {
  try {
    const nuevoCultivo = new CultivoConfig(req.body);
    await nuevoCultivo.save();
    console.log("📍 Nuevo cultivo agregado a la lista:", req.body.nombre);
    // IMPORTANTE: Devolvemos el objeto completo para que la app guarde el _id
    res.status(201).json(nuevoCultivo); 
  } catch (err) {
    res.status(500).json({ error: "Error al guardar configuración" });
  }
});

// Obtener TODOS los cultivos para mostrar los "Chips" (botones) en la App
app.get('/api/cultivos', async (req, res) => {
  try {
    const cultivos = await CultivoConfig.find().sort({ fecha: -1 });
    res.json(cultivos || []);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener la lista de cultivos" });
  }
});

// Chat Inteligente (Asistente Agrónomo Híbrido)
app.post('/api/asistente', async (req, res) => {
  try {
    const { pregunta } = req.body;
    const configActiva = await CultivoConfig.findOne().sort({ fecha: -1 });

    if (!configActiva) {
        return res.status(200).json({ 
          respuesta: "Por favor, configura el cultivo, el tamaño del terreno y el sistema de riego en la pantalla principal para darte consejos exactos." 
        });
    }

    const historialReciente = await Medicion.find({ cultivo: configActiva.nombre })
                                            .sort({ fecha: -1 })
                                            .limit(3);

    let datosTexto = "No hay datos recientes.";
    if (historialReciente.length > 0) {
      datosTexto = historialReciente.map(m => 
        `pH: ${m.ph}, Temp: ${m.temperatura}°C, Caudal: ${m.caudal}L/min`
      ).join(" | ");
    }

    const promptExperto = `
      Eres un ingeniero agrónomo experto ayudando a un productor en Honduras. 
      
      CONTEXTO DEL CULTIVO:
      * Cultivo: ${configActiva.nombre} (Etapa: ${configActiva.etapa})
      * Terreno: ${configActiva.tamanoTerreno} Manzanas (Aprox. ${configActiva.tamanoTerreno * 7000} m2).
      * Sistema de Riego: ${configActiva.sistemaRiego}.
      
      DATOS RECIENTES SENSORES: [ ${datosTexto} ]
      
      PREGUNTA DEL PRODUCTOR: "${pregunta}"
      
      REGLAS DE TU RESPUESTA:
      1. Sé directo, técnico pero amigable (máximo 4 líneas).
      2. Evalúa matemáticamente si el Caudal medido es suficiente para cubrir la demanda hídrica de las ${configActiva.tamanoTerreno} manzanas por ${configActiva.sistemaRiego}.
      3. Da una recomendación hidráulica clara si el caudal no cuadra con el tamaño del terreno.
      4. No uses palabras complicadas, formatos de negritas, ni símbolos raros. Escribe como un mensaje de texto normal.
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(promptExperto);
    
    res.status(200).json({ respuesta: result.response.text() });

  } catch (error) {
    console.error("❌ Error con la IA:", error);
    res.status(500).json({ error: "El asistente está calculando, intenta en un momento." });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor API corriendo en puerto ${PORT}`));

// --- 5. LÓGICA MQTT (CEREBRO EVALUADOR) ---
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
    
    // NOTA PARA TU TESIS: El ESP32 siempre registrará datos para el último cultivo que hayas agregado en la App.
    const configActiva = await CultivoConfig.findOne().sort({ fecha: -1 });
    let consejosMatriz = []; 
    
    if (configActiva) {
      data.cultivo = configActiva.nombre;
      data.etapa = configActiva.etapa;
      
      const matriz = await Recomendacion.findOne({ cultivo: data.cultivo, etapa: data.etapa });

      if (matriz && matriz.parametros) {
        const p = matriz.parametros;

        if (data.ph < p.ph.min) {
          consejosMatriz.push(`Profesional: ${p.ph.bajo_prof}`);
          consejosMatriz.push(`Empírica: ${p.ph.bajo_emp}`);
        } else if (data.ph > p.ph.max) {
          consejosMatriz.push(`Profesional: ${p.ph.alto_prof}`);
          consejosMatriz.push(`Empírica: ${p.ph.alto_emp}`);
        }

        if (data.temperatura < p.temperatura.min) {
          consejosMatriz.push(`Profesional: ${p.temperatura.bajo_prof}`);
          consejosMatriz.push(`Empírica: ${p.temperatura.bajo_emp}`);
        } else if (data.temperatura > p.temperatura.max) {
          consejosMatriz.push(`Profesional: ${p.temperatura.alto_prof}`);
          consejosMatriz.push(`Empírica: ${p.temperatura.alto_emp}`);
        }

        if (data.caudal < p.caudal.min) {
          consejosMatriz.push(`Profesional: ${p.caudal.bajo_prof}`);
          consejosMatriz.push(`Empírica: ${p.caudal.bajo_emp}`);
        } else if (data.caudal > p.caudal.max) {
          consejosMatriz.push(`Profesional: ${p.caudal.alto_prof}`);
          consejosMatriz.push(`Empírica: ${p.caudal.alto_emp}`);
        }
      }
    }

    const nuevaMedicion = new Medicion({ 
      ...data, 
      recomendaciones: consejosMatriz 
    });
    
    await nuevaMedicion.save();
    console.log(`💾 Sensor guardado para ${data.cultivo}. Recomendaciones insertadas: ${consejosMatriz.length}`);
  } catch (err) {
    console.error("❌ Error al procesar mensaje MQTT:", err);
  }
});