require("dotenv").config();
const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");

const configFile = "canal.json";
const tzFile = "timezone.json";
const eventosFile = "eventos.json";
const msgFile = "mensaje.json";

// Validaciones de formatos
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/; // HH:mm
const DATE_RE = /^([0-2]\d|3[0-1])-(0[1-9]|1[0-2])$/; // DD-MM

// ⚙️ CONFIGURACIÓN GLOBAL
const REPLY_DELETE_DELAY = 10000; // Milisegundos antes de borrar respuestas efímeras

// ================= HELPER REPLY AUTO-DELETE =================
async function replyAndDelete(
  interaction,
  content,
  delayMs = REPLY_DELETE_DELAY,
) {
  try {
    const reply = await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
    });
    setTimeout(() => {
      reply.delete().catch(() => {});
    }, delayMs);
  } catch (err) {
    console.error("Error en replyAndDelete:", err);
  }
}

// ================= HELPERS =================
function safeRead(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file));
  } catch {
    return fallback;
  }
}

function safeWrite(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ================= CONFIG =================
function loadConfig() {
  return safeRead(configFile, {});
}
function saveConfig(data) {
  safeWrite(configFile, data);
}

// ================= TIMEZONE =================
function getTZ(guildId) {
  const tz = safeRead(tzFile, {});
  return tz[guildId] ?? -3;
}

// ================= PERMISOS =================
function loadPermisos() {
  return safeRead("permisos.json", {});
}

function tienePermiso(interaction) {
  const permisos = loadPermisos();
  const roleId = permisos[interaction.guild.id];
  if (!roleId) return true;
  return interaction.member.roles.cache.has(roleId);
}

// ================= MENSAJE =================
async function actualizarMensaje(client, guildId) {
  let eventos = safeRead(eventosFile, []);
  const config = loadConfig();

  const guildConfig = config[guildId];
  if (!guildConfig?.channelId) return;

  const channel = await client.channels.fetch(guildConfig.channelId);

  const ahora = Math.floor(Date.now() / 1000);

  eventos = eventos.filter((e) => ahora - e.timestamp < 3 * 60 * 60);
  safeWrite(eventosFile, eventos);

  let msgData = safeRead(msgFile, {});

  const buildMessage = () => {
    const guildMsgData = msgData[guildId];
    const additionalText = guildMsgData
      ? typeof guildMsgData === "object"
        ? guildMsgData.text
        : undefined
      : undefined;

    if (eventos.length === 0) {
      let mensaje = "## 📌 EVENTOS: BOSSES DIARIOS. \n\n";
      mensaje += "> 😴 **No hay eventos cargados, son puros dormilones.**\n";
      mensaje +=
        "-# Proba con el comando **/agregar** para cargar el primer evento.\n";
      if (additionalText) {
        mensaje += `${additionalText}\n\n`;
      }
      return mensaje;
    }

    eventos.sort((a, b) => a.timestamp - b.timestamp);

    let mensaje = "## 📌 EVENTOS: BOSSES DIARIOS. \n";
    const offset = getTZ(guildId);
    const offsetMs = offset * 60 * 60 * 1000;
    mensaje += `-# LISTADO EN: **HORA SERVER** (UTC ${offset >= 0 ? "+" : ""}${offset}).\n`;
    mensaje += "### BOSSES PRÓXIMOS\n\n";

    for (const e of eventos) {
      const fecha = new Date(e.timestamp * 1000);
      const fechaEnTZ = new Date(fecha.getTime() + offsetMs);
      const horas = String(fechaEnTZ.getUTCHours()).padStart(2, "0");
      const minutos = String(fechaEnTZ.getUTCMinutes()).padStart(2, "0");
      const hora = `${horas}:${minutos}`;
      const expirado = ahora > e.timestamp;
      const usuario = e.userId ? `<@${e.userId}>` : "Desconocido";
      mensaje += expirado
        ? `> ~~${e.nombre}: ${hora} - (<t:${e.timestamp}:R>) • *por* ${usuario} | [#${e.id}] ~~\n`
        : `> ${e.nombre}: ${hora} - **(<t:${e.timestamp}:R>)** • *por* ${usuario} | [#${e.id}]\n`;
    }
    if (additionalText) {
      mensaje += `\n${additionalText}\n`;
    }
    return mensaje;
  };

  const content = buildMessage();

  try {
    const guildMsgData = msgData[guildId];
    const currentMsgId = guildMsgData
      ? typeof guildMsgData === "object"
        ? guildMsgData.id
        : guildMsgData
      : null;

    let msg = currentMsgId
      ? await channel.messages.fetch(currentMsgId).catch(() => null)
      : null;

    if (msg) {
      await msg.edit(content);
    } else {
      // El mensaje fue borrado o no existe, crear uno nuevo
      msg = await channel.send(content);
      msgData[guildId] = {
        id: msg.id,
        text: typeof guildMsgData === "object" ? guildMsgData.text : undefined,
      };
      safeWrite(msgFile, msgData);
    }
  } catch (err) {
    console.error("Error actualizarMensaje:", err);
    // Intentar enviar un nuevo mensaje si hay error
    try {
      const msg = await channel.send(content);
      msgData[guildId] = {
        id: msg.id,
        text:
          typeof msgData[guildId] === "object"
            ? msgData[guildId].text
            : undefined,
      };
      safeWrite(msgFile, msgData);
    } catch (err2) {
      console.error("Error creando nuevo mensaje:", err2);
    }
  }
}

// ================= CLIENT =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("clientReady", () => {
  console.log(`Conectado como ${client.user.tag}`);
});

