const { EmbedBuilder } = require("discord.js");
const {
  tzComponentsFromTimestamp,
  formatTimeWithFlag,
  shouldHideExpiredEvent,
} = require("./helpers");

const DAY_NAMES = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];

function getDayKey(timestamp, offset) {
  const comp = tzComponentsFromTimestamp(timestamp, offset);
  return `${comp.year}-${String(comp.month + 1).padStart(2, "0")}-${String(comp.day).padStart(2, "0")}`;
}

function getDayNameFromKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return DAY_NAMES[utcDate.getUTCDay()].toUpperCase();
}

function buildEventText(evento, ahora, ianaZone, displayMode = "all") {
  const displayZone = ianaZone || "Europe/Madrid";
  const horaDisplay = formatTimeWithFlag(evento.timestamp, displayZone);
  const idPart = displayMode === "all" ? `[#${evento.id}] ` : "";
  const titulo = evento.nombre ? `**${idPart}${evento.nombre}**` : `**${idPart}Evento**`;
  const horarioTexto = `${horaDisplay} - **<t:${evento.timestamp}:t>**\n(<t:${evento.timestamp}:R>)`;
  const text = `${titulo}\n${horarioTexto}`;
  return ahora > evento.timestamp ? `~~${text}~~` : text;
}

function buildDayBlock(dayName, items, ahora, ianaZone, displayMode = "all") {
  const eventLines = items.map((evento) => buildEventText(evento, ahora, ianaZone, displayMode));
  const value = eventLines
    .map((line, index) => `${line}${index < eventLines.length - 1 ? "\n\n" : ""}`)
    .join("");

  return `**${dayName}**\n■■■■■■■■■■■■■■■■■■■${value ? `\n${value}` : ""}`;  
}

function agruparEventosPorDia(eventos, offset, ahora, displayMode) {
  const today = tzComponentsFromTimestamp(ahora, offset);
  const todayKey = `${today.year}-${String(today.month + 1).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
  const tomorrowDate = new Date(Date.UTC(today.year, today.month, today.day + 1));
  const tomorrowKey = `${tomorrowDate.getUTCFullYear()}-${String(tomorrowDate.getUTCMonth() + 1).padStart(2, "0")}-${String(tomorrowDate.getUTCDate()).padStart(2, "0")}`;

  const filtered = eventos.filter((evento) => {
    if (displayMode !== "today_tomorrow") return true;

    const key = getDayKey(evento.timestamp, offset);
    const isWithinRange = key === todayKey || key === tomorrowKey;
    if (!isWithinRange) return false;

    // Ocultar eventos que pasaron hace 2+ horas
    return !shouldHideExpiredEvent(evento, ahora);
  });

  const groups = new Map();

  for (const evento of filtered) {
    const key = getDayKey(evento.timestamp, offset);
    if (!groups.has(key)) {
      groups.set(key, { key, dayName: getDayNameFromKey(key), items: [] });
    }
    groups.get(key).items.push(evento);
  }

  return Array.from(groups.values()).sort((a, b) => {
    return a.items[0].timestamp - b.items[0].timestamp;
  });
}

function generarEmbedHorarios(
  eventos,
  offset,
  additionalText,
  ianaZone = null,
  embedColor = "#6c04f3",
  displayMode = "all",
) {
  const ahora = Math.floor(Date.now() / 1000);
  const groups = agruparEventosPorDia(eventos || [], offset, ahora, displayMode);

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle("BOSSES DE VICTUS");

  let description = "\n";
  if (additionalText) description += `${additionalText}\n\n`;

  if (groups.length === 0) {
    embed.setDescription(description + "\n-# ✅ **ACTUALIZADO:** <t:${ahora}:t>");
    return embed;
  }

  const fields = [];
  if (additionalText) {
    fields.push({ name: "\u200A", value: "\n", inline: false });
  }

  for (const group of groups) {
    const value = buildDayBlock(group.dayName, group.items, ahora, ianaZone, displayMode);
    fields.push({ name: "\u200B", value, inline: false });
  }

  fields.push({
    name: "\u200A",
    value: `-# ✅ **ACTUALIZADO:** <t:${ahora}:t>`,
  });

  embed.addFields(fields);
  embed.setDescription(description);
  return embed;
}

function generarContenidoHorarios(
  eventos,
  offset,
  additionalText,
  ianaZone = null,
  displayMode = "all",
) {
  const ahora = Math.floor(Date.now() / 1000);
  let out = additionalText ? `${additionalText}\n\n` : "";

  if (!eventos || eventos.length === 0) {
    return `${out}No hay eventos cargados\nÚltima actualización: <t:${ahora}:t>`;
  }

  const groups = agruparEventosPorDia(eventos, offset, ahora, displayMode);

  if (!groups.length) {
    return `${out}No hay eventos para hoy ni mañana\nÚltima actualización: <t:${ahora}:t>`;
  }

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (i > 0) out += "\n";
    out += `**${group.dayName}**\n`;

    for (const evento of group.items) {
      const horaDisplay = formatTimeWithFlag(evento.timestamp, ianaZone || "Europe/Madrid");
      const idPart = displayMode === "all" ? `${evento.id} ` : "";
      const titulo = evento.nombre ? `${idPart}${evento.nombre}` : `${idPart}Evento`;
      out += `${titulo}\n${horaDisplay} - <t:${evento.timestamp}:t> (<t:${evento.timestamp}:R>)\n\n`;
    }

    if (i < groups.length - 1) out += "\n";
  }

  return `${out}\nÚltima actualización: <t:${ahora}:t>`;
}

function generarEmbedProximo(evento, embedColor = "#6c04f3", ianaZone = "Europe/Madrid") {
  const embed = new EmbedBuilder().setColor(embedColor);

  if (!evento) {
    embed.setTitle("PRÓXIMO EVENTO");
    embed.setDescription("😴 **No hay eventos cargados**");
    return embed;
  }

  const horaDisplay = formatTimeWithFlag(evento.timestamp, ianaZone);
  embed.setTitle("PRÓXIMO EVENTO");
  embed.setDescription(
    `■■■■■■■■■■■■■■■■■■■\n\n**${evento.nombre}**\n**${horaDisplay}** (<t:${evento.timestamp}:R>)`,
  );
  return embed;
}

module.exports = {
  generarEmbedHorarios,
  generarContenidoHorarios,
  generarEmbedProximo,
};
