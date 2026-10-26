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
  getWeekdayNumberFromText,
  getNextWeeklyTimestamp,
} = require("./src/helpers");

const { generarEmbedHorarios, generarEmbedProximo } = require("./src/embeds");

const BOT_TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const GOOGLE_SHEETS_CSV_URL = process.env.GOOGLE_SHEETS_CSV_URL;

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

async function leerEventosDesdeHoja() {
  try {
    const response = await fetch(GOOGLE_SHEETS_CSV_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    let csv = await response.text();
    if (csv.startsWith("\uFEFF")) csv = csv.slice(1);

    const lines = csv
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length < 2) return [];

    const headers = parseCsvLine(lines[0]).map((header) =>
      normalizeText(header),
    );
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseCsvLine(lines[i]);
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index] ?? "";
      });
      rows.push(row);
    }

    return rows;
  } catch (error) {
    console.error("Error leyendo la hoja de Google Sheets:", error);
    return [];
  }
}

if (!BOT_TOKEN) {
  console.error(
    "❌ No se encontró el token del bot. Define DISCORD_TOKEN o TOKEN en .env",
  );
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const guildsTimeouts = new Map();

client.once(Events.ClientReady, async () => {
  console.log(`Conectado como ${client.user.tag}`);
  ensureDisplayModeMigration();
  startAutoUpdate(client);
});

async function actualizarMensaje(client, guildId, updaterId = null) {
  const settings = await getSettings(guildId);
  if (!settings.channelId) return false;

  let channel;
  try {
    channel = await client.channels.fetch(settings.channelId);
  } catch (error) {
    console.error(
      `No se pudo obtener el canal ${settings.channelId} para guild ${guildId}:`,
      error,
    );
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
    const visualMode =
      settings.displayMode === "all" ||
      settings.displayMode === "today_tomorrow"
        ? settings.displayMode
        : "today_tomorrow";

    const embed = generarEmbedHorarios(
      eventos,
      settings.timezone,
      settings.additionalText,
      settings.ianaZone,
      settings.embedColor,
      visualMode,
    );

    if (existingMessage) {
      try {
        await existingMessage.edit({ embeds: [embed] });
      } catch (editError) {
        const isMissingMessage =
          editError?.code === 10008 ||
          editError?.status === 404 ||
          /Unknown Message|Unknown Channel/i.test(
            String(editError?.message || ""),
          );

        if (isMissingMessage) {
          settings.messageId = null;
          await settings.save().catch(() => {});

          const m = await channel.send({ embeds: [embed] });
          settings.messageId = m.id;
          await settings.save();
        } else {
          throw editError;
        }
      }
    } else {
      const m = await channel.send({ embeds: [embed] });
      settings.messageId = m.id;
      await settings.save();
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

    const eventosEnGracia = eventos
      .filter((e) => e.timestamp <= ahora && e.timestamp + 2 * 60 * 60 > ahora)
      .map((e) => e.timestamp + 2 * 60 * 60);

    const refreshCandidates = [
      proximaMedianocheTz,
      ...(proximoEvento ? [proximoEvento.timestamp] : []),
      ...eventosEnGracia,
    ];

    const proximoUpdate = refreshCandidates.length
      ? Math.min(...refreshCandidates)
      : proximaMedianocheTz;

    const delay = (proximoUpdate - ahora) * 1000 + 2000;
    const MAX_DELAY = 24 * 60 * 60 * 1000;
    const finalDelay = Math.max(0, Math.min(delay, MAX_DELAY));

    const timer = setTimeout(
      () => actualizarMensaje(client, guildId),
      finalDelay,
    );
    guildsTimeouts.set(guildId, timer);
    return true;
  } catch (err) {
    console.error("Error actualizarMensaje:", err);
    return false;
  }
}

function startAutoUpdate(client) {
  console.log("Iniciando sistema de actualización automática por eventos...");

  Settings.find({ channelId: { $exists: true } })
    .then(async (allSettings) => {
      for (const s of allSettings) {
        try {
          await actualizarMensaje(client, s.guildId);
        } catch (err) {
          console.error(`Error inicializando guild ${s.guildId}:`, err);
        }
      }
    })
    .catch((err) =>
      console.error("Error cargando configuraciones iniciales:", err),
    );
}

async function tienePermiso(interaction) {
  const settings = await getSettings(interaction.guild.id);
  if (!settings.roleId) return true;
  return interaction.member.roles.cache.has(settings.roleId);
}

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

    const adminOnly = [
      "permisos",
      "canal",
      "timezone",
      "resetear",
      "mostrar",
      "color",
    ];
    const roleProtected = [
      "agregar",
      "editar",
      "eliminar",
      "actualizar",
      "configuracion",
      "importar",
      "mensaje",
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

    if (cmd === "importar") {
      const settings = await getSettings(interaction.guild.id);
      if (!settings.channelId) {
        return await replyAndDelete(
          interaction,
          "❌ Primero define el canal de eventos con /canal antes de importar.",
        );
      }

      try {
        const rows = await leerEventosDesdeHoja();
        if (!rows.length) {
          return await replyAndDelete(
            interaction,
            "❌ No encontré eventos en la hoja pública o la URL no está disponible.",
          );
        }

        const offset = settings.timezone;
        const nowSec = Math.floor(Date.now() / 1000);
        const nowTz = tzComponentsFromTimestamp(nowSec, offset);

        await EventModel.deleteMany({ guildId: interaction.guild.id });

        for (const row of rows) {
          const nombre = String(row.evento || "").trim();
          const horario = String(row.horario || "").trim();
          const dia = String(row.dia || "").trim();
          const repetirRaw = String(row.repetir || "").trim();
          const repetir = ["si", "yes", "true", "1", "s", "y"].includes(
            normalizeText(repetirRaw),
          );

          if (!nombre || !horario || !TIME_RE.test(horario)) continue;

          const [h, m] = horario.split(":").map(Number);
          const dayMap = {
            domingo: 0,
            lunes: 1,
            martes: 2,
            miercoles: 3,
            miércoles: 3,
            jueves: 4,
            viernes: 5,
            sabado: 6,
            sábado: 6,
          };

          let timestamp;
          let repeatType = null;

          if (dia) {
            const targetWeekday = dayMap[normalizeText(dia)];
            if (targetWeekday === undefined) continue;

            timestamp = getNextWeeklyTimestamp(
              targetWeekday,
              h,
              m,
              nowSec,
              offset,
            );
            if (repetir) repeatType = "weekly";
          } else {
            timestamp = tzTimestampFromComponents(
              nowTz.year,
              nowTz.month,
              nowTz.day,
              h,
              m,
              offset,
            );

            if (timestamp < nowSec && repetir) timestamp += 24 * 60 * 60;
            if (repetir) repeatType = "daily";
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
        }

        await actualizarMensaje(
          interaction.client,
          interaction.guild.id,
          interaction.user.id,
        );
        return await replyAndDelete(
          interaction,
          "✅ Eventos importados desde la hoja y cargados en MongoDB.",
        );
      } catch (error) {
        console.error("Error importando eventos desde la hoja:", error);
        return await replyAndDelete(
          interaction,
          "❌ No pude importar la hoja. Revisá la URL o el formato de las columnas.",
        );
      }
    }

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

    if (cmd === "canal") {
      const canal = interaction.options.getChannel("canal");
      if (!canal) {
        return await replyAndDelete(interaction, "❌ Canal inválido.");
      }

      const settings = await getSettings(interaction.guild.id);
      settings.channelId = canal.id;
      await settings.save();

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
        timestamp = tzTimestampFromComponents(year, mes - 1, dia, h, m, offset);
      } else if (diaInput) {
        const targetWeekday = getWeekdayNumberFromText(diaInput);
        if (targetWeekday === null) {
          return await replyAndDelete(
            interaction,
            "❌ Día inválido. Usá un día de la semana válido (Lunes, Martes, etc.).",
          );
        }

        timestamp = getNextWeeklyTimestamp(targetWeekday, h, m, nowSec, offset);
      } else {
        timestamp = tzTimestampFromComponents(year, month, day, h, m, offset);
        // Without an explicit date or weekday, /agregar means the next
        // occurrence of this time. If today's time has passed, use tomorrow.
        if (timestamp <= nowSec) timestamp += 24 * 60 * 60;
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
      await actualizarMensaje(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
      );

      return await replyAndDelete(
        interaction,
        `✅ Evento #${id} **AGREGADO**: **${nombre.toUpperCase()}**`,
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
      await actualizarMensaje(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
      );

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

      const embed = generarEmbedProximo(
        evento,
        settings.embedColor,
        settings.ianaZone || "Europe/Madrid",
      );
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

      if (nombre) evento.nombre = nombre.toUpperCase();
      if (horario || fechaTexto) {
        const settings = await getSettings(interaction.guild.id);
        const offset = settings.timezone;

        // Recuperar la fecha y hora actuales del evento.
        const fechaActual = tzComponentsFromTimestamp(evento.timestamp, offset);

        // Si no se especifica una fecha, conservar la del evento.
        const year = fechaActual.year;
        const month = fechaActual.month;
        const day = fechaActual.day;

        // Si no se especifica un horario, conservar el actual.
        const h = horario ? Number(horario.split(":")[0]) : fechaActual.hour;

        const m = horario ? Number(horario.split(":")[1]) : fechaActual.minute;

        let newTimestamp;

        if (fechaTexto) {
          const [dia, mes] = fechaTexto.split("-").map(Number);

          newTimestamp = tzTimestampFromComponents(
            year,
            mes - 1,
            dia,
            h,
            m,
            offset,
          );
        } else {
          newTimestamp = tzTimestampFromComponents(
            year,
            month,
            day,
            h,
            m,
            offset,
          );
        }

        evento.timestamp = newTimestamp;
      }

      await evento.save();
      await actualizarMensaje(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
      );

      return await replyAndDelete(interaction, `✅ EVENTO #${id} **EDITADO**`);
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

    if (cmd === "mostrar") {
      const modo = interaction.options.getString("modo");
      const normalized = ["all", "today_tomorrow"].includes(modo)
        ? modo
        : "all";

      const settings = await getSettings(interaction.guild.id);
      settings.displayMode = normalized;
      await settings.save();

      await actualizarMensaje(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
      );

      const label = normalized === "all" ? "Modo: edición" : "Modo: próximo";
      return await replyAndDelete(interaction, `✅ **${label}**`);
    }

    if (cmd === "timezone") {
  const zona = interaction.options.getString("zona");
  const manual = interaction.options.getNumber("manual");

  // Debe elegirse exactamente una opción.
  if ((zona && manual !== null) || (!zona && manual === null)) {
    return await replyAndDelete(
      interaction,
      "❌ Elegí una sola opción: zona de la lista o desplazamiento manual."
    );
  }

  const settings = await getSettings(interaction.guild.id);

  if (manual !== null) {
    if (!Number.isFinite(manual) || manual < -12 || manual > 14) {
      return await replyAndDelete(
        interaction,
        "❌ El desplazamiento debe estar entre UTC-12 y UTC+14."
      );
    }

    settings.timezone = manual;
    settings.ianaZone = null;

    await settings.save();
    await actualizarMensaje(
      interaction.client,
      interaction.guild.id,
      interaction.user.id
    );

    const signo = manual >= 0 ? "+" : "";
    return await replyAndDelete(
      interaction,
      `✅ Zona horaria manual configurada: UTC${signo}${manual}.`
    );
  }

  const found = TIMEZONES_LIST.find(
    (tz) => tz.value === zona
  );

  if (!found) {
    return await replyAndDelete(
      interaction,
      "❌ Seleccioná una zona horaria válida de la lista."
    );
  }

  settings.timezone = getOffsetHours(found.value);
  settings.ianaZone = found.value;

  await settings.save();
  await actualizarMensaje(
    interaction.client,
    interaction.guild.id,
    interaction.user.id
  );

  return await replyAndDelete(
    interaction,
    `✅ Zona horaria configurada: ${found.name}.`
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
      await actualizarMensaje(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
      );

      return await replyAndDelete(
        interaction,
        `✅ Color del embed actualizado: **${normalized}**`,
      );
    }
    // COMANDO /listar
    if (cmd === "listar") {
      const guild = interaction.guild;
      const member = interaction.member;

      // Comprobar si quien ejecuta el comando está en un canal de voz
      const voiceChannel = member.voice.channel;

      if (!voiceChannel) {
        return await replyAndDelete(
          interaction,
          "❌ Tenés que estar conectado a un canal de voz para listar los participantes.",
        );
      }

      // Obtener los usuarios conectados a ese canal
      const users = [...voiceChannel.members.values()].filter(
        (member) => !member.user.bot,
      );

      if (!users.length) {
        return await replyAndDelete(
          interaction,
          "❌ No hay usuarios en el canal de voz.",
        );
      }

      // Mezclar los usuarios aleatoriamente
      for (let i = users.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [users[i], users[j]] = [users[j], users[i]];
      }

      const list = users.map((member) => member.displayName).join("\n");

      return await interaction.editReply({
        content:
          "## Participantes para el sorteo.\n" +
          `\`\`\`\n${list}\n\`\`\`\n` +
          "-# No olvides de estar conectado al **Discord**.\n",
      });
    }
  } catch (error) {
    console.error("Error en InteractionCreate:", error);
  }
});

client.login(BOT_TOKEN).catch((err) => {
  console.error("Error al iniciar el bot:", err);
  process.exit(1);
});
