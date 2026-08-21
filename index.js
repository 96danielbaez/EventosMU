require("dotenv").config();
const mongoose = require("mongoose");
const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  EmbedBuilder,
} = require("discord.js");

// ================= MONGOOSE MODELS =================
const SettingsSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: String,
  timezone: { type: Number, default: 2 },
  ianaZone: { type: String, default: "Europe/Madrid" },
  roleId: String,
  messageId: String,
  additionalText: String,
  lastUpdatedBy: String,
  embedColor: { type: String, default: "#AA151B" },
});
const Settings = mongoose.model("Settings", SettingsSchema);

const EventSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  id: Number,
  nombre: String,
  timestamp: Number,
  userId: String,
  username: String,
});
const EventModel = mongoose.model("Event", EventSchema);

// ================= DATABASE CONNECTION =================
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

// ================= HELPERS DB =================
async function getSettings(guildId) {
  let settings = await Settings.findOne({ guildId });
  if (!settings) {
    settings = await Settings.create({ guildId });
  }
  return settings;
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

// Validaciones de formatos
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/; // HH:mm
const DATE_RE = /^([0-2]\d|3[0-1])-(0[1-9]|1[0-2])$/; // DD-MM
const WEEKDAYS = {
  lunes: 1,
  martes: 2,
  miercoles: 3,
  miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sábado: 6,
  domingo: 0,
};

// ================= HELPER REPLY =================
async function replyAndDelete(interaction, content) {
  try {
    // Color rojo para errores, eliminaciones o borrados
    const isRed =
      content.includes("❌") ||
      content.includes("ELIMINADO") ||
      content.includes("BORRADO");
    // Color amarillo para comandos de configuración exitosos
    const isConfig = ["canal", "permisos", "timezone"].includes(
      interaction.commandName || "",
    );
    const isPublic = ["listar", "proximo"].includes(
      interaction.commandName || "",
    );

    let color = 0x00ae86; // Verde (éxito por defecto)
    if (isRed) color = 0xff0000;
    else if (isConfig) color = 0xffcc00;

    const embed = new EmbedBuilder().setDescription(content).setColor(color);

    // Si la interacción ya fue diferida o respondida, usamos editReply
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [embed] });
    } else {
      // Aunque deferReply ya se encarga de esto, lo mantenemos por si acaso
      // se llama replyAndDelete sin un defer previo (ej. en un error no capturado antes).
      await interaction.reply({ embeds: [embed], ephemeral: !isPublic });
    }
    // Borrar mensaje si no es público o si es un mensaje de error/eliminación
    if (!isPublic || isRed) {
      setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
    }
  } catch (err) {
    console.error("Error en replyAndDelete:", err);
  }
}

// ================= TIME HELPERS =================
function tzTimestampFromComponents(year, month, day, hour, minute, offset) {
  const offsetMs = Number(offset) * 60 * 60 * 1000;
  const msUTC = Date.UTC(year, month, day, hour, minute, 0, 0);
  const utcMs = msUTC - offsetMs;
  return Math.floor(utcMs / 1000);
}

function tzComponentsFromTimestamp(timestampSec, offset) {
  const offsetMs = Number(offset) * 60 * 60 * 1000;
  const d = new Date(timestampSec * 1000);
  const tzDate = new Date(d.getTime() + offsetMs);
  return {
    year: tzDate.getUTCFullYear(),
    month: tzDate.getUTCMonth(),
    day: tzDate.getUTCDate(),
    hour: tzDate.getUTCHours(),
    minute: tzDate.getUTCMinutes(),
  };
}

// ================= PERMISOS =================
async function tienePermiso(interaction) {
  const settings = await getSettings(interaction.guild.id);
  if (!settings.roleId) return true;
  return interaction.member.roles.cache.has(settings.roleId);
}

