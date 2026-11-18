// Discord RPC — Kino TV plugin v1.0.13
// Muestra en Discord lo que se está viendo en Kino (de cualquier plugin) con el
// Gateway de Discord por WebSocket.
// Protocolo basado en Kizzy (github.com/dead8309/Kizzy), adaptado a QuickJS/Kino.

// ── Constantes del protocolo Discord Gateway ──────────────────────────────────
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_PRESENCE = 3;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;
const APP_ID = "1570998800338915448";
const PLUGIN_VERSION = "1.0.13"; // debe coincidir con kino-plugin.json

// Kino sólo ejecuta este código mientras dura una de sus llamadas (y cierra el
// sandbox tras 5 minutos sin llamadas), así que no hay nada vivo entre llamadas:
// cada llamada hace su handshake, su heartbeat y su presencia, y volvemos a
// conectar en la siguiente. Por eso cada llamada tiene su propio presupuesto.
const TRACK_BUDGET_MS = 8500;    // track tiene 10 s
const PLAYER_BUDGET_MS = 4000;   // playerEvent tiene 5 s
const PANEL_BUDGET_MS = 15000;   // panel y panelAction tienen 20 s
const ACTION_BUDGET_MS = 25000;  // action tiene 30 s
const FRAME_WAIT_MS = 1500;      // trozo de espera de cada recv

// Discord cierra la sesión del Gateway si no hay latido: con ninguna llamada en
// curso, el estado dura ~60 s. El estado personalizado (REST) sí persiste, y se
// renueva en cada evento y se vence solo si Kino deja de avisar.
const CUSTOM_STATUS_TTL_MS = 6 * 60000;
const CUSTOM_STATUS_API = "https://discord.com/api/v9/users/@me/settings";

const MANUAL_HINT =
  "Para vincular a mano: abre Discord web → F12 → Consola → pega " +
  "window.webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c]);" +
  "window.token=m.find(m=>m?.exports?.default?.getToken).exports.default.getToken()}]); " +
  "y copia aquí el resultado de window.token.";

// Cada vez que Kino carga el plugin (instalación, actualización o primer uso
// tras reiniciar el sandbox) queda esta línea en el log: así se sabe qué
// versión está corriendo de verdad en el aparato.
try {
  kino.log(
    `discord-rpc: plugin v${PLUGIN_VERSION} cargado` +
      ` (apiVersion ${kino.apiVersion || "?"}, Kino ${kino.appVersion || "?"})`
  );
} catch (_) {}

