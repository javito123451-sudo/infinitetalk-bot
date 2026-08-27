// ═══════════════════════════════════════════════════════════════════════════
//  Cliente Telegram mínimo — sin frameworks, solo fetch + long polling.
//
//  Usa long polling (getUpdates) en vez de un webhook: así el bot no necesita
//  una URL pública HTTPS propia ni gestionar secretos de webhook — solo
//  necesita salida a internet, que es justo lo que tiene un servicio en
//  Render (o cualquier máquina con Node y conexión).
// ═══════════════════════════════════════════════════════════════════════════

const TG = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

/** Long poll de hasta `timeoutSec` segundos. Devuelve el array de updates
 *  (puede estar vacío si no llegó nada en ese intervalo). */
export async function tgGetUpdates(token, offset, timeoutSec = 30) {
  const url = TG(token, "getUpdates") +
    `?timeout=${timeoutSec}&offset=${offset}&allowed_updates=${encodeURIComponent(JSON.stringify(["message"]))}`;
  const res = await fetch(url, { signal: AbortSignal.timeout((timeoutSec + 10) * 1000) });
  const body = await res.json();
  if (!body.ok) {
    throw new Error(`getUpdates falló: ${body.description ?? res.status}`);
  }
  return body.result ?? [];
}

export async function tgSendMessage(token, chatId, text) {
  try {
    const res = await fetch(TG(token, "sendMessage"), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text }),
    });
    const body = await res.json();
    if (!body.ok) {
      console.error(`[tgSendMessage] ❌ Telegram error ${body.error_code}: ${body.description} | chat_id=${chatId}`);
    }
    return body.ok === true;
  } catch (err) {
    console.error(`[tgSendMessage] ❌ fetch exception for chat_id=${chatId}:`, err);
    return false;
  }
}

export async function tgSendVideo(token, chatId, videoBuffer, caption) {
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption.slice(0, 1024));
    form.append("video", new Blob([new Uint8Array(videoBuffer)], { type: "video/mp4" }), "avatar.mp4");
    const res  = await fetch(TG(token, "sendVideo"), { method: "POST", body: form });
    const body = await res.json();
    if (!body.ok) {
      console.error(`[tgSendVideo] ❌ Telegram error ${body.error_code}: ${body.description} | chat_id=${chatId}`);
    }
    return body.ok === true;
  } catch (err) {
    console.error(`[tgSendVideo] ❌ fetch exception for chat_id=${chatId}:`, err);
    return false;
  }
}

export async function tgDownloadFile(token, fileId) {
  const fileRes  = await fetch(TG(token, `getFile?file_id=${encodeURIComponent(fileId)}`));
  const fileData = await fileRes.json();
  if (!fileData.ok || !fileData.result?.file_path) {
    throw new Error(`getFile falló para file_id=${fileId.slice(0, 20)}: ${fileData.description ?? "desconocido"}`);
  }
  const downloadUrl = `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`;
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Descarga de fichero falló: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
