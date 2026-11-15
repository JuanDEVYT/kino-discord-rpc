// Discord RPC — Kino TV plugin v1.0.0
// Conecta con Discord Gateway via WebSocket y actualiza tu estado en tiempo real.
// Protocolo basado en Kizzy (github.com/dead8309/Kizzy), adaptado a QuickJS/Kino.

// ── Constantes del protocolo Discord Gateway ──────────────────────────────────
const GATEWAY_URL  = "wss://gateway.discord.gg/?v=10&encoding=json";
const OP_HEARTBEAT = 1;
const OP_IDENTIFY  = 2;
const OP_PRESENCE  = 3;
const OP_HELLO     = 10;
const APP_ID       = "1570998800338915448";

// ── Estado del socket (vive mientras el plugin esté activo) ───────────────────
let ws        = null;
let sequence  = 0;
let connected = false;
let wsLoopRunning = false;

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

async function getToken() {
  return (await kino.config.get("discord_token") || "").trim();
}

function isValidToken(t) {
  // Token de usuario de Discord: Base64(userId).timestamp.hmac
  return typeof t === "string" && /^[A-Za-z0-9+/]+=*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t) && t.length > 50;
}

// ── Discord Gateway WebSocket ─────────────────────────────────────────────────

async function wsSend(payload) {
  if (!ws) return;
  try { await ws.send(JSON.stringify(payload)); } catch (_) {}
}

async function openGateway(token) {
  // Cerrar conexión anterior si existe
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  sequence  = 0;
  connected = false;

  try {
    ws = await kino.ws.open(GATEWAY_URL);
  } catch (e) {
    ws = null;
    return;
  }

  // Loop de recepción no bloqueante
  if (!wsLoopRunning) {
    wsLoopRunning = true;
    runWsLoop(token).finally(() => { wsLoopRunning = false; });
  }
}

async function runWsLoop(token) {
  while (ws) {
    let msg;
    try {
      msg = await ws.recv(55000);
    } catch (_) {
      connected = false;
      ws = null;
      break;
    }
    if (!msg) { ws = null; break; }

    let p;
    try { p = JSON.parse(msg); } catch (_) { continue; }
    if (p.s) sequence = p.s;

    if (p.op === OP_HELLO) {
      // Iniciar heartbeat (cadencia usando recv con timeout corto)
      const interval = p.d && p.d.heartbeat_interval || 41250;
      runHeartbeat(interval).catch(() => {});
      await wsSend({ op: OP_IDENTIFY, d: {
        token,
        capabilities: 65,
        compress: false,
        large_threshold: 100,
        properties: { os: "Windows", browser: "Discord Client", device: "ktor" },
      }});
    } else if (p.op === 0 && p.t === "READY") {
      connected = true;
    } else if (p.op === 9) {
      // Invalid session — re-identify
      connected = false;
      await wsSend({ op: OP_IDENTIFY, d: {
        token, capabilities: 65, compress: false, large_threshold: 100,
        properties: { os: "Windows", browser: "Discord Client", device: "ktor" },
      }});
    } else if (p.op === 7) {
      // Reconnect
      ws.close();
      ws = null;
      await openGateway(token);
      break;
    }
  }
}

async function runHeartbeat(intervalMs) {
  while (ws) {
    await wsSend({ op: OP_HEARTBEAT, d: sequence || null });
    // Esperar el intervalo en trozos de 5s para poder salir si ws se cierra
    let waited = 0;
    while (ws && waited < intervalMs) {
      try { await ws.recv(Math.min(5000, intervalMs - waited)); } catch (_) {}
      waited += 5000;
    }
  }
}

async function ensureConnected() {
  const token = await getToken();
  if (!token || !isValidToken(token)) return false;

  if (!ws || !connected) {
    await openGateway(token);
    // Esperar hasta 6s a que el handshake complete
    for (let i = 0; i < 60; i++) {
      if (connected) break;
      try { await ws.recv(100); } catch (_) {}
    }
  }
  return connected;
}

async function sendPresence(activity) {
  if (!(await ensureConnected())) return false;
  await wsSend({ op: OP_PRESENCE, d: {
    since: 0, afk: false, status: "online",
    activities: activity ? [activity] : [],
  }});
  return true;
}