// Lista de zonas horarias comunes para el autocompletado
const TIMEZONES_LIST = [
  {
    name: "Argentina (Buenos Aires)",
    value: "America/Argentina/Buenos_Aires",
    color: "#74ACDF",
  },
  { name: "Bolivia (La Paz)", value: "America/La_Paz", color: "#007934" },
  { name: "Brasil (São Paulo)", value: "America/Sao_Paulo", color: "#009739" },
  { name: "Chile (Santiago)", value: "America/Santiago", color: "#0039A6" },
  { name: "Colombia (Bogotá)", value: "America/Bogota", color: "#FCD116" },
  { name: "Costa Rica", value: "America/Costa_Rica", color: "#EF1C27" },
  { name: "Ecuador (Guayaquil)", value: "America/Guayaquil", color: "#FFD700" },
  { name: "España (Madrid)", value: "Europe/Madrid", color: "#AA151B" },
  {
    name: "España (Islas Canarias)",
    value: "Atlantic/Canary",
    color: "#F9D616",
  },
  { name: "México (CDMX)", value: "America/Mexico_City", color: "#006847" },
  { name: "México (Tijuana)", value: "America/Tijuana", color: "#006847" },
  { name: "Paraguay (Asunción)", value: "America/Asuncion", color: "#D52B1E" },
  { name: "Perú (Lima)", value: "America/Lima", color: "#D91023" },
  {
    name: "Uruguay (Montevideo)",
    value: "America/Montevideo",
    color: "#0038A8",
  },
  { name: "Venezuela (Caracas)", value: "America/Caracas", color: "#F2D500" },
  {
    name: "USA (New York - Este)",
    value: "America/New_York",
    color: "#B22234",
  },
  {
    name: "USA (Los Angeles - Oeste)",
    value: "America/Los_Angeles",
    color: "#3C3B6E",
  },
];

// Mapping from IANA timezone to ISO 3166-1 alpha-2 country code for flags
const IANA_TO_COUNTRY_CODE = {
  "America/Argentina/Buenos_Aires": "AR",
  "America/La_Paz": "BO",
  "America/Sao_Paulo": "BR",
  "America/Santiago": "CL",
  "America/Bogota": "CO",
  "America/Costa_Rica": "CR",
  "America/Guayaquil": "EC",
  "Europe/Madrid": "ES",
  "Atlantic/Canary": "ES", // Canary Islands are part of Spain
  "America/Mexico_City": "MX",
  "America/Tijuana": "MX",
  "America/Asuncion": "PY",
  "America/Lima": "PE",
  "America/Montevideo": "UY",
  "America/Caracas": "VE",
  "America/New_York": "US",
  "America/Los_Angeles": "US",
};

const PAISES_HORARIOS = [{ n: "ES", z: "Europe/Madrid", f: "🇪🇸" }];

// Helper function to get flag emoji from ISO 3166-1 alpha-2 country code
function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return "";
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 0x1f1e6 + (char.charCodeAt(0) - "A".charCodeAt(0)));
  return String.fromCodePoint(...codePoints);
}

