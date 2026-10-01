require("dotenv").config();
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

const {
  Settings,
  EventModel,
  getSettings,
  ensureDisplayModeMigration,
  getNextEventId,
} = require("./src/db");

const {
  TIME_RE,
  DATE_RE,
  TIMEZONES_LIST,
  IANA_TO_COUNTRY_CODE,
  replyAndDelete,
  tzTimestampFromComponents,
  tzComponentsFromTimestamp,
  getFlagEmoji,
  normalizeString,
  getOffsetHours,
  formatTimeWithFlag,
} = require("./src/helpers");

const {
  generarEmbedHorarios,
  generarEmbedProximo,
} = require("./src/embeds");

const BOT_TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ No se encontró el token del bot. Define DISCORD_TOKEN o TOKEN en .env");
  process.exit(1);
}

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// ================= CONTROL DE TEMPORIZADORES =================
const guildsTimeouts = new Map();

// ================= MENSAJE =================
async function actualizarMensaje(client, guildId, updaterId = null) {
  const settings = await getSettings(guildId);
  if (!settings.channelId) return false;

  let channel;
  try {
    channel = await client.channels.fetch(settings.channelId);
  } catch (error) {
    console.error(`No se pudo obtener el canal ${settings.channelId} para guild ${guildId}:`, error);
    settings.channelId = null;
    await settings.save().catch(() => {});
    return false;
  }

  if (updaterId) {
    settings.lastUpdatedBy = updaterId;
    await settings.save().catch(() => {});
  }

  const ahora = Math.floor(Date.now() / 1000);
  const offset = settings.timezone;
  const nowTz = tzComponentsFromTimestamp(ahora, offset);

  const inicioDelDiaTz = tzTimestampFromComponents(
    nowTz.year,
    nowTz.month,
    nowTz.day,
    0,
    0,
    offset,
  );

  try {
    const oldEvents = await EventModel.find({
      guildId,
      timestamp: { $lt: inicioDelDiaTz },
    });

    for (const ev of oldEvents) {
      if (ev.repeat === "daily") {
        while (ev.timestamp < inicioDelDiaTz) {
          ev.timestamp += 24 * 60 * 60;
        }
        await ev.save();
      } else if (ev.repeat === "weekly") {
        while (ev.timestamp < inicioDelDiaTz) {
          ev.timestamp += 7 * 24 * 60 * 60;
        }
        await ev.save();
      }
    }

    await EventModel.deleteMany({
      guildId,
      repeat: null,
      timestamp: { $lt: ahora - 2 * 60 * 60 },
    });
  } catch (e) {
    console.error("Error rotando eventos antiguos:", e);
  }

  const eventos = await EventModel.find({ guildId }).sort({ timestamp: 1 });

  let existingMessage = null;
  if (settings.messageId) {
    try {
      existingMessage = await channel.messages.fetch(settings.messageId);
      if (!existingMessage || existingMessage.author?.id !== client.user.id) {
        throw new Error("El mensaje principal no pertenece al bot.");
      }
    } catch (error) {
      console.warn(
        `Mensaje principal perdido para guild=${guildId}. Se recreará. messageId=${settings.messageId}`,
      );
      settings.messageId = null;
      await settings.save().catch(() => {});
      existingMessage = null;
    }
  }

  try {
    const embed = generarEmbedHorarios(
      eventos,
      settings.timezone,
      settings.additionalText,
      settings.ianaZone,
      settings.embedColor,
      settings.displayMode || "all",
    );

    if (existingMessage) {
      try {
        await existingMessage.edit({ embeds: [embed] });
        console.log(`Mensaje editado para guild=${guildId}. ID: ${existingMessage.id}`);
      } catch (editError) {
        const isMissingMessage =
          editError?.code === 10008 ||
          editError?.status === 404 ||
          /Unknown Message|Unknown Channel/i.test(String(editError?.message || ""));

        if (isMissingMessage) {
          console.warn(
            `Mensaje principal borrado al editar para guild=${guildId}. Se recreará. ID: ${settings.messageId}`,
          );
          settings.messageId = null;
          await settings.save().catch(() => {});

          const m = await channel.send({ embeds: [embed] });
          settings.messageId = m.id;
          await settings.save();
          console.log(`Nuevo mensaje creado para guild=${guildId}. ID: ${m.id}`);
        } else {
          throw editError;
        }
      }
    } else {
      const m = await channel.send({ embeds: [embed] });
      settings.messageId = m.id;
      await settings.save();
      console.log(`Nuevo mensaje creado para guild=${guildId}. ID: ${m.id}`);
    }

    if (guildsTimeouts.has(guildId)) {
      clearTimeout(guildsTimeouts.get(guildId));
    }

    const proximoEvento = eventos.find((e) => e.timestamp > ahora);
    const proximaMedianocheTz = tzTimestampFromComponents(
      nowTz.year,
      nowTz.month,
      nowTz.day + 1,
      0,
      0,
      offset,
    );

    const proximoUpdate = proximoEvento
      ? Math.min(proximoEvento.timestamp, proximaMedianocheTz)
      : proximaMedianocheTz;

    const delay = (proximoUpdate - ahora) * 1000 + 2000;
    const MAX_DELAY = 24 * 60 * 60 * 1000;
    const finalDelay = Math.max(0, Math.min(delay, MAX_DELAY));

    const timer = setTimeout(() => actualizarMensaje(client, guildId), finalDelay);
    guildsTimeouts.set(guildId, timer);
    return true;
  } catch (err) {
    console.error("Error actualizarMensaje:", err);
    return false;
  }
}

