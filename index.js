const mongoose = require('mongoose');
const mqtt = require('mqtt');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. CONEXIÓN A MONGODB ATLAS ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Conectado a MongoDB Atlas"))
  .catch(err => console.error("❌ Error Mongo:", err));

// --- 2. MODELOS ---
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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- 4. RUTAS API ---

app.get('/api/historial', async (req, res) => {
  try {
    const historial = await Medicion.find().sort({ fecha: -1 }).limit(100);
    res.json(historial);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener datos" });
  }
});

// AÑADIR CULTIVO (Con log de éxito para evitar trabas)
app.post('/api/cultivos', async (req, res) => {
  try {
    console.log("📥 Petición para agregar cultivo:", req.body.nombre);
    const nuevoCultivo = new CultivoConfig(req.body);
    await nuevoCultivo.save();
    console.log("✅ Cultivo guardado exitosamente.");
    res.status(201).json(nuevoCultivo); 
  } catch (err) {
    console.error("❌ Error al guardar:", err);
    res.status(500).json({ error: "Error al guardar configuración" });
  }
});

app.get('/api/cultivos', async (req, res) => {
  try {
    const cultivos = await CultivoConfig.find().sort({ fecha: -1 });
    res.json(cultivos || []);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener la lista" });
  }
});

// ELIMINAR CULTIVO (Borrando también el historial)
app.delete('/api/cultivos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cultivoBorrado = await CultivoConfig.findByIdAndDelete(id);
    
    // MAGIA: Borramos también todo el historial de la base de datos
    if (cultivoBorrado && cultivoBorrado.nombre) {
      await Medicion.deleteMany({ cultivo: cultivoBorrado.nombre });
      console.log(`🗑️ Borrado total: Configuración e historial de ${cultivoBorrado.nombre}`);
    }
    res.status(200).json({ mensaje: "Eliminado de raíz" });
  } catch (err) {
    res.status(500).json({ error: "Error al eliminar" });
  }
});

// CHAT IA (Con el modelo corregido para evitar el 404)
app.post('/api/asistente', async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(200).json({ respuesta: "Falta API KEY." });

    const { pregunta } = req.body;
    const configActiva = await CultivoConfig.findOne().sort({ fecha: -1 });
    if (!configActiva) return res.status(200).json({ respuesta: "Configura un cultivo primero." });

    const historial = await Medicion.find({ cultivo: configActiva.nombre }).sort({ fecha: -1 }).limit(3);
    let datosTexto = historial.length > 0 ? historial.map(m => `pH: ${m.ph}, Temp: ${m.temperatura}°C, Caudal: ${m.caudal}L/min`).join(" | ") : "Sin datos.";

    const promptExperto = `Eres agrónomo. Contexto: ${configActiva.nombre} (${configActiva.etapa}), ${configActiva.tamanoTerreno}Mz, ${configActiva.sistemaRiego}. Datos: [${datosTexto}]. Pregunta: "${pregunta}". Sé directo, máximo 4 líneas.`;

    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent(promptExperto);
    res.status(200).json({ respuesta: result.response.text() });
  } catch (error) {
    console.error("❌ Error IA:", error);
    res.status(500).json({ error: "Error interno IA." });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor en puerto ${PORT}`));

// --- 5. MQTT ---
const client = mqtt.connect(process.env.MQTT_URL, { username: process.env.MQTT_USER, password: process.env.MQTT_PASS });
client.on('connect', () => { console.log("✅ MQTT Conectado"); client.subscribe('finca/monitoreo'); });

client.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const configActiva = await CultivoConfig.findOne().sort({ fecha: -1 });
    let consejosMatriz = []; 
    
    if (configActiva) {
      data.cultivo = configActiva.nombre;
      data.etapa = configActiva.etapa;
      
      const matriz = await Recomendacion.findOne({ cultivo: data.cultivo, etapa: data.etapa });
      if (matriz && matriz.parametros) {
        const p = matriz.parametros;
        if (data.ph < p.ph.min) { consejosMatriz.push(`Profesional: ${p.ph.bajo_prof}`); consejosMatriz.push(`Empírica: ${p.ph.bajo_emp}`); } 
        else if (data.ph > p.ph.max) { consejosMatriz.push(`Profesional: ${p.ph.alto_prof}`); consejosMatriz.push(`Empírica: ${p.ph.alto_emp}`); }
        if (data.temperatura < p.temperatura.min) { consejosMatriz.push(`Profesional: ${p.temperatura.bajo_prof}`); consejosMatriz.push(`Empírica: ${p.temperatura.bajo_emp}`); } 
        else if (data.temperatura > p.temperatura.max) { consejosMatriz.push(`Profesional: ${p.temperatura.alto_prof}`); consejosMatriz.push(`Empírica: ${p.temperatura.alto_emp}`); }
      }
    }
    await new Medicion({ ...data, recomendaciones: consejosMatriz }).save();
  } catch (err) { console.error("❌ Error MQTT:", err); }
});