// ═══════════════════════════════════════════════════════════════════════════
//  InfiniteTalk Bot — servicio independiente (fuera de omnitech-core-v1)
//
//  Bot de Telegram dedicado (@Avatarjavi_bot) que:
//   1. Recibe /avatar <nombre> + un vídeo del usuario hablando.
//   2. Extrae el audio del vídeo (ffmpeg).
//   3. Manda audio + imagen de referencia del avatar a la sesión de Colab
//      (InfiniteTalk vía Gradio).
//   4. Devuelve el vídeo generado por Telegram.
//
//  Usa long polling (no webhook) — no necesita URL pública propia, solo
//  salida a internet. Se despliega como un servicio Node persistente
//  (Render "Web Service" free, o cualquier máquina con Node 18+).
// ═══════════════════════════════════════════════════════════════════════════

import http from "node:http";
import { loadConfig, saveConfig, isAdmin, ensureAdmin } from "./config.mjs";
import { tgGetUpdates, tgSendMessage, tgSendVideo, tgDownloadFile } from "./telegram.mjs";
import {
  extractAudioFromVideo, runInfiniteTalkJob, MIN_INPUT_DURATION_SEC, MAX_INPUT_DURATION_SEC,
} from "./infiniteTalk.mjs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Falta la variable de entorno TELEGRAM_BOT_TOKEN. Copia .env.example a .env (en local) o configúrala en Render.");
  process.exit(1);
}

// ── Health check HTTP mínimo (Render "Web Service" necesita responder en $PORT) ──
const PORT = process.env.PORT ?? 3000;
http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("InfiniteTalk bot activo.\n");
}).listen(PORT, () => console.log(`[http] Health check escuchando en :${PORT}`));

// ═══════════════════════════════════════════════════════════════════════════
// Comandos deterministas
// ═══════════════════════════════════════════════════════════════════════════

async function handleCommand(config, chatId, text) {
  const chatIdStr = String(chatId);
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = (cmdRaw ?? "").toLowerCase();
  const arg = rest.join(" ").trim();

  if (cmd === "/start" || cmd === "/help") {
    await tgSendMessage(TOKEN, chatId,
      "🎬 InfiniteTalk Avatar — comandos:\n" +
      "/avatar <nombre> — elige avatar y manda tu vídeo a continuación\n" +
      "/infinitetalk_status — ver configuración actual\n" +
      "(admin) /infinitetalk_url <url_gradio>\n" +
      "(admin) /infinitetalk_avatar <nombre> <url_imagen>",
    );
    return config;
  }

  if (cmd === "/avatar") {
    const name = arg.toLowerCase();
    const available = Object.keys(config.avatars);

    if (!name) {
      await tgSendMessage(TOKEN, chatId, available.length
        ? `Uso: /avatar <nombre>. Avatares disponibles: ${available.join(", ")}.`
        : "No hay avatares configurados todavía. Un admin puede añadirlos con /infinitetalk_avatar <nombre> <url_de_imagen>.");
      return config;
    }
    if (!config.avatars[name]) {
      await tgSendMessage(TOKEN, chatId, available.length
        ? `No conozco el avatar "${name}". Avatares disponibles: ${available.join(", ")}.`
        : `No conozco el avatar "${name}" y todavía no hay ninguno configurado. Un admin puede añadirlo con /infinitetalk_avatar ${name} <url_de_imagen>.`);
      return config;
    }
    if (!config.gradioUrl) {
      await tgSendMessage(TOKEN, chatId, "⚠️ Todavía no hay ninguna sesión de Colab activa. Un admin debe configurarla con /infinitetalk_url <url>.");
      return config;
    }

    config.pendingByChat[chatIdStr] = name;
    await saveConfig(config);
    await tgSendMessage(TOKEN, chatId,
      `🎬 Avatar "${name}" seleccionado. Ahora mándame tu vídeo hablando como vídeo normal de Telegram ` +
      `(no como nota circular), entre ${MIN_INPUT_DURATION_SEC}s y ${MAX_INPUT_DURATION_SEC}s.`,
    );
    return config;
  }

  if (cmd === "/infinitetalk_status") {
    const available = Object.keys(config.avatars);
    await tgSendMessage(TOKEN, chatId,
      `Estado InfiniteTalk:\n` +
      `• URL de Gradio: ${config.gradioUrl ?? "(sin configurar)"}\n` +
      `• Avatares: ${available.length ? available.join(", ") : "(ninguno)"}\n` +
      `• Admins registrados: ${config.adminChatIds.length}`,
    );
    return config;
  }

  // ── A partir de aquí: comandos de administración ───────────────────────────
  config = await ensureAdmin(config, chatIdStr);
  if (!isAdmin(config, chatIdStr)) {
    await tgSendMessage(TOKEN, chatId, "⛔ Este comando es solo para administradores.");
    return config;
  }

  if (cmd === "/infinitetalk_url") {
    if (!arg || !/^https?:\/\//i.test(arg)) {
      await tgSendMessage(TOKEN, chatId, "Uso: /infinitetalk_url https://xxxxxxxx.gradio.live");
      return config;
    }
    config.gradioUrl = arg.replace(/\/$/, "");
    config.gradioUpdatedAt = new Date().toISOString();
    await saveConfig(config);
    await tgSendMessage(TOKEN, chatId, `✅ URL de Gradio actualizada:\n${config.gradioUrl}`);
    return config;
  }

  if (cmd === "/infinitetalk_avatar") {
    const [name, imageUrl] = arg.split(/\s+/);
    if (!name || !imageUrl || !/^https?:\/\//i.test(imageUrl)) {
      await tgSendMessage(TOKEN, chatId, "Uso: /infinitetalk_avatar <nombre> <url_de_imagen>");
      return config;
    }
    config.avatars[name.toLowerCase()] = { imageUrl };
    await saveConfig(config);
    await tgSendMessage(TOKEN, chatId, `✅ Avatar "${name.toLowerCase()}" guardado.`);
    return config;
  }

  return config;
}