// ================= INTERACCIONES (UN SOLO HANDLER) =================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ================= BUTTONS =================
    if (interaction.isButton()) {
      if (interaction.customId === "confirm_reset") {
        await interaction.deferUpdate();

        safeWrite(eventosFile, []);

        const msgData = safeRead(msgFile, {});
        const existing = msgData[interaction.guild.id];
        if (existing) {
          msgData[interaction.guild.id] =
            typeof existing === "object"
              ? { ...existing, text: undefined }
              : { id: existing };
          safeWrite(msgFile, msgData);
        }

        await actualizarMensaje(interaction.client, interaction.guild.id);

        return interaction.editReply({
          content: "✅ HORARIOS RESETEADOS",
          components: [],
        });
      }

      if (interaction.customId === "cancel_reset") {
        return interaction.update({
          content: "❌ CANCELADO",
          components: [],
        });
      }

      return;
    }

    // ================= COMMAND =================
    const cmd = interaction.commandName;

    const adminOnly = ["permisos", "canal"];
    const roleProtected = [
      "timezone",
      "agregar",
      "editar",
      "eliminar",
      "resetear",
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
      if (!tienePermiso(interaction)) {
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

      const permisos = loadPermisos();
      permisos[interaction.guild.id] = rol.id;

      safeWrite("permisos.json", permisos);

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

      const config = loadConfig();
      config[interaction.guild.id] = { channelId: canal.id };
      saveConfig(config);

      return await replyAndDelete(interaction, "✅ CANAL CONFIGURADO");
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

      return interaction.reply({
        content: "¿ESTÁS SEGURO? •⚠️",
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ================= /AGREGAR =================
    if (cmd === "agregar") {
      const nombre = interaction.options.getString("nombre");
      const horario = interaction.options.getString("horario");
      const fechaTexto = interaction.options.getString("fecha");

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

      const config = loadConfig();
      const guildConfig = config[interaction.guild.id];
      if (!guildConfig?.channelId) {
        return await replyAndDelete(
          interaction,
          "❌ Primero define el canal de eventos con /canal antes de agregar un evento.",
        );
      }

      const offset = getTZ(interaction.guild.id);
      const offsetMs = offset * 60 * 60 * 1000;
      const [h, m] = horario.split(":").map(Number);

      // 📌 Hora actual en UTC y en TZ
      const now = new Date();
      const nowInTZ = new Date(now.getTime() + offsetMs);

      // 📌 Obtener fecha base
      let year = nowInTZ.getUTCFullYear();
      let month = nowInTZ.getUTCMonth();
      let day = nowInTZ.getUTCDate();

      // 📌 Si hay fecha → usarla
      if (fechaTexto) {
        const [dia, mes] = fechaTexto.split("-").map(Number);
        month = mes - 1;
        day = dia;
      }

      // 📌 Crear la fecha del evento EN TZ (con el horario ingresado)
      let fechaEnTZ = new Date(Date.UTC(year, month, day, h, m, 0, 0));

      // 📌 Si NO hay fecha y ya pasó → mañana
      if (!fechaTexto && fechaEnTZ <= nowInTZ) {
        fechaEnTZ.setUTCDate(fechaEnTZ.getUTCDate() + 1);
      }

      // 📌 Convertir a UTC (restar offset)
      const utc = new Date(fechaEnTZ.getTime() - offsetMs);
      const timestamp = Math.floor(utc.getTime() / 1000);

      let eventos = safeRead(eventosFile, []);
      const id = eventos.length ? Math.max(...eventos.map((e) => e.id)) + 1 : 1;

      eventos.push({ id, nombre, timestamp, userId: interaction.user.id });

      safeWrite(eventosFile, eventos);

      await actualizarMensaje(interaction.client, interaction.guild.id);

      return await replyAndDelete(
        interaction,
        `✅ Evento (#${id}) • **${nombre}** • **AGREGADO**`,
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

      let eventos = safeRead(eventosFile, []);

      const newList = eventos.filter((e) => e.id !== id);

      if (newList.length === eventos.length) {
        return await replyAndDelete(interaction, `❌ No existe evento #${id}`);
      }

      safeWrite(eventosFile, newList);

      await actualizarMensaje(interaction.client, interaction.guild.id);

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

      const data = safeRead(tzFile, {});

      data[interaction.guild.id] = tz;

      safeWrite(tzFile, data);

      return await replyAndDelete(
        interaction,
        `🌍 Zona horaria configurada en UTC ${tz >= 0 ? "+" : ""}${tz}`,
      );
    }
    // ================= /MENSAJE =================
    if (cmd === "mensaje") {
      const texto = interaction.options.getString("mensaje") || "";
      const msgData = safeRead(msgFile, {});
      const existing = msgData[interaction.guild.id];
      const currentId = existing
        ? typeof existing === "object"
          ? existing.id
          : existing
        : null;

      msgData[interaction.guild.id] = {
        id: currentId,
        text: texto || undefined,
      };
      safeWrite(msgFile, msgData);

      await actualizarMensaje(interaction.client, interaction.guild.id);

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

      let eventos = safeRead(eventosFile, []);

      const evento = eventos.find((e) => e.id === id);

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
        const offset = getTZ(interaction.guild.id);
        const offsetMs = offset * 60 * 60 * 1000;

        // Obtener fecha actual del evento en UTC y convertir a TZ
        const fechaEventoUTC = new Date(evento.timestamp * 1000);
        const fechaEnTZ = new Date(fechaEventoUTC.getTime() + offsetMs);

        // Valores base (si no se proporcionan nuevos)
        let year = fechaEnTZ.getUTCFullYear();
        let month = fechaEnTZ.getUTCMonth();
        let day = fechaEnTZ.getUTCDate();
        let hours = fechaEnTZ.getUTCHours();
        let minutes = fechaEnTZ.getUTCMinutes();

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

        // Crear nueva fecha en TZ con los valores finales
        const nuevaFechaEnTZ = new Date(
          Date.UTC(year, month, day, hours, minutes, 0, 0),
        );

        // Convertir a UTC y guardar
        const nuevoUTC = new Date(nuevaFechaEnTZ.getTime() - offsetMs);
        evento.timestamp = Math.floor(nuevoUTC.getTime() / 1000);
        changedDate = true;
      }

      safeWrite(eventosFile, eventos);

      await actualizarMensaje(interaction.client, interaction.guild.id);

      // Preparar mensaje de confirmación con detalles
      const details = [];
      const offset2 = getTZ(interaction.guild.id);
      const offsetMs2 = offset2 * 60 * 60 * 1000;
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
