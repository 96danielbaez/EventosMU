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
  roleId: String,
  messageId: String,
  additionalText: String,
  lastUpdatedBy: String,
});
const Settings = mongoose.model("Settings", SettingsSchema);

const EventSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  id: Number,
  nombre: String,
  timestamp: Number,
  userId: String,
});
const EventModel = mongoose.model("Event", EventSchema);

// ================= DATABASE CONNECTION =================
const dbUrl = process.env.MONGO_URL || process.env.MONGO_URI || process.env.MONGODB_URL;

if (!dbUrl) {
  console.error("❌ ERROR: No se encontró la variable MONGO_URL. Verificá la configuración en Railway.");
} else {
  mongoose.connect(dbUrl)
    .then(() => console.log("✅ Conectado exitosamente a MongoDB (Railway)"))
    .catch(err => console.error("❌ Error conectando a MongoDB:", err));
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
  const lastEvent = await EventModel.findOne({ guildId }).sort({ id: -1 });
  return lastEvent ? lastEvent.id + 1 : 1;
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
async function replyAndDelete(
  interaction,
  content
) {
  try {
    // Color rojo para errores, eliminaciones o borrados
    const isRed = content.includes("❌") || content.includes("ELIMINADO") || content.includes("BORRADO");
    // Color amarillo para comandos de configuración exitosos
    const isConfig = ["canal", "permisos", "timezone"].includes(interaction.commandName);
    const isPublic = interaction.commandName === "listar";

    let color = 0x00ae86; // Verde (éxito por defecto)
    if (isRed) color = 0xff0000;
    else if (isConfig) color = 0xffcc00;
    
    const embed = new EmbedBuilder()
      .setDescription(content)
      .setColor(color); 

    // Si la interacción ya fue diferida o respondida, usamos editReply
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [embed] });
    } else {
      // Aunque deferReply ya se encarga de esto, lo mantenemos por si acaso
      // se llama replyAndDelete sin un defer previo (ej. en un error no capturado antes).
      await interaction.reply({ embeds: [embed], ephemeral: !isPublic });
    }
    // Borrar mensaje solo si es efímero (no para /listar)
    if (!isPublic) {
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
  const CLEANUP_THRESHOLD = 14 * 24 * 60 * 60; // 14 días en segundos
  
  // Limpiar automáticamente eventos antiguos de la DB
  await EventModel.deleteMany({ guildId, timestamp: { $lt: ahora - CLEANUP_THRESHOLD } });

  let eventos = await EventModel.find({ guildId }).sort({ timestamp: 1 });

  const embed = new EmbedBuilder()
    .setTitle("📢 PRÓXIMOS EVENTOS")
    .setColor(0x0099ff); // Color azul para la barra lateral

  let description = "";

  if (eventos.length === 0) {
    description = "> 😴 **No hay eventos cargados.**\n" +
                  "-# Proba con el comando **/agregar** para cargar el primer evento.\n";
  } else {
    const offset = settings.timezone;
    const offsetMs = offset * 60 * 60 * 1000;
    const NOMBRES_DIAS = ["DOMINGO", "LUNES", "MARTES", "MIÉRCOLES", "JUEVES", "VIERNES", "SÁBADO"];
    const ORDEN_DIAS = ["LUNES", "MARTES", "MIÉRCOLES", "JUEVES", "VIERNES", "SÁBADO", "DOMINGO"];

    const gruposPorDia = {};

    // Agrupar eventos por día de la semana
    for (const e of eventos) {
      const fecha = new Date(e.timestamp * 1000);
      const fechaEnTZ = new Date(fecha.getTime() + offsetMs);
      const diaNombre = NOMBRES_DIAS[fechaEnTZ.getUTCDay()];

      if (!gruposPorDia[diaNombre]) {
        gruposPorDia[diaNombre] = [];
      }
      gruposPorDia[diaNombre].push(e);
    }

    const fields = [];

    const formatearEvento = (e) => {
      const fecha = new Date(e.timestamp * 1000);
      const fechaEnTZ = new Date(fecha.getTime() + offsetMs);
      const hora = `${String(fechaEnTZ.getUTCHours()).padStart(2, "0")}:${String(fechaEnTZ.getUTCMinutes()).padStart(2, "0")}`;
      const expirado = ahora > e.timestamp;
      const texto = `**${e.nombre}**: ${hora} (<t:${e.timestamp}:R>)\n> -# ↪ [#${e.id}]`;
      return expirado ? `~~${texto}~~` : texto;
    };

    // Recorrer los días en el orden correcto (Lunes a Domingo)
    for (const dia of ORDEN_DIAS) {
      if (gruposPorDia[dia] && gruposPorDia[dia].length > 0) {
        const eventosDia = gruposPorDia[dia];

        const mitad = Math.ceil(eventosDia.length / 2);
        const col1 = eventosDia.slice(0, mitad).map(formatearEvento).join("\n");
        const col2 = eventosDia.slice(mitad).map(formatearEvento).join("\n");

        fields.push(
          { name: `📅 ${dia}`, value: "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬", inline: false },
          { name: "\u200B", value: col1 || "\u200B", inline: true },
          { name: "\u200B", value: col2 || "\u200B", inline: true }
        );
      }
    }

    embed.addFields(fields);
  }

  if (settings.additionalText) {
    description += `\n${settings.additionalText}`;
  }

  description += `\n-# 🔄 Última actualización: <t:${ahora}:R>`;

  embed.setDescription(description);
  embed.setFooter({ text: "Podes aportar a la lista usando el comando /agregar" });

  try {
    let msg = settings.messageId
      ? await channel.messages.fetch(settings.messageId).catch(() => null)
      : null;

    if (msg) await msg.delete().catch(() => {});

    const newMsg = await channel.send({ embeds: [embed] });
    settings.messageId = newMsg.id;
    await settings.save();
    console.log(`Mensaje recreado para guild=${guildId} messageId=${newMsg.id}`);
  } catch (err) {
    console.error("Error actualizarMensaje:", err);
  }
}

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildVoiceStates, 
    GatewayIntentBits.GuildMembers
  ],
});

