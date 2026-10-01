require("dotenv").config();
const mongoose = require("mongoose");
const dns = require("dns");

dns.setServers(["1.1.1.1"]);

const SettingsSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: String,
  timezone: { type: Number, default: 2 },
  ianaZone: { type: String, default: "Europe/Madrid" },
  roleId: String,
  messageId: String,
  additionalText: String,
  lastUpdatedBy: String,
  embedColor: { type: String, default: "#6c04f3" },
  displayMode: { type: String, enum: ["all", "today_tomorrow"], default: "all" },
});

const EventSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  id: Number,
  nombre: String,
  timestamp: Number,
  repeat: { type: String, enum: ["daily", "weekly"], default: null },
  userId: String,
  username: String,
});

const Settings = mongoose.model("Settings", SettingsSchema);
const EventModel = mongoose.model("Event", EventSchema);

const dbUrl =
  process.env.MONGO_URL ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URL ||
  process.env.MONGODB_URI;

if (!dbUrl) {
  console.error(
    "❌ ERROR: No se encontró la variable MONGO_URL. Verificá la configuración en Railway.",
  );
} else {
  mongoose
    .connect(dbUrl)
    .then(() => console.log("✅ Conectado exitosamente a MongoDB (Railway)"))
    .catch((err) => console.error("❌ Error conectando a MongoDB:", err));
}

async function getSettings(guildId) {
  let settings = await Settings.findOne({ guildId });
  if (!settings) {
    settings = await Settings.create({ guildId });
  }
  return settings;
}

async function ensureDisplayModeMigration() {
  try {
    await Settings.updateMany(
      { displayMode: { $exists: false } },
      { $set: { displayMode: "all" } },
    );
  } catch (err) {
    console.error("Error migrando displayMode:", err);
  }
}

async function getNextEventId(guildId) {
  const events = await EventModel.find({ guildId })
    .select("id")
    .sort({ id: 1 });

  const ids = events.map((e) => e.id);
  let nextId = 1;

  for (const id of ids) {
    if (id === nextId) nextId++;
    else if (id > nextId) break;
  }

  return nextId;
}

module.exports = {
  mongoose,
  Settings,
  EventModel,
  getSettings,
  ensureDisplayModeMigration,
  getNextEventId,
};
