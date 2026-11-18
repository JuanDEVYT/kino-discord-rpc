// Discord RPC — Kino TV plugin v1.0.9
// Conecta con el Gateway de Discord por WebSocket y actualiza tu estado en tiempo real.
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

const RECV_CHUNK_MS = 25000;   // espera máxima por frame (recv admite hasta 60 s)
const CONNECT_WAIT_MS = 4000;  // lo que un evento del player espera al READY
const PLAYER_WAIT_MS = 2500;   // playerEvent sólo tiene 5 s en total
const RECONNECT_DELAY_MS = 4000;
const MAX_FAILURES = 3;        // intentos seguidos sin READY antes de rendirse

const MANUAL_HINT =
  "Para vincular a mano: abre Discord web → F12 → Consola → pega " +
  "window.webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c]);" +
  "window.token=m.find(m=>m?.exports?.default?.getToken).exports.default.getToken()}]); " +
  "y copia aquí el resultado de window.token.";

// ── Estado del socket (vive mientras el plugin esté activo) ───────────────────
let ws = null;               // socket del Gateway o null
let sequence = 0;            // último "s" recibido
let connected = false;       // READY recibido en este socket
let heartbeatMs = 41250;     // cadencia que pide HELLO
let nextHeartbeatAt = 0;     // próximo heartbeat (0 = todavía sin HELLO)
let awaitingAck = false;     // heartbeat enviado sin ACK
let failures = 0;            // reconexiones seguidas sin READY
let reconnectRunning = false;
let wantConnection = false;  // el plugin quiere estar conectado (para reconectar)
let readyWaiters = [];
let lastActivity = null;     // último estado, para reenviarlo tras reconectar
let lastActivitySet = false;

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
  try {
    return String(kino.config.get("discord_token") || "").trim();
  } catch (_) {
    return "";
  }
}

function isValidToken(t) {
  // Token de usuario de Discord: Base64(userId).timestamp.hmac
  return typeof t === "string" && t.length >= 60 &&
    /^[A-Za-z0-9+/_-]{20,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{20,}$/.test(t);
}

function showButton() {
  try {
    return kino.config.get("show_button") !== "none";
  } catch (_) {
    return true;
  }
}

function wakeReady() {
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const fn of waiters) {
    try { fn(connected); } catch (_) {}
  }
}

function waitForReady(maxMs) {
  if (connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value === true);
    };
    readyWaiters.push(finish);
    // kino.sleep espera como máximo 5 s, suficiente para el handshake
    kino.sleep(Math.max(1, Math.min(5000, maxMs || CONNECT_WAIT_MS)))
      .then(() => finish(connected))
      .catch(() => finish(connected));
  });
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

async function openGateway(token) {
  // Cerrar conexión anterior si existe
  const previous = ws;
  ws = null;
  resetSocketState();
  wakeReady();
  if (previous) { try { await previous.close(); } catch (_) {} }

  let socket;
  try {
    socket = await kino.ws.open(GATEWAY_URL);
  } catch (e) {
    kino.log("discord-rpc: no se pudo abrir el Gateway", e && (e.code || e.message));
    return false;
  }

  ws = socket;
  gatewayLoop(token, socket).catch((e) => {
    kino.log("discord-rpc: loop terminado", e && (e.code || e.message));
  });
  return true;
}

// Un solo lector del socket: aquí se leen los frames y se decide cuándo latir.
async function gatewayLoop(token, socket) {
  while (ws === socket) {
    const now = Date.now();

    if (nextHeartbeatAt && now >= nextHeartbeatAt) {
      if (awaitingAck) {
        // Discord cierra la sesión si un heartbeat queda sin ACK
        kino.log("discord-rpc: heartbeat sin ACK, reconectando");
        break;
      }
      awaitingAck = true;
      if (!(await wsSend({ op: OP_HEARTBEAT, d: sequence || null }))) break;
      nextHeartbeatAt = Date.now() + heartbeatMs;
    }

    let waitMs = nextHeartbeatAt ? nextHeartbeatAt - Date.now() : RECV_CHUNK_MS;
    if (waitMs < 1) waitMs = 1;
    if (waitMs > RECV_CHUNK_MS) waitMs = RECV_CHUNK_MS;

    let frame;
    try {
      frame = await socket.recv(waitMs, { encoding: "base64" });
    } catch (e) {
      if (e && e.code === "timeout") continue;
      kino.log("discord-rpc: recv", e && (e.code || e.message));
      break;
    }
    // null = no llegó nada en el plazo: la conexión sigue viva
    if (frame === null) continue;
    if (ws !== socket) break;

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
      failures = 0;
      wakeReady();
      if (lastActivitySet) await wsSend(presencePayload(lastActivity));
    } else if (p.op === OP_INVALID_SESSION) {
      connected = false;
      wakeReady();
      await kino.sleep(1200);
      if (ws === socket) await identify(token);
    } else if (p.op === OP_RECONNECT) {
      kino.log("discord-rpc: Discord pidió reconectar");
      break;
    }
  }

  if (ws === socket) {
    ws = null;
    resetSocketState();
    wakeReady();
  }
  if (wantConnection) scheduleReconnect();
}