client.once(Events.ClientReady, () => {
  console.log(`Conectado como ${client.user.tag}`);
});

// ================= ACTUALIZACIÓN PERIÓDICA =================
const DEFAULT_UPDATE_INTERVAL = 28800; // CADA 8 hs se actualiza el mensaje (en segundos).

function startAutoUpdate(client) {
  const secs = Math.max(
    10,
    Number(process.env.UPDATE_INTERVAL_SECONDS) || DEFAULT_UPDATE_INTERVAL,
  );
  const ms = secs * 1000;

  console.log(`Iniciando actualización periódica de horarios cada ${secs} segundos.`);

  setInterval(async () => {
    try {
      const allSettings = await Settings.find({ channelId: { $exists: true } });
      for (const s of allSettings) {
        await actualizarMensaje(client, s.guildId);
      }
    } catch (err) {
      console.error("Error en actualización periódica:", err);
    }
  }, ms);
}

client.on(Events.ClientReady, () => {
  startAutoUpdate(client);
});

// ================= INTERACCIONES (UN SOLO HANDLER) =================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ================= BUTTONS =================
    if (interaction.isButton()) {
      if (interaction.customId === "confirm_reset") {
        await interaction.deferUpdate();

        await EventModel.deleteMany({ guildId: interaction.guild.id });
        const settings = await getSettings(interaction.guild.id);
        settings.additionalText = undefined;
        await settings.save();
        await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

        const embed = new EmbedBuilder()
          .setDescription("✅ HORARIOS RESETEADOS")
          .setColor(0xff0000); // Rojo para indicar que se borró todo
        await interaction.editReply({ content: null, embeds: [embed], components: [], ephemeral: true });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
        return;
      }

      if (interaction.customId === "cancel_reset") {
        const embed = new EmbedBuilder()
          .setDescription("❌ CANCELADO")
          .setColor(0xff0000);
        await interaction.update({ content: null, embeds: [embed], components: [], ephemeral: true });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
        return;
      }

      return;
    }

    // ================= COMMAND =================
    const cmd = interaction.commandName;

    // Diferimos la respuesta inmediatamente para evitar el timeout de 3 segundos
    // Si es el comando 'listar', lo hacemos público (ephemeral: false)
    if (interaction.isChatInputCommand()) {
      const isPublic = cmd === "listar";
      await interaction.deferReply({ ephemeral: !isPublic });
    }

    const adminOnly = ["permisos", "canal"];
    const roleProtected = [
      "timezone",
      "agregar",
      "editar",
      "eliminar",
      "resetear",
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
      return await replyAndDelete(interaction, `✅ Canal configurado: <#${canal.id}>`);
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
      const isDifferentChannel = targetChannelId && interaction.channelId !== targetChannelId;
      
      const embed = new EmbedBuilder()
        .setDescription("¿ESTÁS SEGURO? •⚠️")
        .setColor(0xffcc00); // Color amarillo para advertencia
      await interaction.editReply({ embeds: [embed], components: [row], ephemeral: true });
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

        const currentTzDate = new Date(Date.UTC(nowTz.year, nowTz.month, nowTz.day));
        const currentDayIndex = currentTzDate.getUTCDay();
        let daysToAdd = (targetIndex - currentDayIndex + 7) % 7;

        timestamp = tzTimestampFromComponents(year, month, day + daysToAdd, h, m, offset);

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
        nombre,
        timestamp,
        userId: interaction.user.id
      });

      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

      const infoHorario = fechaTexto
        ? `${horario} (${fechaTexto})`
        : diaInput
        ? `${horario} (${diaInput})`
        : horario;
      return await replyAndDelete(
        interaction,
        `✅ Evento (#${id}) • **${nombre}** • **${infoHorario}** • **AGREGADO**`,
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

      const result = await EventModel.deleteOne({ guildId: interaction.guild.id, id });

      if (result.deletedCount === 0) {
        return await replyAndDelete(interaction, `❌ No existe evento #${id}`);
      }

      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

      return await replyAndDelete(
        interaction,
        `✅ EVENTO #${id} **ELIMINADO**`,
      );
    }
    // ================= /TIMEZONE =================
    if (cmd === "timezone") {
      const tz = interaction.options.getInteger("offset");

      if (!Number.isInteger(tz) || tz < -12 || tz > 14) {
        return await replyAndDelete(
          interaction,
          "❌ Zona inválida (-12 a +14). Ej: -3, 0, +1",
        );
      }

      const settings = await getSettings(interaction.guild.id);
      settings.timezone = tz;
      await settings.save();
      return await replyAndDelete(
        interaction,
        `🌍 Timezone: UTC ${tz >= 0 ? "+" : ""}${tz}`,
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

      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);
      return await replyAndDelete(interaction, "✅ Mensaje de horarios **ACTUALIZADO**.");
    }

    // ================= /CONFIGURACION =================
    if (cmd === "configuracion") {
      const settings = await getSettings(interaction.guild.id);
      const embed = new EmbedBuilder()
        .setTitle("⚙️ Configuración Actual")
        .setColor(0x00ae86)
        .addFields(
          { name: "Canal de Eventos", value: settings.channelId ? `<#${settings.channelId}>` : "No configurado", inline: true },
          { name: "Timezone (UTC)", value: `${settings.timezone >= 0 ? "+" : ""}${settings.timezone}`, inline: true },
          { name: "Rol con Permisos", value: settings.roleId ? `<@&${settings.roleId}>` : "Todos (propietario/admin)", inline: true },
          { name: "Mensaje Adicional", value: settings.additionalText || "Ninguno" }
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
      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

      return await replyAndDelete(
        interaction,
        texto ? `✅ Mensaje **AGREGADO**.` : `✅ Mensaje **BORRADO**.`,
      );
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

      const evento = await EventModel.findOne({ guildId: interaction.guild.id, id });

      if (!evento) {
        return await replyAndDelete(interaction, "❌ NO EXISTE");
      }

      const oldName = evento.nombre;
      let changedName = false;
      let changedTime = false;
      let changedDate = false;

      if (nombre && nombre !== oldName) {
        evento.nombre = nombre;
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
      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

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

      if (changedName) details.push(`Nuevo nombre: **${evento.nombre}**`);
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
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member);
      const voiceChannel = member?.voice?.channel;

      if (!voiceChannel) {
        return await replyAndDelete(interaction, "❌ No estás en un canal de voz.");
      }

      const members = Array.from(voiceChannel.members.values());

      if (!members.length) {
        return await replyAndDelete(interaction, "❌ No hay usuarios en tu canal de voz.");
      }

      const lines = members.map((m) => {
        const name = m.nickname || (m.user && m.user.globalName) || m.user.username;
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
