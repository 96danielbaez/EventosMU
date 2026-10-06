const { EmbedBuilder } = require("discord.js");

const TIME_RE = /^([0-9]|0[0-9]|1[0-9]|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^([0-2]\d|3[0-1])-(0[1-9]|1[0-2])$/;

const TIMEZONES_LIST = [
  { name: "Argentina (Buenos Aires)", value: "America/Argentina/Buenos_Aires" },
  { name: "Bolivia (La Paz)", value: "America/La_Paz" },
  { name: "Brasil (São Paulo)", value: "America/Sao_Paulo" },
  { name: "Chile (Santiago)", value: "America/Santiago" },
  { name: "Colombia (Bogotá)", value: "America/Bogota" },
  { name: "Costa Rica", value: "America/Costa_Rica" },
  { name: "Ecuador (Guayaquil)", value: "America/Guayaquil" },
  { name: "España (Madrid)", value: "Europe/Madrid" },
  { name: "España (Islas Canarias)", value: "Atlantic/Canary" },
  { name: "México (CDMX)", value: "America/Mexico_City" },
  { name: "México (Tijuana)", value: "America/Tijuana" },
  { name: "Paraguay (Asunción)", value: "America/Asuncion" },
  { name: "Perú (Lima)", value: "America/Lima" },
  { name: "Uruguay (Montevideo)", value: "America/Montevideo" },
  { name: "Venezuela (Caracas)", value: "America/Caracas" },
  { name: "USA (New York - Este)", value: "America/New_York" },
  { name: "USA (Los Angeles - Oeste)", value: "America/Los_Angeles" },
];

const IANA_TO_COUNTRY_CODE = {
  "America/Argentina/Buenos_Aires": "AR",
  "America/La_Paz": "BO",
  "America/Sao_Paulo": "BR",
  "America/Santiago": "CL",
  "America/Bogota": "CO",
  "America/Costa_Rica": "CR",
  "America/Guayaquil": "EC",
  "Europe/Madrid": "ES",
  "Atlantic/Canary": "ES",
  "America/Mexico_City": "MX",
  "America/Tijuana": "MX",
  "America/Asuncion": "PY",
  "America/Lima": "PE",
  "America/Montevideo": "UY",
  "America/Caracas": "VE",
  "America/New_York": "US",
  "America/Los_Angeles": "US",
};

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

const EVENT_HIDE_AFTER_SECONDS = 2 * 60 * 60;

function getWeekdayNumberFromText(dayText) {
  if (dayText == null) return null;

  const normalized = normalizeString(String(dayText).trim());
  for (const [name, value] of Object.entries(WEEKDAYS)) {
    if (normalizeString(name) === normalized) return value;
  }

  return null;
}

function getNextWeeklyTimestamp(targetWeekday, hour, minute, nowSec, offset) {
  if (targetWeekday == null) return null;

  const nowTz = tzComponentsFromTimestamp(nowSec, offset);

  const currentWeekday = new Date(
    Date.UTC(nowTz.year, nowTz.month, nowTz.day),
  ).getUTCDay();

  let daysToAdd = (targetWeekday - currentWeekday + 7) % 7;
  const sameDayCandidate = tzTimestampFromComponents(
    nowTz.year,
    nowTz.month,
    nowTz.day,
    hour,
    minute,
    offset,
  );

  if (daysToAdd === 0 && sameDayCandidate <= nowSec) daysToAdd = 7;

  return tzTimestampFromComponents(
    nowTz.year,
    nowTz.month,
    nowTz.day + daysToAdd,
    hour,
    minute,
    offset,
  );
}

async function replyAndDelete(interaction, content) {
  try {
    const isRed =
      content.includes("❌") ||
      content.includes("ELIMINADO") ||
      content.includes("BORRADO");
    const isConfig = ["canal", "permisos", "timezone", "color"].includes(
      interaction.commandName || "",
    );
    const isPublic = ["listar", "proximo"].includes(
      interaction.commandName || "",
    );

    let color = 0x00ae86;
    if (isRed) color = 0xff0000;
    else if (isConfig) color = 0xffcc00;

    const embed = new EmbedBuilder().setDescription(content).setColor(color);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [embed] });
    } else {
      await interaction.reply({ embeds: [embed], ephemeral: !isPublic });
    }

    if (!isPublic || isRed) {
      setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
    }
  } catch (err) {
    console.error("Error en replyAndDelete:", err);
  }
}

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

function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return "";
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 0x1f1e6 + (char.charCodeAt(0) - "A".charCodeAt(0)));
  return String.fromCodePoint(...codePoints);
}

function normalizeString(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function getOffsetHours(ianaZone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: ianaZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const values = {};
    for (const part of parts) {
      if (part.type !== "literal") values[part.type] = part.value;
    }

    const wallClockMs = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );

    const utcNowMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
    );

    return Math.round((wallClockMs - utcNowMs) / (60 * 60 * 1000));
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

function shouldHideExpiredEvent(
  evento,
  nowSec = Math.floor(Date.now() / 1000),
  graceSeconds = EVENT_HIDE_AFTER_SECONDS,
) {
  if (!evento || evento.timestamp == null) return false;
  if (evento.timestamp > nowSec) return false;
  return nowSec - evento.timestamp >= graceSeconds;
}

function shouldDeleteExpiredEvent(
  evento,
  nowSec = Math.floor(Date.now() / 1000),
  graceSeconds = EVENT_HIDE_AFTER_SECONDS,
) {
  if (!evento || evento.timestamp == null) return false;
  if (evento.repeat) return false;
  return shouldHideExpiredEvent(evento, nowSec, graceSeconds);
}

function formatTimeWithFlag(timestampSec, ianaZone = "Europe/Madrid") {
  const zone = ianaZone || "Europe/Madrid";
  const countryCode = IANA_TO_COUNTRY_CODE[zone];
  const flag = getFlagEmoji(countryCode);
  const hora = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestampSec * 1000));

  return `${flag ? `${flag}\u00A0\u00A0` : ""}${hora}`;
}

module.exports = {
  TIME_RE,
  DATE_RE,
  WEEKDAYS,
  TIMEZONES_LIST,
  IANA_TO_COUNTRY_CODE,
  EVENT_HIDE_AFTER_SECONDS,
  getWeekdayNumberFromText,
  getNextWeeklyTimestamp,
  replyAndDelete,
  tzTimestampFromComponents,
  tzComponentsFromTimestamp,
  getFlagEmoji,
  normalizeString,
  getOffsetHours,
  formatTiempoRestante,
  shouldHideExpiredEvent,
  shouldDeleteExpiredEvent,
  formatTimeWithFlag,
};