async function scheduleReconnect() {
  if (reconnectRunning) return;
  reconnectRunning = true;
  try {
    while (wantConnection && !ws && failures < MAX_FAILURES) {
      await kino.sleep(RECONNECT_DELAY_MS);
      if (!wantConnection || ws) break;
      failures++;
      const token = await getToken();
      if (!isValidToken(token)) {
        wantConnection = false;
        break;
      }
      await openGateway(token);
    }
    if (wantConnection && !ws) {
      kino.log("discord-rpc: se agotaron los reintentos de conexión");
      wantConnection = false;
    }
  } finally {
    reconnectRunning = false;
  }
}

async function ensureConnected(maxWaitMs) {
  const token = await getToken();
  if (!isValidToken(token)) return false;

  wantConnection = true;
  if (connected && ws) return true;
  if (!ws) {
    if (!(await openGateway(token))) return false;
  }
  return waitForReady(maxWaitMs || CONNECT_WAIT_MS);
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

async function sendPresence(activity, maxWaitMs) {
  // Se guarda antes de esperar: si el READY llega tarde, se envía igualmente
  lastActivity = activity;
  lastActivitySet = true;

  if (!(await ensureConnected(maxWaitMs))) return false;
  const sent = await wsSend(presencePayload(activity));
  if (!sent) connected = false;
  return sent;
}

async function disconnect() {
  wantConnection = false;
  lastActivity = null;
  lastActivitySet = false;

  const socket = ws;
  ws = null;
  resetSocketState();
  wakeReady();
  if (socket) { try { await socket.close(); } catch (_) {} }
}

async function clearPresence() {
  if (connected && ws) {
    try { await wsSend(presencePayload(null)); } catch (_) {}
  }
  await disconnect();
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

    // kino.config es de sólo lectura: el token se guarda con setSettings
    return {
      message: "Cuenta de Discord vinculada ✓",
      setSettings: { discord_token: token },
    };
  }

  if (key === "unlink_account") {
    await disconnect();
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

// ── Panel ─────────────────────────────────────────────────────────────────────

export async function panel(context) {
  const en = context.lang && context.lang.startsWith("en");
  const token = await getToken();
  const tokenOk = isValidToken(token);

  const statusText = !tokenOk
    ? (en ? "⚠ No token — go to Settings" : "⚠ Sin token — ve a Ajustes")
    : connected
      ? (en ? "✓ Connected to Discord" : "✓ Conectado a Discord")
      : (en ? "○ Not connected" : "○ Sin conexión");

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
    const ok = await sendPresence(buildActivity(context, context.paused));
    return { message: ok
      ? "Estado sincronizado con Discord ✓"
      : "Error: vincula tu cuenta en Ajustes primero" };
  }
  if (event.key === "clear_rpc") {
    await clearPresence();
    return { message: "Estado de Discord borrado ✓" };
  }
  return null;
}

// ── Player events ─────────────────────────────────────────────────────────────

export async function playerEvent(event, context) {
  const token = await getToken();
  if (!isValidToken(token)) return null;

  if (event.type === "started" || event.type === "resumed") {
    await sendPresence(buildActivity(context, false), PLAYER_WAIT_MS);
  } else if (event.type === "paused") {
    await sendPresence(buildActivity(context, true), PLAYER_WAIT_MS);
  } else if (event.type === "ended" || event.type === "failed") {
    await clearPresence();
  }

  return null;
}