function buildActivity(context, paused) {
  const isEpisode = context.kind === "episode";

  const details = isEpisode
    ? `${context.title}${context.season ? ` — T${context.season}` : ""}`
    : (context.title || "Kino TV");

  const state = isEpisode && context.episodeTitle
    ? `E${context.episode} · ${context.episodeTitle}`
    : paused ? "⏸ Pausado" : "▶ Reproduciendo";

  const now    = Date.now();
  const startS = Math.floor((now - (context.positionMs || 0)) / 1000);
  const endS   = context.durationMs
    ? Math.floor((now - (context.positionMs || 0) + context.durationMs) / 1000)
    : null;

  const tmdbId = context.ids && context.ids.tmdb;
  // Discord acepta URLs externas en assets usando el prefijo mp:external/
  const posterKey = tmdbId
    ? `mp:external/image.tmdb.org/t/p/w92/${tmdbId}`
    : "kino_logo";

  const activity = {
    name: "Kino TV",
    type: 3, // WATCHING
    application_id: APP_ID,
    details,
    state,
    assets: {
      large_image: posterKey,
      large_text: "Kino TV",
      ...(tmdbId ? { small_image: "kino_logo", small_text: "Kino TV" } : {}),
    },
    ...((!paused && endS) ? { timestamps: { start: startS, end: endS } } : {}),
    buttons: ["Instalar Kino"],
    metadata: { button_urls: ["https://kinotvapp.github.io"] },
  };

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
    // Intentar con visualBrowser si está disponible
    if (kino.visualBrowser?.available) {
      // Discord guarda el token en localStorage["token"] (con comillas incluidas).
      // El SDK ahora soporta collect.localStorage — Kino cierra la ventana
      // automáticamente cuando aparezca la clave y la devuelve al plugin.
      const result = await kino.visualBrowser.open({
        url: "https://discord.com/login",
        title: "Inicia sesión en Discord",
        doneWhen: { localStorage: ["token"] },
        collect: { localStorage: ["token"] },
        timeoutMs: 300000,
      });

      if (result.status !== "done") {
        return { message: "Vinculación cancelada." };
      }

      // Kino viejo ignora collect.localStorage y no trae el campo
      if (!result.localStorage) {
        return { message: "Este Kino no puede leer localStorage. Actualiza la app." };
      }

      // Discord guarda el token con comillas: '"MTEx..."' → quitar comillas
      const raw = result.localStorage["token"];
      const token = raw ? raw.replace(/^"|"$/g, "") : null;

      if (token && isValidToken(token)) {
        await kino.config.set("discord_token", token);
        return { message: "Cuenta de Discord vinculada ✓" };
      }

      return { message: "Sesión iniciada pero no se encontró el token. Intenta de nuevo." };
    }

    // Sin visualBrowser: instrucciones manuales
    return {
      message: "Pega tu token de Discord en el campo de abajo. Para obtenerlo: abre Discord web → F12 → Consola → escribe: window.webpackChunkdiscord_app.push([[''],{},e=>{ m=[];for(let c in e.c)m.push(e.c[c]);window.token=m.find(m=>m?.exports?.default?.getToken).exports.default.getToken() }]); → copia el resultado de window.token",
    };
  }

  if (key === "unlink_account") {
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    connected = false;
    await kino.config.set("discord_token", "");
    return { message: "Cuenta desvinculada." };
  }

  return null;
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
      : (en ? "○ Connecting…" : "○ Conectando…");

  const pos = formatMs(context.positionMs);
  const dur = context.durationMs ? formatMs(context.durationMs) : "--:--";

  return {
    title: "Discord RPC",
    accent: "#5865F2",
    refreshMs: 15000,
    elements: [
      { type: "status", text: statusText },
      { type: "text", label: en ? "Now playing" : "Reproduciendo",
                      text: context.title || "—" },
      { type: "text", label: en ? "Position" : "Posición",
                      text: `${pos} / ${dur}` },
      ...(context.kind === "episode" ? [{
        type: "text",
        label: en ? "Episode" : "Episodio",
        text: [
          context.season  ? `T${context.season}` : null,
          context.episode ? `E${context.episode}` : null,
          context.episodeTitle || null,
        ].filter(Boolean).join(" · ") || "—",
      }] : []),
      { type: "row", gap: "small", children: [
        { type: "button", key: "sync_now",
          label: en ? "Sync now" : "Sincronizar" },
        { type: "button", key: "clear_rpc",
          label: en ? "Clear status" : "Borrar estado" },
      ]},
    ],
  };
}

export async function panelAction(event, context) {
  if (event.key === "sync_now") {
    const activity = buildActivity(context, context.paused);
    const ok = await sendPresence(activity);
    return { message: ok
      ? "Estado sincronizado con Discord ✓"
      : "Error: vincula tu cuenta en Ajustes primero" };
  }
  if (event.key === "clear_rpc") {
    await sendPresence(null);
    return { message: "Estado de Discord borrado ✓" };
  }
  return null;
}

// ── Player events ─────────────────────────────────────────────────────────────

export async function playerEvent(event, context) {
  const token = await getToken();
  if (!isValidToken(token)) return null;

  if (event.type === "started" || event.type === "resumed") {
    await sendPresence(buildActivity(context, false));
  } else if (event.type === "paused") {
    await sendPresence(buildActivity(context, true));
  } else if (event.type === "ended" || event.type === "failed") {
    await sendPresence(null);
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    connected = false;
  }

  return null;
}
