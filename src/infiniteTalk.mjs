// ═══════════════════════════════════════════════════════════════════════════
//  InfiniteTalk — extracción de audio + llamada a la interfaz Gradio de Colab
//
//  IMPORTANTE — pieza no verificada en vivo: el endpoint de Gradio que se usa
//  para generar el vídeo (`pickGenerateVideoEndpoint`) se dedujo leyendo el
//  app.py de MeiGen-AI/InfiniteTalk (rama main): la función `generate_video`
//  recibe 16 parámetros posicionales. `runInfiniteTalkJob` llama primero a
//  `client.view_api()` y lo loguea entero — revisa los logs la primera vez
//  que pruebes contra una sesión de Colab real; si el número de inputs no
//  coincide, ajusta `pickGenerateVideoEndpoint` con lo que veas ahí.
// ═══════════════════════════════════════════════════════════════════════════

import { Client, handle_file } from "@gradio/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
// @ts-ignore — ffprobe-static no publica tipos oficiales
import ffprobeStatic from "ffprobe-static";

const execFileAsync = promisify(execFile);

// ── Límites del prototipo (clips de 30s a 2 min como mucho) ──────────────────
export const MAX_INPUT_DURATION_SEC = 130;
export const MIN_INPUT_DURATION_SEC = 3;

const DEFAULT_PROMPT =
  "A person talking naturally to the camera, medium close-up shot, warm lighting.";
const DEFAULT_NEGATIVE_PROMPT =
  "bright tones, overexposed, static, blurred details, subtitles, style, works, " +
  "paintings, images, static, overall gray, worst quality, low quality, JPEG " +
  "compression residue, ugly, incomplete, extra fingers, poorly drawn hands, " +
  "poorly drawn faces, deformed, disfigured, misshapen limbs, fused fingers, " +
  "still picture, messy background, three legs, many people in the background, " +
  "walking backwards";
const DEFAULT_VOICE_1 = "weights/Kokoro-82M/voices/am_adam.pt";
const DEFAULT_VOICE_2 = "weights/Kokoro-82M/voices/af_heart.pt";

// ═══════════════════════════════════════════════════════════════════════════
// Audio: extracción + duración (ffmpeg/ffprobe estáticos, sin dependencias del SO)
// ═══════════════════════════════════════════════════════════════════════════

export async function extractAudioFromVideo(videoBuffer) {
  const dir = await mkdtemp(path.join(tmpdir(), "infinitetalk-"));
  const inputPath  = path.join(dir, "input.mp4");
  const outputPath = path.join(dir, "audio.wav");
  try {
    await writeFile(inputPath, videoBuffer);

    const probeBinPath = ffprobeStatic.path;
    const { stdout } = await execFileAsync(probeBinPath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    const durationSec = parseFloat(stdout.trim()) || 0;

    await execFileAsync(ffmpegPath, ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", outputPath]);

    const audio = await readFile(outputPath);
    return { audio, durationSec };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {/* best-effort */});
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Llamada al Gradio de InfiniteTalk (Colab)
// ═══════════════════════════════════════════════════════════════════════════

function pickGenerateVideoEndpoint(api) {
  const all = { ...(api.named_endpoints ?? {}), ...(api.unnamed_endpoints ?? {}) };
  for (const key of Object.keys(all)) {
    if (key.toLowerCase().includes("generate_video")) return key;
  }
  for (const [key, info] of Object.entries(all)) {
    if ((info.parameters?.length ?? -1) === 16) return key;
  }
  return null;
}

function extractFileUrl(out, baseUrl) {
  if (!out) return null;
  if (typeof out === "string") {
    return out.startsWith("http") ? out : `${baseUrl.replace(/\/$/, "")}/file=${out}`;
  }
  if (out.url) return out.url;
  if (out.path) return `${baseUrl.replace(/\/$/, "")}/file=${out.path}`;
  return null;
}

export async function runInfiniteTalkJob({ gradioUrl, avatarImageUrl, audioBuffer, prompt }) {
  console.log(`[InfiniteTalk] Conectando a Gradio: ${gradioUrl}`);
  const app = await Client.connect(gradioUrl);

  const api = await app.view_api();
  console.log(`[InfiniteTalk] view_api() → ${JSON.stringify(api).slice(0, 2000)}`);

  const endpoint = pickGenerateVideoEndpoint(api);
  if (!endpoint) {
    throw new Error(
      "No se encontró el endpoint de generación en la interfaz de Gradio. " +
      "Revisa los logs (view_api completo arriba) y ajusta pickGenerateVideoEndpoint en infiniteTalk.mjs.",
    );
  }
  console.log(`[InfiniteTalk] Usando endpoint: ${endpoint}`);

  const imageRes = await fetch(avatarImageUrl);
  if (!imageRes.ok) throw new Error(`No se pudo descargar la imagen de referencia del avatar: HTTP ${imageRes.status}`);
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

  // Orden exacto de `inputs=[...]` en el click handler de app.py:
  // img2vid_image, vid2vid_vid, task_mode, img2vid_prompt, n_prompt,
  // img2vid_audio_1, img2vid_audio_2, sd_steps, seed, text_guide_scale,
  // audio_guide_scale, mode_selector, tts_text, resolution_select,
  // human1_voice, human2_voice
  const args = [
    handle_file(imageBuffer),
    null,
    "SingleImageDriven",
    prompt ?? DEFAULT_PROMPT,
    DEFAULT_NEGATIVE_PROMPT,
    handle_file(audioBuffer),
    null,
    8,
    42,
    1,
    2,
    "Single Person(Local File)",
    "",
    "infinitetalk-480",
    DEFAULT_VOICE_1,
    DEFAULT_VOICE_2,
  ];

  console.log("[InfiniteTalk] Enviando job — puede tardar varios minutos en una T4 gratuita…");
  const result = await app.predict(endpoint, args);

  const out = Array.isArray(result.data) ? result.data[0] : result.data;
  const fileUrl = extractFileUrl(out, gradioUrl);
  if (!fileUrl) {
    throw new Error(`Gradio no devolvió un vídeo reconocible. Respuesta: ${JSON.stringify(result).slice(0, 1000)}`);
  }

  console.log(`[InfiniteTalk] Vídeo generado, descargando desde: ${fileUrl}`);
  const videoRes = await fetch(fileUrl);
  if (!videoRes.ok) throw new Error(`No se pudo descargar el vídeo generado: HTTP ${videoRes.status}`);
  return Buffer.from(await videoRes.arrayBuffer());
}
