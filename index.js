const mongoose = require('mongoose');
const mqtt = require('mqtt');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. Conexión a MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Conectado a MongoDB Atlas"))
  .catch(err => console.error("❌ Error Mongo:", err));

// --- MODELOS ---
// Para los datos que vienen de los sensores
const MedicionSchema = new mongoose.Schema({
  cultivo: String,
  etapa: String,
  ph: Number,
  caudal: Number,
  temperatura: Number,
  alerta: String, // Para guardar si hubo un problema
  fecha: { type: Date, default: Date.now }
});
const Medicion = mongoose.model('Medicion', MedicionSchema);

// Para guardar la configuración activa elegida en la App
const CultivoConfigSchema = new mongoose.Schema({
  nombre: String,
  etapa: String,
  horario: String,
  tiempoRiego: Number,
  fecha: { type: Date, default: Date.now }
});
const CultivoConfig = mongoose.model('CultivoConfig', CultivoConfigSchema);

// --- RUTAS API ---

// Obtener historial para gráficas en la App
app.get('/api/historial', async (req, res) => {
  try {
    const historial = await Medicion.find().sort({ fecha: -1 }).limit(20);
    res.json(historial);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener datos" });
  }
});

// Recibir configuración de la App "HidroCampo"
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

const PORT = process.env.PORT || 3000;
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
    
    // 🧠 AQUÍ IRÁ LA LÓGICA DE VALIDACIÓN (Tu tabla de tesis)
    // Buscamos la configuración de cultivo más reciente
    const configActiva = await CultivoConfig.findOne().sort({ fecha: -1 });
    
    if (configActiva) {
      data.cultivo = configActiva.nombre;
      data.etapa = configActiva.etapa;
      
      // Ejemplo de validación para Tomate (pH 6.0 - 7.5)
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