// ── Estado del socket ─────────────────────────────────────────────────────────
// Vive mientras viva el sandbox: es una caché del socket abierto, nada más.
let ws = null;               // socket del Gateway o null
let sequence = 0;            // último "s" recibido
let connected = false;       // READY recibido en este socket
let heartbeatMs = 41250;     // cadencia que pide HELLO
let nextHeartbeatAt = 0;     // próximo heartbeat (0 = todavía sin HELLO)
let awaitingAck = false;     // heartbeat enviado sin ACK

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMs(ms) {
  if (!ms || ms <= 0) return "0:00";
  const totalS = Math.floor(ms / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function clip(text, max) {
  const s = String(text == null ? "" : text);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

async function getToken() {
  let token = "";
  try {
    token = String(kino.config.get("discord_token") || "");
  } catch (_) {
    token = "";
  }
  if (!token) {
    // Copia de seguridad: si el ajuste no llega, sirve la guardada al vincular.
    try { token = String(kino.storage.get("token_backup") || ""); } catch (_) {}
  }
  // Al pegar, es fácil arrastrar comillas o espacios
  return token.replace(/^[\s"']+/, "").replace(/[\s"']+$/, "");
}

function isValidToken(t) {
  // Token de usuario de Discord: Base64(userId).timestamp.hmac
  return typeof t === "string" && t.length >= 60 &&
    /^[A-Za-z0-9+/_-]{20,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{20,}$/.test(t);
}

function persistStatus() {
  try {
    return kino.config.get("persist_status") !== false;
  } catch (_) {
    return true;
  }
}

function rememberEvent(type) {
  try {
    kino.storage.set("last_event", String(type || "?"));
    kino.storage.set("last_event_at", String(Date.now()));
  } catch (_) {}
}

function showButton() {
  try {
    return kino.config.get("show_button") !== "none";
  } catch (_) {
    return true;
  }
}

// Cuándo se envió el último estado, para que el panel diga la verdad.
function rememberSync(atMs) {
  try { kino.storage.set("last_sync", String(atMs || 0)); } catch (_) {}
}

function lastSyncAge() {
  try {
    const t = Number(kino.storage.get("last_sync") || 0);
    return t > 0 ? Date.now() - t : -1;
  } catch (_) {
    return -1;
  }
}

function formatAge(ms, en) {
  if (ms < 60000) return en ? "less than a minute ago" : "hace menos de un minuto";
  const min = Math.round(ms / 60000);
  return en ? `${min} min ago` : `hace ${min} min`;
}

// ── Discord Gateway WebSocket ─────────────────────────────────────────────────

// Los frames de kino.ws son bytes: se piden en base64 y Kino los convierte.
async function wsSend(payload) {
  const socket = ws;
  if (!socket) return false;
  try {
    const frame = kino.crypto.convert(JSON.stringify(payload), "utf8", "base64");
    await socket.send(frame, { encoding: "base64" });
    return true;
  } catch (e) {
    kino.log("discord-rpc: no se pudo enviar", e && (e.code || e.message));
    return false;
  }
}

async function identify(token) {
  return wsSend({
    op: OP_IDENTIFY,
    d: {
      token,
      capabilities: 65,
      compress: false,
      large_threshold: 100,
      properties: { os: "Windows", browser: "Discord Client", device: "ktor" },
    },
  });
}

function resetSocketState() {
  connected = false;
  sequence = 0;
  heartbeatMs = 41250;
  nextHeartbeatAt = 0;
  awaitingAck = false;
}

async function closeSocket() {
  const socket = ws;
  ws = null;
  resetSocketState();
  if (socket) { try { await socket.close(); } catch (_) {} }
}

// Lee frames del Gateway y los atiende hasta READY o hasta que se acabe el
// presupuesto de la llamada. Devuelve true cuando la sesión está lista.
async function pump(socket, deadline, token) {
  let identifyTries = 0;

  while (ws === socket && Date.now() < deadline) {
    if (nextHeartbeatAt && Date.now() >= nextHeartbeatAt) {
      if (awaitingAck) {
        // Discord cierra la sesión si un heartbeat queda sin ACK
        kino.log("discord-rpc: heartbeat sin ACK, reconectando");
        return false;
      }
      awaitingAck = true;
      if (!(await wsSend({ op: OP_HEARTBEAT, d: sequence || null }))) return false;
      nextHeartbeatAt = Date.now() + heartbeatMs;
    }

    const waitMs = Math.min(FRAME_WAIT_MS, Math.max(1, deadline - Date.now()));

    let frame;
    try {
      frame = await socket.recv(waitMs, { encoding: "base64" });
    } catch (e) {
      if (e && e.code === "timeout") continue;
      kino.log("discord-rpc: recv", e && (e.code || e.message));
      return false;
    }
    // null = no llegó nada en el plazo: la conexión sigue viva
    if (frame === null) {
      if (connected) return true;
      continue;
    }
    if (ws !== socket) return false;

    let p;
    try {
      p = JSON.parse(kino.crypto.convert(frame, "base64", "utf8"));
    } catch (_) {
      continue;
    }
    if (typeof p.s === "number") sequence = p.s;

    if (p.op === OP_HELLO) {
      heartbeatMs = (p.d && p.d.heartbeat_interval) || 41250;
      awaitingAck = false;
      nextHeartbeatAt = Date.now() + heartbeatMs;
      await identify(token);
    } else if (p.op === OP_HEARTBEAT_ACK) {
      awaitingAck = false;
    } else if (p.op === 0 && p.t === "READY") {
      connected = true;
      return true;
    } else if (p.op === OP_INVALID_SESSION) {
      connected = false;
      if (identifyTries++ >= 1) return false; // dos intentos y fuera
      await kino.sleep(1200);
      if (Date.now() >= deadline) return false;
      await identify(token);
    } else if (p.op === OP_RECONNECT) {
      kino.log("discord-rpc: Discord pidió reconectar");
      return false;
    }
  }

  return connected;
}

async function ensureConnected(deadline) {
  const token = await getToken();
  if (!isValidToken(token)) return false;

  if (connected && ws) return true;
  if (ws) await closeSocket();

  if (!kino.ws) {
    kino.log("discord-rpc: kino.ws no existe (falta el permiso de «socket»)");
    return false;
  }

  let socket;
  try {
    socket = await kino.ws.open(GATEWAY_URL);
  } catch (e) {
    kino.log("discord-rpc: no se pudo abrir el Gateway", e && (e.code || e.message));
    return false;
  }

  ws = socket;
  resetSocketState();

  const ok = await pump(socket, deadline, token);
  if (!ok) {
    kino.log("discord-rpc: el Gateway no llegó a READY");
    await closeSocket();
  }
  return ok;
}

function presencePayload(activity) {
  return {
    op: OP_PRESENCE,
    d: {
      since: 0,
      afk: false,
      status: "online",
      activities: activity ? [activity] : [],
    },
  };
}

// Late si toca: una llamada nueva es la única oportunidad de latir.
async function maybeHeartbeat() {
  if (!connected || !ws || !nextHeartbeatAt) return true;
  if (Date.now() < nextHeartbeatAt) return true;
  awaitingAck = true;
  if (!(await wsSend({ op: OP_HEARTBEAT, d: sequence || null }))) return false;
  nextHeartbeatAt = Date.now() + heartbeatMs;
  return true;
}

async function sendPresence(activity, budgetMs) {
  const deadline = Date.now() + (budgetMs || TRACK_BUDGET_MS);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await ensureConnected(deadline))) return false;
    if (!(await maybeHeartbeat())) {
      await closeSocket();
      continue;
    }
    if (await wsSend(presencePayload(activity))) return true;
    // El socket pudo morir mientras el sandbox estaba dormido: reconectamos.
    await closeSocket();
    if (Date.now() + 1000 >= deadline) return false;
  }
  return false;
}

async function clearPresence() {
  const deadline = Date.now() + 4000;
  if (await ensureConnected(deadline)) {
    try { await wsSend(presencePayload(null)); } catch (_) {}
  }
  await closeSocket();
}

// ── Estado personalizado (REST: persiste sin conexión) ───────────────────────

async function patchCustomStatus(token, custom) {
  try {
    const r = await kino.fetch(CUSTOM_STATUS_API, {
      method: "PATCH",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ custom_status: custom }),
      timeoutMs: 10000,
    });
    if (!r.ok) kino.log("discord-rpc: estado personalizado", r.status);
    return r.ok;
  } catch (e) {
    kino.log("discord-rpc: estado personalizado falló", e && (e.code || e.message));
    return false;
  }
}

function customFor(text, expiresAtMs) {
  return {
    text: clip(text, 128),
    emoji_name: null,
    expires_at: new Date(expiresAtMs).toISOString().replace("Z", "+00:00"),
  };
}

function customStatusText(context, paused) {
  const isEpisode = context.kind === "episode";
  const what = isEpisode
    ? `${context.title || "Kino TV"}${context.season ? ` T${context.season}` : ""}${context.episode ? `E${context.episode}` : ""}`
    : (context.title || "Kino TV");
  return `${paused ? "⏸ Pausado:" : "▶ Viendo"} ${what}`;
}

// Guarda el estado personalizado de la persona una sola vez por reproducción.
async function rememberCustomStatus(token) {
  try {
    if (kino.storage.get("custom_saved")) return;
  } catch (_) {
    return;
  }
  let prev = null;
  try {
    const r = await kino.fetch(CUSTOM_STATUS_API, {
      headers: { Authorization: token },
      timeoutMs: 10000,
    });
    if (r.ok) {
      const s = r.json();
      if (s && s.custom_status) prev = s.custom_status;
      // Un estado nuestro que quedó colgado no es «el suyo»
      const text = prev && typeof prev.text === "string" ? prev.text : "";
      if (/^[▶⏸] (Viendo|Pausado|Probando)/.test(text)) prev = null;
    }
  } catch (_) {}
  try {
    kino.storage.set("custom_prev", JSON.stringify(prev));
    kino.storage.set("custom_saved", "1");
  } catch (_) {}
}

async function restoreCustomStatus(token) {
  let saved = null;
  let had = false;
  try {
    had = Boolean(kino.storage.get("custom_saved"));
    if (had) saved = JSON.parse(kino.storage.get("custom_prev") || "null");
  } catch (_) {
    saved = null;
  }
  try {
    kino.storage.remove("custom_saved");
    kino.storage.remove("custom_prev");
  } catch (_) {}
  if (!had) return;
  if (saved) {
    await patchCustomStatus(token, {
      text: saved.text || "",
      emoji_name: saved.emoji_name || null,
      expires_at: saved.expires_at || null,
    });
  } else {
    await patchCustomStatus(token, null);
  }
}

// ── Actividad ─────────────────────────────────────────────────────────────────

function buildActivity(context, paused) {
  const isEpisode = context.kind === "episode";

  const details = isEpisode
    ? clip(`${context.title || "Kino TV"}${context.season ? ` — T${context.season}` : ""}`, 128)
    : clip(context.title || "Kino TV", 128);

  const state = isEpisode && context.episodeTitle
    ? clip(`E${context.episode} · ${context.episodeTitle}`, 128)
    : paused ? "⏸ Pausado" : "▶ Reproduciendo";

  const now = Date.now();
  const startS = Math.floor((now - (context.positionMs || 0)) / 1000);
  const endS = context.durationMs
    ? Math.floor((now - (context.positionMs || 0) + context.durationMs) / 1000)
    : null;

  const activity = {
    name: "Kino TV",
    type: 3, // WATCHING
    application_id: APP_ID,
    details,
    state,
    assets: {
      large_image: "kino_logo",
      large_text: "Kino TV",
    },
  };

  if (!paused && endS) activity.timestamps = { start: startS, end: endS };

  if (showButton()) {
    activity.buttons = [{ label: "Instalar Kino", url: "https://kinotvapp.github.io" }];
  }

  return activity;
}

// ── Exports requeridos ────────────────────────────────────────────────────────

export async function search() { return []; }
export async function resolve() {
  throw kino.error("not_found", "discord-rpc", {
    userMessage: "Este plugin no reproduce contenido propio.",
  });
}

// ── Action de settings: vincular cuenta ──────────────────────────────────────

export async function action(key) {
  if (key === "test_status") {
    const token = await getToken();
    if (!isValidToken(token)) {
      return { message: "Primero vincula tu cuenta de Discord aquí arriba." };
    }
    const ok = await sendPresence(
      buildActivity({ kind: "movie", title: "Prueba de estado", positionMs: 0, durationMs: 0 }, false),
      ACTION_BUDGET_MS
    );
    rememberSync(ok ? Date.now() : 0);
    // Además, un estado personalizado de 2 minutos: eso se ve al instante en
    // tu nombre, aunque el rich presence dure menos.
    const custom = await patchCustomStatus(
      token,
      customFor("▶ Probando Kino TV", Date.now() + 120000)
    );
    kino.log(`discord-rpc v${PLUGIN_VERSION}: prueba de estado · presencia ${ok ? "enviada" : "NO"} · estado personalizado ${custom ? "puesto" : "NO"}`);
    if (!ok) {
      return { message: "No se pudo conectar con Discord. Revisa internet y reintenta." };
    }
    return {
      message: custom
        ? "Enviado ✓ Mira tu perfil: «Kino TV» y «▶ Probando Kino TV» (2 min)."
        : "Presencia enviada ✓ No se pudo poner el estado personalizado.",
    };
  }

  if (key === "link_account") {
    // Kino sin la ventana web (o un escritorio): instrucciones manuales
    if (!kino.visualBrowser || !kino.visualBrowser.available) {
      return { message: MANUAL_HINT };
    }

    let result;
    try {
      // Discord guarda el token en localStorage["token"] (con comillas incluidas).
      result = await kino.visualBrowser.open({
        url: "https://discord.com/login",
        title: "Inicia sesión en Discord",
        doneWhen: { localStorage: ["token"] },
        collect: { localStorage: ["token"] },
        userAgent: "browser",
        timeoutMs: 300000,
      });
    } catch (e) {
      return {
        message: "No se pudo abrir la ventana de Discord (" +
          (e && e.code ? e.code : "error") + "). " + MANUAL_HINT,
      };
    }

    if (!result || result.status !== "done") {
      return { message: "Vinculación cancelada." };
    }

    // Kino viejo ignora collect.localStorage y no trae el campo
    if (!result.localStorage) {
      return { message: "Este Kino no puede leer el almacenamiento del sitio. Actualiza la app." };
    }

    // Discord guarda el token con comillas: '"MTEx...' → quitar comillas
    const raw = result.localStorage["token"];
    const token = raw ? String(raw).replace(/^"|"$/g, "").trim() : "";

    if (!token) {
      return { message: "Sesión iniciada pero Discord no guardó el token. Intenta de nuevo." };
    }
    if (!isValidToken(token)) {
      return { message: "El token encontrado no tiene el formato de Discord. Intenta de nuevo." };
    }
    if (!(await checkToken(token))) {
      return { message: "Discord rechazó ese token. Inicia sesión de nuevo." };
    }

    // Copia de seguridad por si el ajuste no llega a las llamadas del player
    try { kino.storage.set("token_backup", token); } catch (_) {}

    // kino.config es de sólo lectura: el token se guarda con setSettings
    return {
      message: "Cuenta de Discord vinculada ✓",
      setSettings: { discord_token: token },
    };
  }

  if (key === "unlink_account") {
    await closeSocket();
    rememberSync(0);
    try { kino.storage.remove("token_backup"); } catch (_) {}
    return { message: "Cuenta desvinculada.", clearSettings: ["discord_token"] };
  }

  return null;
}

// Comprueba el token contra la API de Discord (sólo un 401/403 lo invalida).
async function checkToken(token) {
  try {
    const r = await kino.fetch("https://discord.com/api/v9/users/@me", {
      headers: { Authorization: token },
      timeoutMs: 10000,
    });
    if (r.status === 401 || r.status === 403) return false;
    if (r.ok) {
      const me = r.json();
      if (me && me.username) kino.log("discord-rpc: cuenta de", me.username);
    }
    return true;
  } catch (_) {
    // Sin red o host bloqueado: no se descarta un token que parece válido
    return true;
  }
}

// ── Ajustes: línea de estado ─────────────────────────────────────────────────

export async function settingsStatus() {
  const version = `v${PLUGIN_VERSION}`;
  const token = await getToken();
  if (!isValidToken(token)) {
    return { discord_status: `${version} · ⚠ Falta el token: usa «Vincular cuenta»` };
  }

  const syncAge = lastSyncAge();
  let lastType = "";
  let lastAt = 0;
  try {
    lastType = String(kino.storage.get("last_event") || "");
    lastAt = Number(kino.storage.get("last_event_at") || 0);
  } catch (_) {}

  if (lastAt > 0) {
    const sent = syncAge >= 0 ? `enviado ${formatAge(syncAge, false)}` : "sin estado activo";
    return {
      discord_status: `${version} · ✓ avisó (${lastType}) ${formatAge(Date.now() - lastAt, false)} · ${sent}`,
    };
  }

  return {
    discord_status: `${version} · ○ sin avisos de reproducción (permiso de tracking)`, 
  };
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export async function panel(context) {
  const en = context.lang && context.lang.startsWith("en");
  const token = await getToken();
  const tokenOk = isValidToken(token);
  const age = lastSyncAge();

  const statusText = !tokenOk
    ? (en ? "⚠ No token — go to Settings" : "⚠ Sin token — ve a Ajustes")
    : age >= 0
      ? (en ? `✓ Status sent ${formatAge(age, true)}` : `✓ Estado enviado ${formatAge(age, false)}`)
      : (en ? "○ Waiting for playback" : "○ Esperando reproducción");

  const pos = formatMs(context.positionMs);
  const dur = context.durationMs ? formatMs(context.durationMs) : "--:--";

  const elements = [
    { type: "status", text: statusText },
    { type: "text", text: `${en ? "Now playing" : "Reproduciendo"}: ${context.title || "—"}` },
    { type: "text", text: `${en ? "Position" : "Posición"}: ${pos} / ${dur}` },
  ];

  if (context.kind === "episode") {
    const episode = [
      context.season ? `T${context.season}` : null,
      context.episode ? `E${context.episode}` : null,
      context.episodeTitle || null,
    ].filter(Boolean).join(" · ") || "—";
    elements.push({ type: "text", text: `${en ? "Episode" : "Episodio"}: ${episode}` });
  }

  elements.push({ type: "row", gap: "small", children: [
    { type: "button", key: "sync_now", label: en ? "Sync now" : "Sincronizar" },
    { type: "button", key: "clear_rpc", label: en ? "Clear status" : "Borrar estado" },
  ]});

  return {
    title: "Discord RPC",
    accent: "#5865F2",
    refreshMs: 15000,
    elements,
  };
}

export async function panelAction(event, context) {
  if (event.key === "sync_now") {
    const ok = await sendPresence(buildActivity(context, context.paused), PANEL_BUDGET_MS);
    rememberSync(ok ? Date.now() : 0);
    return { message: ok
      ? "Estado sincronizado con Discord ✓"
      : "Error: vincula tu cuenta en Ajustes primero" };
  }
  if (event.key === "clear_rpc") {
    await clearPresence();
    rememberSync(0);
    return { message: "Estado de Discord borrado ✓" };
  }
  return null;
}

// ── Reproducción ──────────────────────────────────────────────────────────────
// "tracking" es el único gancho que ve TODO lo que se reproduce en el aparato,
// venga del plugin que venga: playerEvent sólo avisa de los títulos propios.

function contextFromTrack(event) {
  const isEpisode = event.kind === "episode";
  const show = event.show && event.show.title ? event.show.title : "";

  return {
    kind: isEpisode ? "episode" : "movie",
    title: isEpisode ? (show || event.title || "Kino TV") : (event.title || "Kino TV"),
    season: event.season,
    episode: event.episode,
    episodeTitle: isEpisode ? event.title : null,
    positionMs: event.positionMs || 0,
    durationMs: event.durationMs || 0,
  };
}

export async function track(event) {
  const type = (event && event.type) || "?";
  const startedAt = Date.now();
  rememberEvent(type);

  const token = await getToken();
  if (!isValidToken(token)) {
    kino.log(
      `discord-rpc v${PLUGIN_VERSION}: ${type} sin token válido (` +
        (token ? "formato no reconocido, " + token.length + " caracteres" : "vacío") +
        "), no se envía nada"
    );
    return { ok: true };
  }

  if (type === "start" || type === "progress") {
    const paused = type === "progress" && event.paused === true;
    const context = contextFromTrack(event);

    const ok = await sendPresence(buildActivity(context, paused), TRACK_BUDGET_MS);
    rememberSync(ok ? Date.now() : 0);

    let custom = "apagado";
    if (persistStatus()) {
      if (!paused) await rememberCustomStatus(token);
      const done = await patchCustomStatus(
        token,
        customFor(customStatusText(context, paused), Date.now() + CUSTOM_STATUS_TTL_MS)
      );
      custom = done ? "puesto" : "NO";
    }

    kino.log(
      `discord-rpc v${PLUGIN_VERSION}: ${type}${paused ? " (pausa)" : ""} · presencia ${ok ? "enviada" : "NO"}` +
        ` · estado personalizado ${custom} · ${Date.now() - startedAt} ms`
    );
  } else if (type === "stop" || type === "watched") {
    await clearPresence();
    rememberSync(0);
    if (persistStatus()) await restoreCustomStatus(token);
    kino.log(`discord-rpc v${PLUGIN_VERSION}: ${type} · presencia borrada · ${Date.now() - startedAt} ms`);
  }

  // Nunca se falla: un estado que no se pudo enviar no merece reintentos.
  return { ok: true };
}

// Los títulos de este plugin no existen, así que Kino casi nunca llamará aquí;
// se mantiene por si algún día el plugin sirve contenido propio.
export async function playerEvent(event, context) {
  const token = await getToken();
  if (!isValidToken(token)) return null;

  if (event.type === "started" || event.type === "resumed") {
    const ok = await sendPresence(buildActivity(context, false), PLAYER_BUDGET_MS);
    rememberSync(ok ? Date.now() : 0);
  } else if (event.type === "paused") {
    const ok = await sendPresence(buildActivity(context, true), PLAYER_BUDGET_MS);
    rememberSync(ok ? Date.now() : 0);
  } else if (event.type === "ended" || event.type === "failed") {
    await clearPresence();
    rememberSync(0);
  }

  return null;
}