// Helper para normalizar texto (quitar tildes y convertir a minúsculas)
function normalizeString(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function getOffsetHours(ianaZone) {
  try {
    const now = new Date();
    const tzDate = new Date(
      now.toLocaleString("en-US", { timeZone: ianaZone }),
    );
    const utcDate = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
    return Math.round(
      (tzDate.getTime() - utcDate.getTime()) / (1000 * 60 * 60),
    );
  } catch (e) {
    return null;
  }
}

function formatTiempoRestante(timestampSec, nowSec = Math.floor(Date.now() / 1000)) {
  const diffSec = Math.max(0, timestampSec - nowSec);
  const totalMinutes = Math.floor(diffSec / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `quedan ${hours}h ${minutes}m`;
  if (minutes > 0) return `quedan ${minutes}m`;
  return "menos de 1m";
}

function generarEmbedHorarios(
  eventos,
  offset,
  additionalText,
  ianaZone = null,
  embedColor = "#AA151B",
) {
  const ahora = Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder().setColor(embedColor);
  let locationDisplay = `UTC ${offset >= 0 ? "+" : ""}${offset}`;
  let flagEmoji = "";
  if (ianaZone) {
    const zoneInfo = TIMEZONES_LIST.find((tz) => tz.value === ianaZone);
    if (zoneInfo) locationDisplay = zoneInfo.name;
    const countryCode = IANA_TO_COUNTRY_CODE[ianaZone];
    if (countryCode) {
      flagEmoji = getFlagEmoji(countryCode);
    }
  }

  let description = "# LISTA DE HORARIOS\n";

  const proximo = eventos.find((e) => e.timestamp > ahora);
  const SEPARATOR = "▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪"; // ~30 caracteres para mejor cobertura visual
  description += `\u200B \n`;
  if (proximo) {
    description += `**PRÓXIMO EVENTO:**\n <t:${proximo.timestamp}:R>\n`;
  } else {
    description += `**PRÓXIMO EVENTO:**\n 😴 **No hay eventos cargados**\n`;
  }
  description += `\u200B \n`;

  if (additionalText) description += `${additionalText}\n\n`;

  // A diferencia de :R, :t muestra la hora exacta sin redondear el tiempo restante.
  const footerRelativo = `-# 🔄 Última actualización: <t:${ahora}:t>`;

  if (eventos.length === 0) {
    embed.setDescription(description + "\n" + footerRelativo);
    return embed;
  }

  // Definición de países solicitados
  const paises = [{ n: "ES", z: "Europe/Madrid", f: "🇪🇸" }];

  const fields = [];
  eventos.forEach((e, i) => {
    const top = paises.slice(0, 3);
    const bottom = paises.slice(3, 6);

    const formatRow = (arr) =>
      arr
        .map((p) => {
          const hora = new Intl.DateTimeFormat("en-GB", {
            timeZone: p.z,
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(e.timestamp * 1000));

          return `${p.f} ${hora}`;
        })
        .join("  |  ");

    const multiHora = [formatRow(top), formatRow(bottom)]
      .filter(Boolean)
      .join("\n")
      .replace(/^/, "-# ");

    const expirado = ahora > e.timestamp;
    const item = `**[#${e.id}]** **<t:${e.timestamp}:t>** (<t:${e.timestamp}:R>)\n-# Añadido por: <@${e.userId}>`;
    const contenido = expirado ? `~~${item}~~` : item;

    const isLast = i === eventos.length - 1;

    fields.push({
      name: `🔥 ${e.nombre}`,
      value: isLast ? contenido : `${contenido}\n-# ${SEPARATOR}`,
      inline: false,
    });
  });

  // Agregamos un campo invisible al final para mostrar el "actualizado hace..."
  // Esto hace que aparezca al final de la lista, simulando un footer.
  fields.push({ name: "\u200B", value: footerRelativo });

  embed.addFields(fields);
  embed.setDescription(description);
  return embed;
}

function generarEmbedProximo(evento, embedColor = "#AA151B") {
  const embed = new EmbedBuilder().setColor(embedColor);

  if (!evento) {
    embed.setTitle("PRÓXIMO EVENTO");
    embed.setDescription("😴 **No hay eventos cargados**");
    return embed;
  }

  const top = PAISES_HORARIOS.slice(0, 3);
  const bottom = PAISES_HORARIOS.slice(3, 6);

  const formatRow = (arr) =>
    arr
      .map((p) => {
        const hora = new Intl.DateTimeFormat("en-GB", {
          timeZone: p.z,
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(evento.timestamp * 1000));

        return `${p.f} ${hora}`;
      })
      .join("  |  ");

  const multiHora = [formatRow(top), formatRow(bottom)]
    .filter(Boolean)
    .join("\n")
    .replace(/^/, "-# ");

  embed.setTitle("PRÓXIMO EVENTO");
  embed.setDescription(
    `**${evento.nombre}**\n**<t:${evento.timestamp}:t>** (<t:${evento.timestamp}:R>)`,
  );
  embed.addFields({ name: "Horarios", value: multiHora });
  return embed;
}

// Control de temporizadores por servidor
const guildsTimeouts = new Map();

// ================= MENSAJE =================
async function actualizarMensaje(client, guildId, updaterId = null) {
  const settings = await getSettings(guildId);
  if (!settings.channelId) return;

  const channel = await client.channels.fetch(settings.channelId);

  if (updaterId) {
    settings.lastUpdatedBy = updaterId;
    await settings.save();
  }

  const ahora = Math.floor(Date.now() / 1000);
  const offset = settings.timezone;
  const nowTz = tzComponentsFromTimestamp(ahora, offset);

  // Calcular el inicio del día actual (00:00) en la zona horaria del servidor
  const inicioDelDiaTz = tzTimestampFromComponents(
    nowTz.year,
    nowTz.month,
    nowTz.day,
    0,
    0,
    offset,
  );

  // Limpiar automáticamente eventos de días anteriores (que ya terminaron el día anterior)
  await EventModel.deleteMany({
    guildId,
    timestamp: { $lt: inicioDelDiaTz },
  });

  const eventos = await EventModel.find({ guildId }).sort({ timestamp: 1 });

  // Intentar buscar el mensaje existente para editarlo
  let existingMessage = null;
  if (settings.messageId) {
    existingMessage = await channel.messages
      .fetch(settings.messageId)
      .catch(() => null);
  }

  try {
    const embed = generarEmbedHorarios(
      eventos,
      settings.timezone,
      settings.additionalText,
      settings.ianaZone,
      settings.embedColor,
    );

    if (existingMessage) {
      await existingMessage.edit({ embeds: [embed] });
      console.log(
        `Mensaje editado para guild=${guildId}. ID: ${existingMessage.id}`,
      );
    } else {
      const m = await channel.send({ embeds: [embed] });
      settings.messageId = m.id;
      await settings.save();
      console.log(`Nuevo mensaje creado para guild=${guildId}. ID: ${m.id}`);
    }

    // --- PROGRAMAR PRÓXIMA ACTUALIZACIÓN ---
    // Limpiamos cualquier timeout previo para este servidor
    if (guildsTimeouts.has(guildId)) {
      clearTimeout(guildsTimeouts.get(guildId));
    }

    // Buscamos el próximo hito de actualización: el próximo evento O la medianoche local
    const proximoEvento = eventos.find((e) => e.timestamp > ahora);
    const proximaMedianocheTz = tzTimestampFromComponents(
      nowTz.year,
      nowTz.month,
      nowTz.day + 1,
      0,
      0,
      offset,
    );

    // El bot se actualizará en el próximo evento o al cambio de día, lo que ocurra primero
    const proximoUpdate = proximoEvento
      ? Math.min(proximoEvento.timestamp, proximaMedianocheTz)
      : proximaMedianocheTz;

    const delay = (proximoUpdate - ahora) * 1000 + 2000;
    const MAX_DELAY = 24 * 60 * 60 * 1000;
    const finalDelay = Math.max(0, Math.min(delay, MAX_DELAY));

    const timer = setTimeout(
      () => actualizarMensaje(client, guildId),
      finalDelay,
    );
    guildsTimeouts.set(guildId, timer);
  } catch (err) {
    console.error("Error actualizarMensaje:", err);
  }
}

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once(Events.ClientReady, () => {
  console.log(`Conectado como ${client.user.tag}`);
});

// ================= ACTUALIZACIÓN PERIÓDICA =================
function startAutoUpdate(client) {
  console.log(`Iniciando sistema de actualización automática por eventos...`);

  // Al arrancar, disparamos una actualización inicial para cada servidor configurado
  // Esto activará la cadena de temporizadores basados en el próximo evento.
  Settings.find({ channelId: { $exists: true } })
    .then((allSettings) => {
      for (const s of allSettings) {
        actualizarMensaje(client, s.guildId).catch((err) =>
          console.error(`Error inicializando guild ${s.guildId}:`, err),
        );
      }
    })
    .catch((err) =>
      console.error("Error cargando configuraciones iniciales:", err),
    );
}

client.on(Events.ClientReady, () => {
  startAutoUpdate(client);
});

// ================= INTERACCIONES (UN SOLO HANDLER) =================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ================= AUTOCOMPLETE =================
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "timezone") {
        const focusedValue = normalizeString(interaction.options.getFocused());
        const filtered = TIMEZONES_LIST.filter(
          (tz) =>
            normalizeString(tz.name).includes(focusedValue) ||
            normalizeString(tz.value).includes(focusedValue),
        ).slice(0, 25); // Discord permite máx 25 opciones

        await interaction.respond(
          filtered.map((tz) => ({ name: tz.name, value: tz.value })),
        );
      }
      return;
    }

    // ================= BUTTONS =================
    if (interaction.isButton()) {
      if (interaction.customId === "confirm_reset") {
        await interaction.deferUpdate();

        await EventModel.deleteMany({ guildId: interaction.guild.id });
        const settings = await getSettings(interaction.guild.id);
        settings.additionalText = undefined;
        await settings.save();
        await actualizarMensaje(
          interaction.client,
          interaction.guild.id,
          interaction.user.id,
        );

        const embed = new EmbedBuilder()
          .setDescription("✅ HORARIOS RESETEADOS")
          .setColor(0xff0000); // Rojo para indicar que se borró todo
        await interaction.editReply({
          content: null,
          embeds: [embed],
          components: [],
          ephemeral: true,
        });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
        return;
      }

      if (interaction.customId === "cancel_reset") {
        const embed = new EmbedBuilder()
          .setDescription("❌ CANCELADO")
          .setColor(0xff0000);
        await interaction.update({
          content: null,
          embeds: [embed],
          components: [],
          ephemeral: true,
        });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
        return;
      }

      return;
    }

    // ================= COMMAND =================
    const cmd = interaction.commandName;

    // Diferimos la respuesta inmediatamente para evitar el timeout de 3 segundos
    // Si es el comando 'listar' o 'proximo', lo hacemos público (ephemeral: false)
    if (interaction.isChatInputCommand()) {
      const isPublic = ["listar", "proximo"].includes(cmd);
      await interaction.deferReply({ ephemeral: !isPublic });
    }

    const adminOnly = ["permisos", "canal", "timezone", "resetear"];
    const roleProtected = [
      "agregar",
      "editar",
      "eliminar",
      "actualizar",
      "configuracion",
    ];

    // ================= ADMIN CHECK (FIX IMPORTANTE) =================
    if (adminOnly.includes(cmd)) {
      const isOwner = interaction.guild.ownerId === interaction.user.id;
      const isAdmin = interaction.member.permissions.has(
        PermissionsBitField.Flags.Administrator,
      );

      if (!isOwner && !isAdmin) {
        return await replyAndDelete(
          interaction,
          "❌ Solo OWNER o ADMIN pueden usar este comando.",
        );
      }
    }

    // ================= ROLE CHECK =================
    if (roleProtected.includes(cmd)) {
      if (!(await tienePermiso(interaction))) {
        return await replyAndDelete(
          interaction,
          "❌ No tenés permisos para usar este comando.",
        );
      }
    }

    // ================= /PERMISOS =================
    if (cmd === "permisos") {
      const rol = interaction.options.getRole("rol");

      if (!rol) {
        return await replyAndDelete(
          interaction,
          "❌ Debés seleccionar un rol válido.",
        );
      }

      const settings = await getSettings(interaction.guild.id);
      settings.roleId = rol.id;
      await settings.save();
      return await replyAndDelete(
        interaction,
        `✅ Rol autorizado: **${rol.name}**`,
      );
    }

    // ================= /CANAL =================
    if (cmd === "canal") {
      const canal = interaction.options.getChannel("canal");

      if (!canal) {
        return await replyAndDelete(interaction, "❌ Canal inválido.");
      }

      const settings = await getSettings(interaction.guild.id);
      settings.channelId = canal.id;
      await settings.save();

      // Actualizar el mensaje principal automáticamente al cambiar el canal
      await actualizarMensaje(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
      );

      return await replyAndDelete(
        interaction,
        `✅ Canal configurado: <#${canal.id}>`,
      );
    }

    // ================= /RESET =================
    if (cmd === "resetear") {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("confirm_reset")
          .setLabel("Confirmar")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("cancel_reset")
          .setLabel("Cancelar")
          .setStyle(ButtonStyle.Secondary),
      );

      const settings = await getSettings(interaction.guild.id);
      const targetChannelId = settings.channelId;
      const isDifferentChannel =
        targetChannelId && interaction.channelId !== targetChannelId;

      const embed = new EmbedBuilder()
        .setDescription("¿ESTÁS SEGURO? •⚠️")
        .setColor(0xffcc00); // Color amarillo para advertencia
      await interaction.editReply({
        embeds: [embed],
        components: [row],
        ephemeral: true,
      });
      return setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
    }

    // ================= /AGREGAR =================
    if (cmd === "agregar") {
      const nombre = interaction.options.getString("nombre");
      const horario = interaction.options.getString("horario");
      const fechaTexto = interaction.options.getString("fecha");
      const diaInput = interaction.options.getString("dia");

      // Validaciones de input
      if (!TIME_RE.test(horario)) {
        return await replyAndDelete(
          interaction,
          "❌ Formato de horario inválido. Usa HH:mm (ej: 05:30)",
        );
      }

      if (fechaTexto && !DATE_RE.test(fechaTexto)) {
        return await replyAndDelete(
          interaction,
          "❌ Formato de fecha inválido. Usa DD-MM (ej: 08-06)",
        );
      }

      if (fechaTexto && diaInput) {
        return await replyAndDelete(
          interaction,
          "❌ No podés usar 'fecha' y 'dia' al mismo tiempo.",
        );
      }

      const settings = await getSettings(interaction.guild.id);
      if (!settings.channelId) {
        return await replyAndDelete(
          interaction,
          "❌ Primero define el canal de eventos con /canal antes de agregar un evento.",
        );
      }

      const offset = settings.timezone;
      const [h, m] = horario.split(":").map(Number);

      // Calcular timestamp en UTC a partir de componentes en TZ
      const nowSec = Math.floor(Date.now() / 1000);
      const nowTz = tzComponentsFromTimestamp(nowSec, offset);

      let year = nowTz.year;
      let month = nowTz.month;
      let day = nowTz.day;

      let timestamp;

      if (fechaTexto) {
        const [dia, mes] = fechaTexto.split("-").map(Number);
        month = mes - 1;
        day = dia;
        timestamp = tzTimestampFromComponents(year, month, day, h, m, offset);
      } else if (diaInput) {
        const targetIndex = WEEKDAYS[diaInput.toLowerCase()];
        if (targetIndex === undefined) {
          return await replyAndDelete(
            interaction,
            "❌ Día de la semana inválido. Usá Lunes, Martes, etc.",
          );
        }

        const currentTzDate = new Date(
          Date.UTC(nowTz.year, nowTz.month, nowTz.day),
        );
        const currentDayIndex = currentTzDate.getUTCDay();
        let daysToAdd = (targetIndex - currentDayIndex + 7) % 7;

        timestamp = tzTimestampFromComponents(
          year,
          month,
          day + daysToAdd,
          h,
          m,
          offset,
        );

        // Si es hoy y ya pasó el horario, saltamos a la semana que viene
        if (daysToAdd === 0 && timestamp <= nowSec) {
          timestamp += 7 * 24 * 60 * 60;
        }
      } else {
        timestamp = tzTimestampFromComponents(year, month, day, h, m, offset);
        // Si no se pasó fecha/día y ya pasó hoy → mañana
        if (timestamp <= nowSec) timestamp += 24 * 60 * 60;
      }

      const id = await getNextEventId(interaction.guild.id);
      await EventModel.create({
        guildId: interaction.guild.id,
        id,
        nombre: nombre.toUpperCase(),
        timestamp,
        userId: interaction.user.id,
        username: interaction.user.username,
      });

      await actualizarMensaje(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
      );

      const infoHorario = fechaTexto
        ? `${horario} (${fechaTexto})`
        : diaInput
          ? `${horario} (${diaInput})`
          : horario;
      return await replyAndDelete(
        interaction,
        `✅ Evento (#${id}) • **${nombre.toUpperCase()}** • **${infoHorario}** • **AGREGADO**`,
      );
    }

    // ================= /ELIMINAR =================
    if (cmd === "eliminar") {
      const id = interaction.options.getInteger("id");

      if (!Number.isInteger(id) || id <= 0) {
        return await replyAndDelete(
          interaction,
          `❌ ID inválido. Debe ser un número entero positivo.`,
        );
      }

      const result = await EventModel.deleteOne({
        guildId: interaction.guild.id,
        id,
      });

      if (result.deletedCount === 0) {
        return await replyAndDelete(interaction, `❌ No existe evento #${id}`);
      }

      await actualizarMensaje(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
      );

      return await replyAndDelete(
        interaction,
        `✅ EVENTO #${id} **ELIMINADO**`,
      );
    }
    // ================= /TIMEZONE =================
    if (cmd === "timezone") {
      const ianaZoneInput = interaction.options.getString("zona");

      // Buscar en la lista de zonas permitidas (mismo sistema que /horario)
      const found = TIMEZONES_LIST.find(
        (tz) =>
          tz.value === ianaZoneInput ||
          normalizeString(tz.name).includes(normalizeString(ianaZoneInput)),
      );

      if (!found) {
        return await replyAndDelete(
          interaction,
          "❌ La zona horaria o país ingresado no es válido. Por favor, seleccioná una opción de la lista desplegable.",
        );
      }

      const calculatedOffset = getOffsetHours(found.value);
      if (calculatedOffset === null) {
        return await replyAndDelete(
          interaction,
          "❌ No se pudo calcular el horario para esa zona.",
        );
      }

      const settings = await getSettings(interaction.guild.id);
      settings.timezone = calculatedOffset;
      settings.ianaZone = found.value;
      if (found.color) settings.embedColor = found.color;
      await settings.save();

      // Actualizar el mensaje principal automáticamente
      await actualizarMensaje(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
      );

      const flag = getFlagEmoji(IANA_TO_COUNTRY_CODE[found.value]);
      return await replyAndDelete(
        interaction,
        `🌍 Configuración actualizada: **${found.name}** (UTC ${calculatedOffset >= 0 ? "+" : ""}${calculatedOffset}) ${flag}`,
      );
    }

    // ================= /ACTUALIZAR =================
    if (cmd === "actualizar") {
      const settings = await getSettings(interaction.guild.id);
      if (!settings.channelId) {
        return await replyAndDelete(
          interaction,
          "❌ Primero define el canal de eventos con /canal.",
        );
      }

      await actualizarMensaje(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
      );
      return await replyAndDelete(
        interaction,
        "✅ Mensaje de horarios **ACTUALIZADO**.",
      );
    }

    // ================= /CONFIGURACION =================
    if (cmd === "configuracion") {
      const settings = await getSettings(interaction.guild.id);

      // Buscar el nombre amigable y la bandera de la zona configurada
      const zoneInfo = TIMEZONES_LIST.find(
        (tz) => tz.value === settings.ianaZone,
      );
      const flag = settings.ianaZone
        ? getFlagEmoji(IANA_TO_COUNTRY_CODE[settings.ianaZone])
        : "";
      const zoneDisplay = zoneInfo ? `${zoneInfo.name} ${flag}` : "Manual";

      const embed = new EmbedBuilder()
        .setTitle("⚙️ Configuración Actual")
        .setColor(settings.embedColor || "#AA151B")
        .addFields(
          {
            name: "📍 Canal de Eventos",
            value: settings.channelId
              ? `<#${settings.channelId}>`
              : "No configurado",
            inline: true,
          },
          {
            name: "🌍 Zona Horaria",
            value: `${zoneDisplay} (UTC ${settings.timezone >= 0 ? "+" : ""}${settings.timezone})`,
            inline: true,
          },
          {
            name: "🛡️ Rol con Permisos",
            value: settings.roleId
              ? `<@&${settings.roleId}>`
              : "Todos (propietario/admin)",
            inline: true,
          },
          {
            name: "🎨 Color (Zona)",
            value: `**${settings.embedColor || "#AA151B"}**`,
            inline: true,
          },
          {
            name: "📝 Mensaje Adicional",
            value: settings.additionalText || "Ninguno",
          },
        )
        .setFooter({ text: "Datos guardados en MongoDB" });

      await interaction.editReply({ embeds: [embed], ephemeral: true });
      return setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
    }

    // ================= /MENSAJE =================
    if (cmd === "mensaje") {
      const texto = interaction.options.getString("mensaje") || "";

      const settings = await getSettings(interaction.guild.id);
      settings.additionalText = texto || undefined;
      await settings.save();
      await actualizarMensaje(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
      );

      return await replyAndDelete(
        interaction,
        texto ? `✅ Mensaje **AGREGADO**.` : `✅ Mensaje **BORRADO**.`,
      );
    }

    // ================= /PROXIMO =================
    if (cmd === "proximo") {
      const ahora = Math.floor(Date.now() / 1000);
      const guildId = interaction.guild.id;
      const settings = await getSettings(guildId);
      const evento = await EventModel.findOne({
        guildId,
        timestamp: { $gt: ahora },
      })
        .sort({ timestamp: 1 })
        .lean();

      if (!evento) {
        const embed = new EmbedBuilder()
          .setColor(settings.embedColor || "#AA151B")
          .setTitle("PRÓXIMO EVENTO")
          .setDescription("😴 **No hay próximos eventos cargados**");
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      const embed = generarEmbedProximo(evento, settings.embedColor);
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    // ================= /EDITAR =================
    if (cmd === "editar") {
      const id = interaction.options.getInteger("id");
      const nombre = interaction.options.getString("nombre");
      const horario = interaction.options.getString("horario");
      const fechaTexto = interaction.options.getString("fecha");

      // Validar id
      if (!Number.isInteger(id) || id <= 0) {
        return await replyAndDelete(
          interaction,
          `❌ ID inválido. Debe ser un número entero positivo.`,
        );
      }

      // Validar formatos si se pasaron
      if (horario && !TIME_RE.test(horario)) {
        return await replyAndDelete(
          interaction,
          "❌ Formato de horario inválido. Usa HH:mm (ej: 05:30)",
        );
      }

      if (fechaTexto && !DATE_RE.test(fechaTexto)) {
        return await replyAndDelete(
          interaction,
          "❌ Formato de fecha inválido. Usa DD-MM (ej: 08-06)",
        );
      }

      const evento = await EventModel.findOne({
        guildId: interaction.guild.id,
        id,
      });

      if (!evento) {
        return await replyAndDelete(interaction, "❌ NO EXISTE");
      }

      const oldName = evento.nombre;
      let changedName = false;
      let changedTime = false;
      let changedDate = false;

      if (nombre && nombre !== oldName) {
        evento.nombre = nombre.toUpperCase();
        changedName = true;
      }

      if (horario || fechaTexto) {
        if (horario) changedTime = true;
        const settings = await getSettings(interaction.guild.id);
        const offset = settings.timezone;

        // Si no se pasa `fecha`, usamos la fecha ACTUAL en la TZ del servidor
        // para que editar sólo el horario aplique al día de hoy (o mañana
        // si el horario ya pasó). Si se pasa `fecha`, se sobrescribe abajo.
        const nowSec = Math.floor(Date.now() / 1000);
        const base = tzComponentsFromTimestamp(nowSec, offset);

        let year = base.year;
        let month = base.month;
        let day = base.day;
        let hours = base.hour;
        let minutes = base.minute;

        // Si se pasó fecha, reemplazar día/mes (validar formato DD-MM)
        if (fechaTexto) {
          const parts = fechaTexto.split("-").map(Number);
          if (
            parts.length === 2 &&
            Number.isInteger(parts[0]) &&
            Number.isInteger(parts[1])
          ) {
            const [dia, mes] = parts;
            if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
              month = mes - 1;
              day = dia;
            } else {
              return await replyAndDelete(
                interaction,
                "❌ Formato de fecha inválido. Usa DD-MM (ej: 08-06)",
              );
            }
          } else {
            return await replyAndDelete(
              interaction,
              "❌ Formato de fecha inválido. Usa DD-MM (ej: 08-06)",
            );
          }
        }

        // Si se pasó horario, reemplazar horas/minutos
        if (horario) {
          const [h, m] = horario.split(":").map(Number);
          hours = h;
          minutes = m;
        }

        // Crear nuevo timestamp (UTC) a partir de componentes en TZ
        evento.timestamp = tzTimestampFromComponents(
          year,
          month,
          day,
          hours,
          minutes,
          offset,
        );

        // Si no se pasó fecha y el nuevo horario ya pasó respecto a ahora, mover al siguiente día
        if (!fechaTexto) {
          const nowSec = Math.floor(Date.now() / 1000);
          if (evento.timestamp <= nowSec) evento.timestamp += 24 * 60 * 60;
        }
        changedDate = true;
      }

      await evento.save();
      await actualizarMensaje(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
      );

      // Preparar mensaje de confirmación con detalles
      const details = [];
      const settings = await getSettings(interaction.guild.id);
      const offsetMsg = settings.timezone;
      const offsetMs2 = offsetMsg * 60 * 60 * 1000;
      const newDate = new Date(evento.timestamp * 1000);
      const newDateInTZ = new Date(newDate.getTime() + offsetMs2);
      const dd = String(newDateInTZ.getUTCDate()).padStart(2, "0");
      const mm = String(newDateInTZ.getUTCMonth() + 1).padStart(2, "0");
      const hh = String(newDateInTZ.getUTCHours()).padStart(2, "0");
      const min = String(newDateInTZ.getUTCMinutes()).padStart(2, "0");

      if (changedName)
        details.push(`Nuevo nombre: **${evento.nombre.toUpperCase()}**`);
      if (changedDate)
        details.push(`Nueva fecha: **${dd}-${mm} ${hh}:${min}**`);
      else if (changedTime) details.push(`Nuevo horario: **${hh}:${min}**`);

      const base = `✅ Evento #${id} **EDITADO**`;
      const message = details.length
        ? `${base} — ${details.join(" | ")}`
        : base;

      return await replyAndDelete(interaction, message);
    }

    // ================= /LISTAR =================
    if (cmd === "listar") {
      // Forzamos la obtención del miembro desde la API para asegurar datos de voz actualizados
      const member = await interaction.guild.members
        .fetch(interaction.user.id)
        .catch(() => interaction.member);
      const voiceChannel = member?.voice?.channel;

      if (!voiceChannel) {
        return await replyAndDelete(
          interaction,
          "❌ No estás en un canal de voz.",
        );
      }

      const members = Array.from(voiceChannel.members.values());

      // Mezclar aleatoriamente (Fisher-Yates)
      for (let i = members.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [members[i], members[j]] = [members[j], members[i]];
      }

      if (!members.length) {
        return await replyAndDelete(
          interaction,
          "❌ No hay usuarios en tu canal de voz.",
        );
      }

      const lines = members.map((m) => {
        const name =
          m.nickname || (m.user && m.user.globalName) || m.user.username;
        return `${name}`;
      });

      const content = "```\n" + lines.join("\n") + "\n```";

      return await interaction.editReply({ content });
    }
  } catch (err) {
    console.error("ERROR INTERACTION:", err);

    if (interaction.isRepliable()) {
      try {
        return await replyAndDelete(interaction, "❌ Error interno del bot.");
      } catch {}
    }
  }
});

client.login(process.env.TOKEN);
