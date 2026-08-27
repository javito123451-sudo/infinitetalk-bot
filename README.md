# InfiniteTalk Bot

Bot de Telegram independiente (no vive dentro de `omnitech-core-v1`) para el
prototipo de avatares hablando: **InfiniteTalk** (MeiGen-AI, open source) +
**Google Colab gratuito** + **Telegram** como interfaz.

No depende de base de datos, ni de Clerk, ni de ningún otro servicio de pago —
la configuración se guarda en un fichero `config.json` local.

## 1. Requisitos

- Node.js 18 o superior.
- El token del bot de Telegram (`@Avatarjavi_bot`, de BotFather).
- Una sesión de Google Colab corriendo el notebook
  [sruckh/InfiniteTalk-Google-Collab](https://github.com/sruckh/InfiniteTalk-Google-Collab)
  (eso te da la URL `https://xxxxxxxx.gradio.live`).

## 2. Instalación local

```bash
npm install
cp .env.example .env
# edita .env y pon tu TELEGRAM_BOT_TOKEN
npm start
```

Verás en consola `🎬 InfiniteTalk bot arrancado. Esperando mensajes de Telegram…`.

## 3. Desplegar en Render (gratis, como el resto de la infraestructura)

1. Crea un repo nuevo en GitHub con este contenido y súbelo.
2. En Render: **New → Web Service** → conecta ese repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: Free
3. En **Environment**, añade la variable `TELEGRAM_BOT_TOKEN` con el token de
   `@Avatarjavi_bot`. No hace falta configurar `PORT` — Render la inyecta sola
   y el bot solo la usa para el health check.
4. Despliega. El bot usa *long polling* (no webhook), así que no necesitas
   registrar ninguna URL en Telegram — en cuanto el servicio arranca, empieza
   a recibir mensajes.

> Nota: el plan free de Render puede dormir el servicio tras un rato de
> inactividad total (sin peticiones HTTP). El *health check* que expone este
> bot en `/` sirve para que un uptime-monitor externo (opcional) lo mantenga
> despierto si quieres usarlo con más frecuencia; para probarlo puntualmente
> no hace falta nada de eso.

## 4. Uso desde Telegram

1. Lanza el notebook de Colab (las 3 celdas) y copia la URL de Gradio.
2. En el chat con el bot:
   ```
   /infinitetalk_url https://xxxxxxxx.gradio.live
   ```
   (el primero que use un comando de configuración se registra automáticamente
   como admin — solo esa persona podrá cambiar la URL o los avatares después).
3. Registra un avatar (una vez, o cuando quieras añadir otro):
   ```
   /infinitetalk_avatar ava https://tu-imagen-de-ava.png
   ```
4. Genera un vídeo:
   ```
   /avatar ava
   ```
   y a continuación manda tu vídeo hablando **como vídeo normal** (no como
   nota de vídeo circular), de entre 3 y 130 segundos. El bot te avisa cuando
   empieza y te devuelve el resultado cuando termina (puede tardar varios
   minutos en la GPU T4 gratuita).
5. `/infinitetalk_status` en cualquier momento para ver la configuración
   actual (URL de Gradio, avatares registrados, número de admins).

## 5. Aviso sobre el endpoint de Gradio

`src/infiniteTalk.mjs` deduce automáticamente qué función de la interfaz
Gradio hay que llamar (`pickGenerateVideoEndpoint`), inspeccionando
`view_api()` en tiempo real y buscando el endpoint de generación de vídeo.
Esto se escribió leyendo el código actual de
[MeiGen-AI/InfiniteTalk](https://github.com/MeiGen-AI/InfiniteTalk) (rama
`main`), pero **no se ha podido probar contra una sesión de Colab real**
todavía. Si la primera prueba falla con un error de "no se encontró el
endpoint", revisa los logs del servicio — se imprime el `view_api()` completo
para poder ajustar la lógica en un minuto.

## 6. Límites del prototipo

- Vídeos de entrada: entre 3 y 130 segundos (configurable en
  `src/infiniteTalk.mjs`, constantes `MIN_INPUT_DURATION_SEC` /
  `MAX_INPUT_DURATION_SEC`).
- Un único proceso, sin cola — si dos personas piden un vídeo a la vez, se
  procesan uno detrás de otro (motivo de sobra: la GPU gratuita de Colab es
  compartida por una sola sesión).
- Sin base de datos: si el proceso se reinicia, se conserva `config.json`
  (avatares, URL de Gradio, admins), pero cualquier generación en curso en
  ese momento se pierde — habría que volver a mandar el vídeo.