// ================= PERMISOS =================
async function tienePermiso(interaction) {
  const settings = await getSettings(interaction.guild.id);
  if (!settings.roleId) return true;
  return interaction.member.roles.cache.has(settings.roleId);
}

// ================= AUTOUPDATE =================
function startAutoUpdate(client) {
  console.log("Iniciando sistema de actualización automática por eventos...");

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

client.once(Events.ClientReady, () => {
  console.log(`Conectado como ${client.user.tag}`);
});

client.on(Events.ClientReady, () => {
  ensureDisplayModeMigration();
  startAutoUpdate(client);
});

// ================= INTERACCIONES =================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "timezone") {
        const focusedValue = normalizeString(interaction.options.getFocused());
        const filtered = TIMEZONES_LIST.filter(
          (tz) =>
            normalizeString(tz.name).includes(focusedValue) ||
            normalizeString(tz.value).includes(focusedValue),
        ).slice(0, 25);

        await interaction.respond(
          filtered.map((tz) => ({ name: tz.name, value: tz.value })),
        );
      }
      return;
    }

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
          .setColor(0xff0000);
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

    const cmd = interaction.commandName;

    if (interaction.isChatInputCommand()) {
      const isPublic = ["listar", "proximo"].includes(cmd);
      await interaction.deferReply({ ephemeral: !isPublic });
    }

    const adminOnly = ["permisos", "canal", "timezone", "resetear", "mostrar", "color"];
    const roleProtected = [
      "agregar",
      "editar",
      "eliminar",
      "actualizar",
      "configuracion",
    ];

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

    if (roleProtected.includes(cmd)) {
      if (!(await tienePermiso(interaction))) {
        return await replyAndDelete(
          interaction,
          "❌ No tenés permisos para usar este comando.",
        );
      }
    }

    if (cmd === "permisos") {
      const rol = interaction.options.getRole("rol");
      if (!rol) {
        return await replyAndDelete(interaction, "❌ Debés seleccionar un rol válido.");
      }

      const settings = await getSettings(interaction.guild.id);
      settings.roleId = rol.id;
      await settings.save();
      return await replyAndDelete(
        interaction,
        `✅ Rol autorizado: **${rol.name}**`,
      );
    }

    if (cmd === "canal") {
      const canal = interaction.options.getChannel("canal");
      if (!canal) {
        return await replyAndDelete(interaction, "❌ Canal inválido.");
      }

      const settings = await getSettings(interaction.guild.id);
      settings.channelId = canal.id;
      await settings.save();

      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

      return await replyAndDelete(
        interaction,
        `✅ Canal configurado: <#${canal.id}>`,
      );
    }

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

      const embed = new EmbedBuilder()
        .setDescription("¿ESTÁS SEGURO? •⚠️")
        .setColor(0xffcc00);
      await interaction.editReply({
        embeds: [embed],
        components: [row],
        ephemeral: true,
      });
      return setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
    }

    if (cmd === "agregar") {
      const nombre = interaction.options.getString("nombre");
      const horario = interaction.options.getString("horario");
      const fechaTexto = interaction.options.getString("fecha");
      const diaInput = interaction.options.getString("dia");
      const repetir = interaction.options.getBoolean("repetir");

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
      const nowSec = Math.floor(Date.now() / 1000);
      const nowTz = tzComponentsFromTimestamp(nowSec, offset);

      let year = nowTz.year;
      let month = nowTz.month;
      let day = nowTz.day;
      let timestamp;

      if (fechaTexto) {
        const [dia, mes] = fechaTexto.split("-").map(Number);
        const targetDate = new Date(Date.UTC(year, mes - 1, dia, h, m));
        timestamp = Math.floor(targetDate.getTime() / 1000);
      } else {
        timestamp = tzTimestampFromComponents(year, month, day, h, m, offset);
      }

      let repeatType = null;
      if (repetir) {
        repeatType = diaInput ? "weekly" : "daily";
      }

      const id = await getNextEventId(interaction.guild.id);
      const evento = new EventModel({
        guildId: interaction.guild.id,
        id,
        nombre: nombre.toUpperCase(),
        timestamp,
        repeat: repeatType,
        userId: interaction.user.id,
        username: interaction.user.username,
      });

      await evento.save();
      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

      return await replyAndDelete(
        interaction,
        `✅ Evento #${id} **AGREGADO**: **${nombre.toUpperCase()}**`,
      );
    }

    if (cmd === "eliminar") {
      const id = interaction.options.getInteger("id");

      if (!Number.isInteger(id) || id <= 0) {
        return await replyAndDelete(
          interaction,
          "❌ ID inválido. Debe ser un número entero positivo.",
        );
      }

      const result = await EventModel.deleteOne({
        guildId: interaction.guild.id,
        id,
      });

      if (result.deletedCount === 0) {
        return await replyAndDelete(interaction, `❌ No existe evento #${id}`);
      }

      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

      return await replyAndDelete(
        interaction,
        `✅ EVENTO #${id} **ELIMINADO**`,
      );
    }

    if (cmd === "timezone") {
      const ianaZoneInput = interaction.options.getString("zona");
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
      await settings.save();

      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

      const flag = getFlagEmoji(IANA_TO_COUNTRY_CODE[found.value]);
      return await replyAndDelete(
        interaction,
        `🌍 Configuración actualizada: **${found.name}** (UTC ${calculatedOffset >= 0 ? "+" : ""}${calculatedOffset}) ${flag}`,
      );
    }

    if (cmd === "color") {
      const colorInput = interaction.options.getString("color") || "";
      const normalized = colorInput.trim();
      const validHex = /^#([0-9A-Fa-f]{6})$/.test(normalized);

      if (!validHex) {
        return await replyAndDelete(
          interaction,
          "❌ El color debe tener formato hexadecimal como #6c04f3",
        );
      }

      const settings = await getSettings(interaction.guild.id);
      settings.embedColor = normalized;
      await settings.save();
      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

      return await replyAndDelete(
        interaction,
        `✅ Color del embed actualizado: **${normalized}**`,
      );
    }

    if (cmd === "mostrar") {
      const modo = interaction.options.getString("modo");
      const normalized = ["all", "today_tomorrow"].includes(modo) ? modo : "all";

      const settings = await getSettings(interaction.guild.id);
      settings.displayMode = normalized;
      await settings.save();

      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

      const label = normalized === "all" ? "Modo edición" : "Próximos";
      return await replyAndDelete(
        interaction,
        `✅ Modo de visualización: **${label}**`,
      );
    }

    if (cmd === "actualizar") {
      const settings = await getSettings(interaction.guild.id);
      if (!settings.channelId) {
        return await replyAndDelete(
          interaction,
          "❌ Primero define el canal de eventos con /canal.",
        );
      }

      try {
        const ok = await actualizarMensaje(
          interaction.client,
          interaction.guild.id,
          interaction.user.id,
        );

        if (!ok) {
          return await replyAndDelete(
            interaction,
            "❌ No pude actualizar el mensaje principal. Revisá el canal o los permisos del bot.",
          );
        }
      } catch (error) {
        console.error("Error al actualizar mensaje desde /actualizar:", error);
      }

      return await replyAndDelete(
        interaction,
        "✅ Mensaje de horarios **ACTUALIZADO**.",
      );
    }

    if (cmd === "configuracion") {
      const settings = await getSettings(interaction.guild.id);
      const zoneInfo = TIMEZONES_LIST.find(
        (tz) => tz.value === settings.ianaZone,
      );
      const flag = settings.ianaZone
        ? getFlagEmoji(IANA_TO_COUNTRY_CODE[settings.ianaZone])
        : "";
      const zoneDisplay = zoneInfo ? `${zoneInfo.name} ${flag}` : "Manual";

      const embed = new EmbedBuilder()
        .setTitle("⚙️ Configuración Actual")
        .setColor(settings.embedColor || "#6c04f3")
        .addFields(
          {
            name: "📍 Canal de Eventos",
            value: settings.channelId ? `<#${settings.channelId}>` : "No configurado",
            inline: true,
          },
          {
            name: "🌍 Zona Horaria",
            value: `${zoneDisplay} (UTC ${settings.timezone >= 0 ? "+" : ""}${settings.timezone})`,
            inline: true,
          },
          {
            name: "🛡️ Rol con Permisos",
            value: settings.roleId ? `<@&${settings.roleId}>` : "Todos (propietario/admin)",
            inline: true,
          },
          {
            name: "🎨 Color (Zona)",
            value: `**${settings.embedColor || "#6c04f3"}**`,
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

    if (cmd === "mensaje") {
      const texto = interaction.options.getString("mensaje") || "";

      const settings = await getSettings(interaction.guild.id);
      settings.additionalText = texto || undefined;
      await settings.save();
      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

      return await replyAndDelete(
        interaction,
        texto ? "✅ Mensaje **AGREGADO**." : "✅ Mensaje **BORRADO**.",
      );
    }

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
          .setColor(settings.embedColor || "#6c04f3")
          .setTitle("PRÓXIMO EVENTO")
          .setDescription("😴 **No hay próximos eventos cargados**");
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      const embed = generarEmbedProximo(evento, settings.embedColor, settings.ianaZone || "Europe/Madrid");
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (cmd === "editar") {
      const id = interaction.options.getInteger("id");
      const nombre = interaction.options.getString("nombre");
      const horario = interaction.options.getString("horario");
      const fechaTexto = interaction.options.getString("fecha");

      if (!Number.isInteger(id) || id <= 0) {
        return await replyAndDelete(
          interaction,
          "❌ ID inválido. Debe ser un número entero positivo.",
        );
      }

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

        const nowSec = Math.floor(Date.now() / 1000);
        const base = tzComponentsFromTimestamp(nowSec, offset);

        let year = base.year;
        let month = base.month;
        let day = base.day;
        let hours = base.hour;
        let minutes = base.minute;

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

        if (horario) {
          const [h, m] = horario.split(":").map(Number);
          hours = h;
          minutes = m;
        }

        evento.timestamp = tzTimestampFromComponents(
          year,
          month,
          day,
          hours,
          minutes,
          offset,
        );

        if (!fechaTexto) {
          const nowSec2 = Math.floor(Date.now() / 1000);
          if (evento.timestamp <= nowSec2) evento.timestamp += 24 * 60 * 60;
        }
        changedDate = true;
      }

      await evento.save();
      await actualizarMensaje(interaction.client, interaction.guild.id, interaction.user.id);

      const details = [];
      const settings = await getSettings(interaction.guild.id);
      const offsetMsg = settings.timezone;
      const offsetMs2 = offsetMsg * 60 * 60 * 1000;
      const newDate = new Date(evento.timestamp * 1000);
      const newDateInTZ = new Date(newDate.getTime() + offsetMs2);
      const dd = String(newDateInTZ.getUTCDate()).padStart(2, "0");
      const mm = String(newDateInTZ.getUTCMonth() + 1).padStart(2, "0");
      const yyyy = String(newDateInTZ.getUTCFullYear());
      const hh = String(newDateInTZ.getUTCHours()).padStart(2, "0");
      const min = String(newDateInTZ.getUTCMinutes()).padStart(2, "0");

      if (changedName)
        details.push(`Nuevo nombre: **${evento.nombre.toUpperCase()}**`);
      if (changedDate)
        details.push(`Nueva fecha: **${dd}/${mm}/${yyyy} ${hh}:${min}**`);
      else if (changedTime) details.push(`Nuevo horario: **${hh}:${min}**`);

      const base = `✅ Evento #${id} **EDITADO**`;
      const message = details.length
        ? `${base} — ${details.join(" | ")}`
        : base;

      return await replyAndDelete(interaction, message);
    }

    if (cmd === "listar") {
      const member = await interaction.guild.members
        .fetch(interaction.user.id)
        .catch(() => interaction.member);
      const voiceChannel = member?.voice?.channel;

      if (!voiceChannel) {
        return await replyAndDelete(interaction, "❌ No estás en un canal de voz.");
      }

      const members = Array.from(voiceChannel.members.values());

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

client.login(BOT_TOKEN.trim().replace(/^['"]|['"]$/g, ""));
