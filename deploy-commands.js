// deploy-commands.js
require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");
// CONFIGURACIÓN DEL BOT
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const commands = [
  // COMANDO PARA ELEGIR EL CANAL
  new SlashCommandBuilder()
    .setName("canal")
    .setDescription("Define el canal de eventos.")
    .addChannelOption((option) =>
      option.setName("canal").setDescription("Canal destino").setRequired(true),
    ),
  // COMANDO PARA RESETEAR TODOS LOS EVENTOS
  new SlashCommandBuilder()
    .setName("resetear")
    .setDescription("Borra todos los eventos con confirmación."),
  // COMANDO PARA AGREGAR EVENTOS
  new SlashCommandBuilder()
    .setName("agregar")
    .setDescription("Agregar evento.")
    .addStringOption((option) =>
      option
        .setName("nombre")
        .setDescription("Nombre del evento.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("horario")
        .setDescription("Formato 24hs (HH:mm).")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("fecha")
        .setDescription("Formato DD-MM.")
        .setRequired(false),
    ),
  // COMANDO PARA ELIMINAR EVENTOS INDIVIDUALES
  new SlashCommandBuilder()
    .setName("eliminar")
    .setDescription("Eliminar un evento")
    .addIntegerOption((option) =>
      option.setName("id").setDescription("ID del evento.").setRequired(true),
    ),
  // COMANDO PARA EDITAR EVENTOS
  new SlashCommandBuilder()
    .setName("editar")
    .setDescription("Editar un evento")
    .addIntegerOption((option) =>
      option.setName("id").setDescription("ID del evento.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("nombre")
        .setDescription("Nuevo nombre.")
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("horario")
        .setDescription("Nuevo horario HH:mm.")
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("fecha")
        .setDescription("Nueva fecha DD-MM.")
        .setRequired(false),
    ),
  // COMANDO PARA DEFINIR PERMISOS
  new SlashCommandBuilder()
    .setName("permisos")
    .setDescription("Define qué rol puede usar el bot.")
    .addRoleOption((option) =>
      option
        .setName("rol")
        .setDescription("Rol con permisos del bot.")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("timezone")
    .setDescription("Configura el huso horario del servidor.")
    .addIntegerOption((option) =>
      option
        .setName("offset")
        .setDescription("Ej: -3 Argentina, 0 UTC, -5, +1.")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("mensaje")
    .setDescription("Agrega un mensaje debajo de PRÓXIMOS EVENTOS.")
    .addStringOption((option) =>
      option
        .setName("mensaje")
        .setDescription("Texto opcional que aparecerá debajo del título.")
        .setRequired(false),
    ),
].map((command) => command.toJSON());
// REGISTRAR LOS COMANDOS EN DISCORD
const rest = new REST({ version: "10" }).setToken(TOKEN);
// EJECUTAR EL REGISTRO DE LOS COMANDOS
(async () => {
  try {
    console.log("Registrando comandos...");

    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });

    console.log("Comandos registrados.");
  } catch (error) {
    console.error(error);
  }
})();