// ═══════════════════════════════════════════════════════════════════════════
// Flujo de generación cuando llega un vídeo
// ═══════════════════════════════════════════════════════════════════════════

async function handleVideo(config, chatId, fileId) {
  const chatIdStr = String(chatId);
  const avatarName = config.pendingByChat[chatIdStr];
  if (!avatarName) return; // sin selección pendiente (/avatar) → se ignora en silencio

  const avatar = config.avatars[avatarName];
  if (!avatar || !config.gradioUrl) {
    await tgSendMessage(TOKEN, chatId, "⚠️ La configuración cambió mientras tanto. Vuelve a elegir avatar con /avatar <nombre>.");
    return;
  }

  // Consumir la sesión pendiente ya, para no procesar el mismo vídeo dos veces
  delete config.pendingByChat[chatIdStr];
  await saveConfig(config);

  await tgSendMessage(TOKEN, chatId,
    "📥 Vídeo recibido. Extrayendo audio y generando el avatar… con la GPU gratuita de Colab esto puede " +
    "tardar varios minutos. Te aviso en cuanto esté listo.",
  );

  try {
    const videoBuffer = await tgDownloadFile(TOKEN, fileId);

    const { audio, durationSec } = await extractAudioFromVideo(videoBuffer);
    console.log(`[InfiniteTalk] chat=${chatIdStr} avatar=${avatarName} duración=${durationSec.toFixed(1)}s`);

    if (durationSec > MAX_INPUT_DURATION_SEC) {
      await tgSendMessage(TOKEN, chatId, `⚠️ El vídeo dura ${durationSec.toFixed(0)}s — el máximo del prototipo es ${MAX_INPUT_DURATION_SEC}s. Manda un clip más corto.`);
      return;
    }
    if (durationSec < MIN_INPUT_DURATION_SEC) {
      await tgSendMessage(TOKEN, chatId, `⚠️ El vídeo es demasiado corto (${durationSec.toFixed(1)}s). Manda un clip de al menos ${MIN_INPUT_DURATION_SEC}s.`);
      return;
    }

    const resultVideo = await runInfiniteTalkJob({
      gradioUrl:      config.gradioUrl,
      avatarImageUrl: avatar.imageUrl,
      audioBuffer:    audio,
      prompt:         avatar.prompt,
    });

    const sent = await tgSendVideo(TOKEN, chatId, resultVideo, `✅ Avatar "${avatarName}" listo.`);
    if (!sent) {
      await tgSendMessage(TOKEN, chatId, "El vídeo se generó pero Telegram rechazó el envío (puede ser demasiado grande). Revisa los logs.");
    }
  } catch (err) {
    console.error("[InfiniteTalk] Error generando avatar:", err);
    await tgSendMessage(TOKEN, chatId, `❌ Hubo un error generando el vídeo: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Bucle principal de long polling
// ═══════════════════════════════════════════════════════════════════════════

async function mainLoop() {
  let config = await loadConfig();
  console.log("🎬 InfiniteTalk bot arrancado. Esperando mensajes de Telegram…");

  for (;;) {
    let updates;
    try {
      updates = await tgGetUpdates(TOKEN, config.lastUpdateId + 1, 30);
    } catch (err) {
      console.error("[mainLoop] Error en getUpdates, reintentando en 5s:", err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    for (const update of updates) {
      config.lastUpdateId = update.update_id;
      await saveConfig(config); // persistir el offset ya, para no reprocesar tras un reinicio

      const msg = update.message;
      if (!msg) continue;
      const chatId = msg.chat?.id;
      if (chatId == null) continue;

      try {
        if (msg.text?.trim().startsWith("/")) {
          config = await handleCommand(config, chatId, msg.text.trim());
          continue;
        }

        const videoFileId = msg.video?.file_id
          ?? (msg.document?.mime_type?.startsWith("video/") ? msg.document.file_id : undefined);
        if (videoFileId) {
          await handleVideo(config, chatId, videoFileId);
          config = await loadConfig(); // recargar por si handleVideo tocó pendingByChat
        }
      } catch (err) {
        console.error("[mainLoop] Error procesando update:", err);
      }
    }
  }
}

mainLoop().catch((err) => {
  console.error("💥 Error fatal en el bucle principal:", err);
  process.exit(1);
});
