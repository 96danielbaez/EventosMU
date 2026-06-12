// deploy-commands.js
require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");
// CONFIGURACIÓN DEL BOT
const TOKEN = process.env.TOKEN; // TOKEN DEL BOT EN DISCORD, OBTENIDO EN EL PORTAL DE DESARROLLADORES
const CLIENT_ID = process.env.CLIENT_ID; // ID DE LA APLICACIÓN DEL BOT, OBTENIDO EN EL PORTAL DE DESARROLLADORES
const GUILD_ID = process.env.GUILD_ID; // ID DEL SERVIDOR DONDE SE REGISTRARÁN LOS COMANDOS, OBTENIDO ACTIVANDO EL MODO DESARROLLADOR EN DISCORD Y HACIENDO CLIC DERECHO SOBRE EL SERVIDOR

const commands = [
  // COMANDO PARA ELEGIR EL CANAL
  new SlashCommandBuilder()
    .setName("canal")
    .setDescription("Define el canal de eventos.")
    .setDMPermission(false)
    .addChannelOption((option) =>
      option.setName("canal").setDescription("Canal destino").setRequired(true),
    ),
  // COMANDO PARA RESETEAR TODOS LOS EVENTOS
  new SlashCommandBuilder()
    .setName("resetear")
    .setDescription("Borra todos los eventos con confirmación.")
    .setDMPermission(false),
  // COMANDO PARA AGREGAR EVENTOS
  new SlashCommandBuilder()
    .setName("agregar")
    .setDescription("Agregar evento.")
    .setDMPermission(false)
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
    )
    .addStringOption((option) =>
      option
        .setName("dia")
        .setDescription("Día de la semana (Lunes, Martes...).")
        .setRequired(false),
    ),
  // COMANDO PARA ELIMINAR EVENTOS INDIVIDUALES
  new SlashCommandBuilder()
    .setName("eliminar")
    .setDescription("Eliminar un evento")
    .setDMPermission(false)
    .addIntegerOption((option) =>
      option.setName("id").setDescription("ID del evento.").setRequired(true),
    ),
  // COMANDO PARA EDITAR EVENTOS
  new SlashCommandBuilder()
    .setName("editar")
    .setDescription("Editar un evento")
    .setDMPermission(false)
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
    .setDMPermission(false)
    .addRoleOption((option) =>
      option
        .setName("rol")
        .setDescription("Rol con permisos del bot.")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("timezone")
    .setDMPermission(false)
    .setDescription("Configura el huso horario del servidor.")
    .addStringOption((option) =>
      option
        .setName("zona")
        .setDescription("Busca tu ciudad o país para configurar el horario base del servidor.")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("mensaje")
    .setDMPermission(false)
    .setDescription("Agrega un mensaje debajo de PRÓXIMOS EVENTOS.")
    .addStringOption((option) =>
      option
        .setName("mensaje")
        .setDescription("Texto opcional que aparecerá debajo del título.")
        .setRequired(false),
    ),
  // COMANDO PARA LISTAR USUARIOS EN VOICE
  new SlashCommandBuilder()
    .setName("listar")
    .setDMPermission(false)
    .setDescription("Lista los usuarios conectados en tu canal de voz."),
  // COMANDO PARA VER LA CONFIGURACIÓN ACTUAL
  new SlashCommandBuilder()
    .setName("configuracion")
    .setDMPermission(false)
    .setDescription("Muestra la configuración guardada del bot en este servidor."),
  // COMANDO PARA ACTUALIZAR EL MENSAJE MANUALMENTE
  new SlashCommandBuilder()
    .setName("actualizar")
    .setDMPermission(false)
    .setDescription("Actualiza el mensaje de horarios en el canal designado."),
  // COMANDO PARA VER HORARIOS EN CUALQUIER CANAL
  new SlashCommandBuilder()
    .setName("horario")
    .setDMPermission(false)
    .setDescription("Publica la lista de horarios en este canal ajustada por país.")
    .addStringOption((option) =>
      option
        .setName("pais")
        .setDescription("Busca tu ciudad o país (ej: Buenos Aires, Madrid, Mexico...).")
        .setRequired(false)
        .setAutocomplete(true),
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
