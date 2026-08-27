// ═══════════════════════════════════════════════════════════════════════════
//  Configuración persistida en un fichero JSON local (config.json).
//
//  Este bot es un servicio independiente (no vive dentro de omnitech-core-v1),
//  así que no hay base de datos: toda la config (URL de Gradio activa,
//  avatares registrados, selecciones pendientes por chat, admins y el offset
//  de polling de Telegram) vive en un único fichero JSON junto al código.
//
//  Nota sobre Render: el disco de un "Web Service" gratuito NO es persistente
//  entre despliegues (sí lo es mientras la instancia sigue viva). Cada vez
//  que relances el notebook de Colab tendrás que volver a mandar
//  /infinitetalk_url de todos modos (la URL de Gradio es efímera), así que
//  esto no es una limitación real para este prototipo.
// ═══════════════════════════════════════════════════════════════════════════

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "config.json");

const DEFAULT_CONFIG = {
  gradioUrl:       null,
  gradioUpdatedAt: null,
  avatars:         {}, // { [name]: { imageUrl, prompt? } }
  pendingByChat:   {}, // { [chatId]: avatarName }
  adminChatIds:    [],
  lastUpdateId:    0,  // offset de Telegram getUpdates — evita reprocesar mensajes tras un reinicio
};

export async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config) {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

/** Bootstrap: si aún no hay admins, quien primero use un comando de
 *  configuración se registra automáticamente como admin. */
export function isAdmin(config, chatId) {
  return config.adminChatIds.length === 0 || config.adminChatIds.includes(String(chatId));
}

export async function ensureAdmin(config, chatId) {
  if (config.adminChatIds.length === 0) {
    config.adminChatIds = [String(chatId)];
    await saveConfig(config);
  }
  return config;
}
