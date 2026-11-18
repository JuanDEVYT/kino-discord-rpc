// Discord RPC — Kino TV plugin v1.2.0
// Muestra en Discord lo que se está viendo en Kino (de cualquier plugin).
//
// Todo pasa por el relay oficial (juandiscordrpc.pythonanywhere.com): un
// servidor siempre encendido que mantiene la sesión de Discord abierta con su
// propio latido, así la actividad sigue en el perfil aunque Kino deje de
// llamar. El secreto del relay viaja sellado en el manifiesto
// (secrets.relaySecret) y se lee con kino.secret(): no hay nada que configurar.
//
// v1.2.0: pantalla guía con tres pestañas (Estado, Vincular y Ajustes),
// pestaña aportada al panel del reproductor, aviso en la campanita cuando
// Discord rechaza el token, estadística local de envíos y una capa de
// fiabilidad: presupuestos por llamada, un reintento de red, cortacircuitos
// y errores clasificados en español e inglés.

const APP_ID = "1570998800338915448";
const PLUGIN_VERSION = "1.2.0"; // debe coincidir con kino-plugin.json
const RELAY_URL = "https://juandiscordrpc.pythonanywhere.com";
const RELAY_TTL_SEC = 120; // lo que dura sin refresco; el player slot renueva cada 20 s
const CUSTOM_STATUS_TTL_MS = 6 * 60000;

// Presupuestos de cada llamada (ms): el plugin espera como mucho la mitad del
// tope de Kino, para que nunca llegue al corte.
const TRACK_BUDGET_MS = 8500;    // track tiene 10 s
const SLOT_BUDGET_MS = 4500;     // playerSlot tiene 5 s
const PANEL_BUDGET_MS = 15000;   // panel y panelAction tienen 20 s
const EVENT_BUDGET_MS = 16000;   // screenEvent tiene 20 s
const ACTION_BUDGET_MS = 25000;  // action tiene 30 s

// Cortacircuitos: tras este número de fallos de red seguidos, el plugin deja de
// golpear el servidor durante un rato (la llamada termina al instante).
const BREAKER_FAILS = 3;
const BREAKER_COOLDOWN_MS = 60000;

const TABS = ["estado", "vincular", "ajustes"];

// Tope del campo `status` de un panel (contract.panel.maxStatusChars).
const PANEL_STATUS_CHARS = 200;

const MANUAL_HINT =
  "Para vincular a mano: abre Discord web → F12 → Consola → pega " +
  "window.webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c]);" +
  "window.token=m.find(m=>m?.exports?.default?.getToken).exports.default.getToken()}]); " +
  "y copia aquí el resultado de window.token.";

// Novedades por versión: lo que se enseña en la tarjeta «Novedades» de la
// pestaña Estado cuando la persona actualiza (la marcada vista, en
// kino.storage["novedades_vista"]).
const NOVEDADES = {
  "1.2.0": {
    es: [
      "Pantalla nueva con tres pestañas: Estado, Vincular y Ajustes.",
      "Vinculación visual con Discord en una ventana, con opción manual de respaldo.",
      "Tu estado también en el panel del reproductor y en la esquina de la tele.",
      "Todo pasa por el servidor oficial del proyecto: sin configurar nada.",
    ],
    en: [
      "A new screen with three tabs: Status, Link and Settings.",
      "Visual Discord linking in a window, with a manual fallback.",
      "Your status also in the player panel and the TV corner.",
      "Everything goes through the project's official server: nothing to configure.",
    ],
  },
};

// Cada vez que Kino carga el plugin (instalación, actualización o primer uso
// tras reiniciar el sandbox) queda esta línea en el log: así se sabe qué
// versión está corriendo de verdad en el aparato.
try {
  kino.log(
    `discord-rpc: plugin v${PLUGIN_VERSION} cargado` +
      ` (apiVersion ${kino.apiVersion || "?"}, Kino ${kino.appVersion || "?"})`
  );
} catch (_) {}

// ── Almacenamiento local (siempre disponible, nunca falla la llamada) ─────────

function sget(key) {
  try {
    const v = kino.storage.get(key);
    return v === undefined || v === null ? "" : v;
  } catch (_) {
    return "";
  }
}

function sset(key, value) {
  try { kino.storage.set(key, String(value)); } catch (_) {}
}

function sdel(key) {
  try { kino.storage.remove(key); } catch (_) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isEn(lang) {
  return String(lang || "").toLowerCase().startsWith("en");
}

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

function formatAge(ms, en) {
  if (ms < 60000) return en ? "less than a minute ago" : "hace menos de un minuto";
  const min = Math.round(ms / 60000);
  return en ? `${min} min ago` : `hace ${min} min`;
}

function verTuple(v) {
  const parts = String(v || "0").split(".");
  return [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0];
}

function cmpVer(a, b) {
  const x = verTuple(a);
  const y = verTuple(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// 0.9.87 o posterior: la ventana web puede leer el localStorage del sitio
// (collect.localStorage); antes, sólo sirve el token pegado a mano.
function canReadSiteStorage() {
  const m = String(kino.appVersion || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  return a > 0 || b > 9 || (b === 9 && c >= 87);
}

function rpcEnabled() {
  return sget("rpc_enabled") !== "0";
}

// Síncrona a propósito: kino.config y kino.storage no esperan a nada, así que
// screen() (una vista pura) puede leer el token sin red ni promesas.
function getToken() {
  let token = "";
  try {
    token = String(kino.config.get("discord_token") || "");
  } catch (_) {
    token = "";
  }
  if (!token) {
    // Copia de seguridad: si el ajuste no llega, sirve la guardada al vincular.
    token = String(sget("token_backup") || "");
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

function showButton() {
  try {
    return kino.config.get("show_button") !== "none";
  } catch (_) {
    return true;
  }
}

function rememberEvent(type) {
  sset("last_event", type || "?");
  sset("last_event_at", Date.now());
}

function rememberSync(atMs) {
  sset("last_sync", atMs || 0);
}

function lastSyncAge() {
  const t = Number(sget("last_sync") || 0);
  return t > 0 ? Date.now() - t : -1;
}

// ── Errores clasificados (español e inglés) ───────────────────────────────────

function classify(status, data) {
  if (status === 401) {
    return { es: "el secreto del relay no coincide con el del servidor", en: "the relay secret does not match the server's" };
  }
  if (status === 403 || (data && data.error === "token_rechazado")) {
    return { es: "Discord rechazó el token: vincula la cuenta otra vez", en: "Discord rejected the token: link your account again" };
  }
  if (status === 429) {
    return { es: "límite de peticiones, prueba en unos segundos", en: "rate limited, try again in a few seconds" };
  }
  if (status === 0) {
    return { es: "sin conexión con el servidor", en: "no connection to the server" };
  }
  if (status >= 500) {
    return { es: "Discord no está disponible ahora mismo", en: "Discord is unavailable right now" };
  }
  const tail = data && data.error ? ` (${data.error})` : "";
  return { es: `error del relay ${status}${tail}`, en: `relay error ${status}${tail}` };
}

// ── Cortacircuitos: tres fallos de red seguidos y se deja de intentar ─────────

function breakerUntil() {
  return Number(sget("brk_until") || 0);
}

function breakerHit() {
  const fails = Number(sget("brk_fails") || 0) + 1;
  sset("brk_fails", fails);
  if (fails >= BREAKER_FAILS) sset("brk_until", Date.now() + BREAKER_COOLDOWN_MS);
}

function breakerReset() {
  if (Number(sget("brk_fails") || 0) !== 0) sset("brk_fails", 0);
  if (sget("brk_until")) sdel("brk_until");
}

// ── Estadística local de envíos (los últimos 7 días, sólo en kino.storage) ────

function dayKey(when) {
  const d = when ? new Date(when) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function storageKeys() {
  try {
    return kino.storage.keys ? kino.storage.keys() : [];
  } catch (_) {
    return [];
  }
}

function pruneStats() {
  const oldest = dayKey(Date.now() - 6 * 86400000);
  for (const k of storageKeys()) {
    if (/^stats_\d{4}-\d{2}-\d{2}$/.test(k) && String(k).slice(6) < oldest) sdel(k);
  }
}

function countSendStat() {
  try {
    const key = "stats_" + dayKey();
    sset(key, Number(sget(key) || 0) + 1);
    if (!sget("stats_first")) sset("stats_first", Date.now());
    sset("stats_last", Date.now());
    pruneStats();
  } catch (_) {}
}

function statsWeek() {
  let total = 0;
  for (const k of storageKeys()) {
    if (/^stats_\d{4}-\d{2}-\d{2}$/.test(k)) total += Number(sget(k) || 0) || 0;
  }
  return total;
}

// ── Novedades (changelog local) ───────────────────────────────────────────────

function pendingNovedades() {
  const marker = String(sget("novedades_vista") || "");
  if (!marker) {
    // Primera instalación: se marca la versión actual en silencio, sin tarjeta.
    sset("novedades_vista", PLUGIN_VERSION);
    return [];
  }
  if (cmpVer(marker, PLUGIN_VERSION) >= 0) return [];
  const out = [];
  for (const v of Object.keys(NOVEDADES)) {
    if (cmpVer(marker, v) < 0 && cmpVer(v, PLUGIN_VERSION) <= 0) {
      out.push({ v, es: NOVEDADES[v].es, en: NOVEDADES[v].en });
    }
  }
  out.sort((a, b) => cmpVer(a.v, b.v));
  return out;
}

// ── Relay ─────────────────────────────────────────────────────────────────────

// El valor sale del sello del manifiesto: kino.secret() devuelve la marca y la
// app la sustituye por el secreto antes de mandar la petición.
function relaySecret() {
  try {
    const s = kino.secret("relaySecret");
    return typeof s === "string" ? s.trim() : "";
  } catch (_) {
    return "";
  }
}

function rememberRelay(ok, cls) {
  sset("relay_last_ok", ok ? "1" : "0");
  sset("relay_last_at", Date.now());
  sset("relay_last_error", ok ? "" : (cls ? cls.es : ""));
  sset("relay_last_error_en", ok ? "" : (cls ? cls.en : ""));
}

function relayState() {
  return {
    ok: sget("relay_last_ok") === "1",
    at: Number(sget("relay_last_at") || 0),
    es: String(sget("relay_last_error") || ""),
    en: String(sget("relay_last_error_en") || ""),
  };
}

// La última actividad se guarda en kino.storage: las variables del módulo no
// sobreviven al cierre del sandbox, y el player slot necesita reenviarla.
function rememberActivity(activity) {
  try { kino.storage.set("last_activity", JSON.stringify(activity || null)); } catch (_) {}
}

function storedActivity() {
  try {
    const raw = sget("last_activity");
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function forgetActivity() {
  sdel("last_activity");
}

function markTokenRejected() {
  sset("rej_pending", "1");
}

function forgetTokenRejection() {
  sdel("rej_pending");
}

// Un POST al relay, con un solo reintento si fue un fallo de red (los errores
// HTTP no se reintentan: ya traen su propio veredicto).
async function relayPost(payload, budgetMs, countStat) {
  const secret = relaySecret();
  if (!secret) {
    const cls = { es: "falta el secreto sellado del relay", en: "the sealed relay secret is missing" };
    rememberRelay(false, cls);
    return { ok: false, status: 0, cls };
  }

  const until = breakerUntil();
  if (until > Date.now()) {
    const waitSec = Math.ceil((until - Date.now()) / 1000);
    const cls = {
      es: `el relay está en enfriamiento (${waitSec} s)`,
      en: `the relay is cooling down (${waitSec} s)`,
    };
    return { ok: false, status: 0, cls };
  }

  const timeoutMs = Math.min(budgetMs || 5000, 6000);
  const networkCls = { es: "sin conexión con el servidor", en: "no connection to the server" };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await kino.fetch(RELAY_URL + "/v1/presence", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + secret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        timeoutMs,
      });
      let data = null;
      try { data = r.json(); } catch (_) {}
      const ok = Boolean(r.ok) && (!data || data.ok !== false);
      if (ok) {
        breakerReset();
        rememberRelay(true, null);
        if (countStat !== false) countSendStat();
        return { ok: true, status: r.status, data, cls: null };
      }
      const cls = classify(r.status, data);
      rememberRelay(false, cls);
      if (r.status === 403 || (data && data.error === "token_rechazado")) markTokenRejected();
      kino.log("discord-rpc: relay " + cls.es);
      return { ok: false, status: r.status, data, cls };
    } catch (e) {
      // Fallo de red: un reintento y fuera.
      rememberRelay(false, networkCls);
      breakerHit();
      if (attempt === 0) {
        try { await kino.sleep(400); } catch (_) {}
        continue;
      }
      kino.log("discord-rpc: relay inaccesible", e && (e.code || e.message));
      return { ok: false, status: 0, data: null, cls: networkCls };
    }
  }
  return { ok: false, status: 0, data: null, cls: networkCls };
}

async function relayDelete() {
  const secret = relaySecret();
  if (!secret) return false;
  try {
    const r = await kino.fetch(RELAY_URL + "/v1/presence", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: await getToken() }),
      timeoutMs: 5000,
    });
    return Boolean(r.ok) || r.status === 204;
  } catch (_) {
    return false;
  }
}

// ── Envío de la actividad (siempre por el relay) ──────────────────────────────

async function sendPresence(activity, budgetMs, paused, relayCustom) {
  const payload = {
    token: await getToken(),
    activity: activity || null,
    paused: Boolean(paused),
    ttlSec: RELAY_TTL_SEC,
  };
  if (relayCustom && relayCustom.text) {
    payload.customStatus = {
      text: relayCustom.text,
      expiresInSec: relayCustom.expiresInSec || Math.round(CUSTOM_STATUS_TTL_MS / 1000),
      emoji_name: null,
    };
  }
  const res = await relayPost(payload, budgetMs, true);
  rememberSync(res.ok ? Date.now() : 0);
  if (res.ok) rememberActivity(activity);
  return res.ok;
}

async function clearPresence() {
  const res = await relayPost({ token: await getToken(), activity: null }, 4000, false);
  forgetActivity();
  if (res.ok) rememberSync(0);
  return res.ok;
}

// ── Comprobación del token contra Discord ─────────────────────────────────────

// Sólo un 401/403 invalida el token; sin red no se descarta uno que parece válido.
async function checkToken(token) {
  try {
    const r = await kino.fetch("https://discord.com/api/v9/users/@me", {
      headers: { Authorization: token },
      timeoutMs: 10000,
    });
    if (r.status === 401 || r.status === 403) return false;
    if (r.ok) {
      const me = r.json();
      if (me && me.username) {
        sset("account_name", me.username);
        kino.log("discord-rpc: cuenta de", me.username);
      }
    }
    return true;
  } catch (_) {
    return true;
  }
}

// ── Actividad ─────────────────────────────────────────────────────────────────

function customStatusText(context, paused) {
  const isEpisode = context.kind === "episode";
  const what = isEpisode
    ? `${context.title || "Kino TV"}${context.season ? ` T${context.season}` : ""}${context.episode ? `E${context.episode}` : ""}`
    : (context.title || "Kino TV");
  return `${paused ? "⏸ Pausado:" : "▶ Viendo"} ${what}`;
}

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

function contextFromPanel(context) {
  if (!context) return null;
  if (context.live === true || context.kind === "live") {
    const name = context.channel && context.channel.name ? context.channel.name : null;
    return name ? { kind: "live", title: name, positionMs: 0, durationMs: 0 } : null;
  }
  if (!context.kind) return null; // contexto «bare»: Kino no comparte el título
  return {
    kind: context.kind === "episode" ? "episode" : "movie",
    title: context.title || "Kino TV",
    season: context.season,
    episode: context.episode,
    episodeTitle: context.episodeTitle,
    positionMs: context.positionMs || 0,
    durationMs: context.durationMs || 0,
  };
}

// ── Ajustes: línea de estado ─────────────────────────────────────────────────

export async function settingsStatus() {
  try {
    const v = `v${PLUGIN_VERSION}`;
    const token = await getToken();
    if (!isValidToken(token)) {
      return { discord_status: `${v} · ⚠ Sin token: vincula tu cuenta en la pantalla Kino TV` };
    }
    if (!rpcEnabled()) {
      return { discord_status: `${v} · ⏸ Actividad apagada (se enciende en la pantalla Kino TV)` };
    }
    const st = relayState();
    const week = statsWeek();
    if (st.at <= 0) {
      return { discord_status: `${v} · relay ○ listo · sin envíos aún · 7 días: ${week}` };
    }
    const mark = st.ok ? "✓" : `✗ ${st.es || "error"}`;
    return {
      discord_status: `${v} · relay ${mark} · último POST ${formatAge(Date.now() - st.at, false)} · 7 días: ${week}`,
    };
  } catch (_) {
    return { discord_status: `v${PLUGIN_VERSION} · estado no disponible` };
  }
}

// ── Action de settings ────────────────────────────────────────────────────────

async function doUnlink() {
  await clearPresence();
  await relayDelete();
  rememberSync(0);
  forgetActivity();
  forgetTokenRejection();
  sdel("rej_notified");
  sdel("token_backup");
  sdel("account_name");
  sdel("custom_saved");
  sdel("custom_prev");
}

export async function action(key) {
  try {
    if (key === "test_status") {
      const token = await getToken();
      if (!isValidToken(token)) {
        return { message: "Primero vincula tu cuenta de Discord en la pantalla Kino TV." };
      }
      if (!rpcEnabled()) {
        return { message: "La actividad está apagada: enciéndela en la pantalla Kino TV." };
      }
      const activity = buildActivity(
        { kind: "movie", title: "Prueba de estado", positionMs: 0, durationMs: 0 },
        false
      );
      const relayCustom = persistStatus() ? { text: "▶ Probando Kino TV", expiresInSec: 120 } : null;
      const ok = await sendPresence(activity, ACTION_BUDGET_MS, false, relayCustom);
      kino.log(`discord-rpc v${PLUGIN_VERSION}: prueba vía relay · ${ok ? "enviada" : "NO"}`);
      if (!ok) {
        const st = relayState();
        return { message: "No llegó al relay: " + (st.es || "sin conexión con el servidor") };
      }
      return {
        message: relayCustom
          ? "Enviado ✓ Mira tu perfil: «Kino TV» y «▶ Probando Kino TV» (2 min)."
          : "Enviado ✓ Mira tu perfil: «Kino TV».",
      };
    }

    if (key === "unlink_account") {
      await doUnlink();
      return { message: "Cuenta desvinculada.", clearSettings: ["discord_token"] };
    }

    return null;
  } catch (e) {
    kino.log("discord-rpc: action", e && (e.code || e.message));
    return { message: "Algo salió mal: inténtalo de nuevo." };
  }
}

// ── Pantalla ──────────────────────────────────────────────────────────────────

function statusLine(snap, en) {
  const st = snap.relay;
  if (!snap.tokenOk) {
    return { role: "warning", es: "Sin cuenta vinculada: ve a la pestaña Vincular.", en: "No account linked: go to the Link tab." };
  }
  if (!snap.rpcOn) {
    return { role: "muted", es: "Actividad apagada: Kino no está enviando nada.", en: "Activity off: Kino is not sending anything." };
  }
  if (!snap.sentEver) {
    return { role: "secondary", es: "✓ Cuenta vinculada · esperando la primera reproducción", en: "✓ Account linked · waiting for the first playback" };
  }
  if (st.ok) {
    return {
      role: "primary",
      es: `✓ Enviando a Discord · último estado ${formatAge(Date.now() - st.at, false)}`,
      en: `✓ Sending to Discord · last status ${formatAge(Date.now() - st.at, true)}`,
    };
  }
  return {
    role: "error",
    es: `✗ El relay no lo aceptó: ${st.es || "sin conexión"}`,
    en: `✗ The relay refused it: ${st.en || "no connection"}`,
  };
}

function novedadesCard(entry, en) {
  const lines = (en ? entry.en : entry.es).map((t, i) => ({
    type: "Text",
    text: "• " + (entry.es[i] || t),
    textEn: "• " + (entry.en[i] || t),
    style: "p",
  }));
  return {
    type: "Card",
    key: "novedades",
    variant: "filled",
    children: [
      {
        type: "Column",
        gap: 8,
        children: [
          {
            type: "Text",
            text: `Novedades de la v${entry.v}`,
            textEn: `What's new in v${entry.v}`,
            style: "h4",
          },
          ...lines,
          { type: "ElevatedButton", labelText: "Entendido", labelTextEn: "Got it", onPressed: "novedades_ok" },
        ],
      },
    ],
  };
}

function estadoBody(snap, novedades, en) {
  const out = [];
  const line = statusLine(snap, en);

  if (novedades.length) out.push(novedadesCard(novedades[0], en));

  const statusChildren = [
    { type: "Text", text: "Kino TV", textEn: "Kino TV", style: "h1" },
    { type: "Text", text: line.es, textEn: line.en, color: line.role },
  ];
  const act = snap.activity;
  if (act && act.details) {
    statusChildren.push({
      type: "Text",
      text: `Ahora en Discord: ${act.details} · ${act.state || ""}`,
      textEn: `On Discord now: ${act.details} · ${act.state || ""}`,
      style: "caption",
      color: "muted",
      maxLines: 2,
    });
  }
  if (snap.name) {
    statusChildren.push({
      type: "Text",
      text: `Cuenta: @${snap.name}`,
      textEn: `Account: @${snap.name}`,
      style: "caption",
      color: "muted",
    });
  }
  out.push({ type: "Card", key: "status_card", variant: "filled", children: [{ type: "Column", gap: 8, children: statusChildren }] });

  out.push({
    type: "Card",
    key: "rpc_card",
    children: [
      {
        type: "Column",
        gap: 8,
        children: [
          {
            type: "Switch",
            key: "rpc",
            labelText: "Actividad en Discord",
            labelTextEn: "Discord activity",
            value: snap.rpcOn,
            onChanged: "rpc",
          },
          {
            type: "Text",
            text: snap.rpcOn
              ? "Al apagarlo, Kino deja de actualizar tu estado en Discord."
              : "Apagado: tu perfil de Discord queda como está.",
            textEn: snap.rpcOn
              ? "Turn it off and Kino stops updating your Discord status."
              : "Off: your Discord profile stays as it is.",
            style: "caption",
            color: "muted",
          },
        ],
      },
    ],
  });

  out.push({
    type: "Row",
    wrap: true,
    gap: 8,
    children: [
      {
        type: "ElevatedButton",
        key: "test_now",
        labelText: "Probar ahora",
        labelTextEn: "Test now",
        enabled: snap.tokenOk && snap.rpcOn,
        onPressed: { event: "test", timeoutMs: 16000 },
      },
      {
        type: "Button",
        variant: "secondary",
        key: "clear_now",
        labelText: "Borrar estado",
        labelTextEn: "Clear status",
        confirm: "¿Borrar el estado que se muestra en Discord?",
        confirmEn: "Clear the status shown on Discord?",
        onPressed: "clear",
      },
    ],
  });

  const statsChildren = [
    { type: "Text", text: "Esta semana", textEn: "This week", style: "h4" },
    {
      type: "Text",
      text: `Estados enviados: ${snap.week}`,
      textEn: `Statuses sent: ${snap.week}`,
      style: "p",
    },
  ];
  if (snap.lastEventAt > 0) {
    statsChildren.push({
      type: "Text",
      text: `Último aviso de reproducción (${snap.lastEvent}) ${formatAge(Date.now() - snap.lastEventAt, false)}`,
      textEn: `Last playback notice (${snap.lastEvent}) ${formatAge(Date.now() - snap.lastEventAt, true)}`,
      style: "caption",
      color: "muted",
    });
  } else {
    statsChildren.push({
      type: "Text",
      text: "Todavía sin avisos de reproducción (permiso de tracking).",
      textEn: "No playback notices yet (tracking permission).",
      style: "caption",
      color: "muted",
    });
  }
  statsChildren.push({
    type: "Text",
    text: `Discord RPC v${PLUGIN_VERSION} · servidor oficial del proyecto`,
    textEn: `Discord RPC v${PLUGIN_VERSION} · the project's official server`,
    style: "caption",
    color: "muted",
  });
  out.push({ type: "Card", key: "stats_card", variant: "outlined", children: [{ type: "Column", gap: 8, children: statsChildren }] });

  return out;
}

function vincularBody(snap, en) {
  const out = [];

  if (snap.tokenOk) {
    out.push({
      type: "Card",
      key: "linked_card",
      variant: "filled",
      children: [
        {
          type: "Column",
          gap: 8,
          children: [
            { type: "Text", text: "Cuenta vinculada ✓", textEn: "Account linked ✓", style: "h3" },
            {
              type: "Text",
              text: snap.name ? `Discord: @${snap.name}` : "Tu token está guardado en este aparato.",
              textEn: snap.name ? `Discord: @${snap.name}` : "Your token is stored on this device.",
              style: "p",
            },
            {
              type: "TextButton",
              labelText: "Desvincular cuenta",
              labelTextEn: "Unlink account",
              confirm: "¿Desvincular tu cuenta de Discord?",
              confirmEn: "Unlink your Discord account?",
              onPressed: "unlink",
            },
          ],
        },
      ],
    });
  } else {
    out.push({
      type: "Card",
      key: "link_card",
      variant: "filled",
      children: [
        {
          type: "Column",
          gap: 8,
          children: [
            { type: "Text", text: "Vincula tu cuenta", textEn: "Link your account", style: "h3" },
            {
              type: "Text",
              text: "Se abre la web de Discord en una ventana: inicia sesión y Kino guarda el token solo en este aparato.",
              textEn: "Discord's site opens in a window: sign in and Kino stores the token on this device only.",
              style: "p",
            },
            {
              type: "ElevatedButton",
              key: "link_now",
              labelText: "Vincular con Discord",
              labelTextEn: "Link with Discord",
              onPressed: { event: "link", timeoutMs: 30000 },
            },
          ],
        },
      ],
    });
  }

  if (!canReadSiteStorage()) {
    out.push({
      type: "MaterialBanner",
      role: "warning",
      text: "Tu Kino no puede leer los datos de la ventana: pega el token a mano en el recuadro de abajo.",
      textEn: "Your Kino cannot read the window's data: paste your token manually in the box below.",
    });
  }

  out.push({
    type: "ExpansionTile",
    key: "manual",
    items: [
      {
        key: "manual_token",
        title: "Vincular a mano con tu token",
        titleEn: "Link manually with your token",
        children: [
          {
            type: "Column",
            gap: 8,
            children: [
              { type: "Text", text: MANUAL_HINT, textEn: MANUAL_HINT, style: "caption", color: "muted" },
              {
                type: "Form",
                key: "token_form",
                onSubmitted: "save_token",
                gap: 8,
                children: [
                  {
                    type: "TextField",
                    key: "manual_token",
                    obscureText: true,
                    bind: "discord_token",
                    labelText: "Token de Discord",
                    labelTextEn: "Discord token",
                    hintText: "Se guarda solo en este aparato",
                    hintTextEn: "Stored on this device only",
                    required: false,
                    onSubmitted: "save_token",
                  },
                  {
                    type: "ElevatedButton",
                    labelText: "Guardar token",
                    labelTextEn: "Save token",
                    submit: true,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  return out;
}

function ajustesBody(snap, en) {
  return [
    { type: "Text", text: "Ajustes", textEn: "Settings", style: "h3" },
    { type: "settings", onSaved: "saved" },
    {
      type: "Text",
      text: "Todo pasa por el servidor oficial del proyecto: no hay nada más que configurar.",
      textEn: "Everything goes through the project's official server: nothing else to configure.",
      style: "caption",
      color: "muted",
    },
    { type: "Text", text: `Discord RPC v${PLUGIN_VERSION}`, textEn: `Discord RPC v${PLUGIN_VERSION}`, style: "caption", color: "muted" },
  ];
}

function renderScreen(ctx) {
  const state = ctx.state || {};
  const en = isEn(ctx.lang);
  const tab = TABS.includes(ctx.route) ? ctx.route : (TABS.includes(state.tab) ? state.tab : "estado");

  const snap = {
    tokenOk: isValidToken(getToken()),
    rpcOn: rpcEnabled(),
    relay: relayState(),
    week: statsWeek(),
    name: String(sget("account_name") || ""),
    activity: storedActivity(),
    lastEvent: String(sget("last_event") || ""),
    lastEventAt: Number(sget("last_event_at") || 0),
    sentEver: Number(sget("stats_last") || 0) > 0,
  };

  const novedades = pendingNovedades();
  const body = tab === "vincular"
    ? vincularBody(snap, en)
    : tab === "ajustes"
      ? ajustesBody(snap, en)
      : estadoBody(snap, novedades, en);

  return {
    type: "Column",
    children: [
      {
        type: "TabBar",
        key: "tabbar",
        value: tab,
        onChanged: "tab",
        tabs: [
          {
            value: "estado",
            label: "Estado",
            labelEn: "Status",
            ...(novedades.length ? { badge: { text: "Nueva", textEn: "New" } } : {}),
          },
          { value: "vincular", label: "Vincular", labelEn: "Link" },
          { value: "ajustes", label: "Ajustes", labelEn: "Settings" },
        ],
      },
      {
        type: "SingleChildScrollView",
        key: "body_" + tab,
        children: [
          { type: "Column", padding: { compact: 16, expanded: 32 }, gap: 12, children: body },
        ],
      },
    ],
  };
}

function screenFallback(en) {
  return {
    type: "Column",
    padding: 16,
    gap: 12,
    children: [
      { type: "Text", text: "No se pudo dibujar la pantalla.", textEn: "The screen could not be drawn.", style: "h3" },
      { type: "ElevatedButton", labelText: "Reintentar", labelTextEn: "Retry", onPressed: "tick" },
    ],
  };
}

export async function screen(ctx) {
  try {
    return renderScreen(ctx || {});
  } catch (e) {
    kino.log("discord-rpc: screen", e && (e.code || e.message));
    return screenFallback(isEn(ctx && ctx.lang));
  }
}

// ── Eventos de la pantalla ────────────────────────────────────────────────────

async function notifyTokenRejected() {
  if (sget("rej_pending") !== "1") return;
  if (sget("rej_notified") === PLUGIN_VERSION) return;
  sdel("rej_pending");
  sset("rej_notified", PLUGIN_VERSION);
  try {
    if (!kino.notifications || !kino.notifications.post) return;
    await kino.notifications.post({
      id: "token-rechazado-" + PLUGIN_VERSION,
      title: "Discord rechazó tu token",
      titleEn: "Discord rejected your token",
      text: "Vincula tu cuenta otra vez para seguir mostrando tu actividad.",
      textEn: "Link your account again to keep showing your activity.",
      go: { screen: { route: "vincular" } },
    });
  } catch (e) {
    kino.log("discord-rpc: aviso", e && (e.code || e.message));
  }
}

async function onOpen(ev) {
  // Limpieza de claves que dejó la versión anterior (estado personalizado REST).
  sdel("custom_saved");
  sdel("custom_prev");

  const patch = {};
  if (TABS.includes(ev.route)) patch.tab = ev.route;
  await notifyTokenRejected();
  return Object.keys(patch).length ? { state: patch } : null;
}

async function onLink(en) {
  if (!kino.visualBrowser || !kino.visualBrowser.available) {
    return {
      toast: "Este aparato no puede abrir la ventana: pega el token a mano aquí abajo.",
      toastEn: "This device can't open the window: paste your token manually below.",
    };
  }
  if (!canReadSiteStorage()) {
    return {
      dialog: {
        title: "Tu Kino no lee los datos de la ventana",
        titleEn: "Your Kino can't read the window's data",
        body: "Actualiza Kino para vincular con la ventana, o pega tu token a mano en el recuadro de abajo.",
        bodyEn: "Update Kino to link with the window, or paste your token manually in the box below.",
      },
    };
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
    kino.log("discord-rpc: ventana", e && (e.code || e.message));
    return {
      toast: "No se pudo abrir la ventana de Discord.",
      toastEn: "Discord's window could not open.",
    };
  }

  if (!result || result.status !== "done") {
    return { toast: "Vinculación cancelada.", toastEn: "Linking cancelled." };
  }
  if (!result.localStorage) {
    return {
      dialog: {
        title: "Este Kino no lee el almacenamiento del sitio",
        titleEn: "This Kino can't read the site's storage",
        body: "Actualiza la app o pega tu token a mano en el recuadro de abajo.",
        bodyEn: "Update the app or paste your token manually in the box below.",
      },
    };
  }

  // Discord guarda el token con comillas: '"MTEx...' → quitar comillas
  const raw = result.localStorage["token"];
  const token = raw ? String(raw).replace(/^"|"$/g, "").trim() : "";
  if (!token) {
    return { toast: "Sesión iniciada pero Discord no guardó el token.", toastEn: "Signed in, but Discord saved no token." };
  }
  if (!isValidToken(token)) {
    return { toast: "El token encontrado no es el de Discord.", toastEn: "The token found is not Discord's." };
  }
  if (!(await checkToken(token))) {
    return { toast: "Discord rechazó ese token. Inicia sesión de nuevo.", toastEn: "Discord rejected that token. Sign in again." };
  }

  // Copia de seguridad por si el ajuste no llega a las llamadas del player
  sset("token_backup", token);
  forgetTokenRejection();
  // Si hubo un aviso por token rechazado, un enlace nuevo vuelve a abrir la
  // puerta: si Discord lo rechaza otra vez, la campanita avisará de nuevo.
  sdel("rej_notified");
  return {
    state: { refreshed: Date.now() },
    config: { discord_token: token },
    toast: "Cuenta de Discord vinculada ✓",
    toastEn: "Discord account linked ✓",
  };
}

async function onSaveToken(ev) {
  const typed = String((ev.value && ev.value.manual_token) || "").trim();
  if (!typed) {
    return { state: { refreshed: Date.now() }, toast: "Se mantiene el token guardado.", toastEn: "The saved token stays." };
  }
  const token = typed.replace(/^[\s"']+/, "").replace(/[\s"']+$/, "");
  if (!isValidToken(token)) {
    return { toast: "Ese texto no parece un token de Discord.", toastEn: "That text doesn't look like a Discord token." };
  }
  if (!(await checkToken(token))) {
    return { toast: "Discord rechazó ese token.", toastEn: "Discord rejected that token." };
  }
  sset("token_backup", token);
  forgetTokenRejection();
  sdel("rej_notified"); // un token guardado a mano también vuelve a abrir el aviso
  return {
    state: { refreshed: Date.now() },
    config: { discord_token: token },
    toast: "Token guardado ✓",
    toastEn: "Token saved ✓",
  };
}

async function onTest(en) {
  const token = await getToken();
  if (!isValidToken(token)) {
    return { toast: "Primero vincula tu cuenta de Discord.", toastEn: "Link your Discord account first." };
  }
  if (!rpcEnabled()) {
    return { toast: "La actividad está apagada.", toastEn: "The activity is off." };
  }
  const activity = buildActivity(
    { kind: "movie", title: "Prueba de estado", positionMs: 0, durationMs: 0 },
    false
  );
  const relayCustom = persistStatus() ? { text: "▶ Probando Kino TV", expiresInSec: 120 } : null;
  const ok = await sendPresence(activity, EVENT_BUDGET_MS, false, relayCustom);
  if (ok) {
    return {
      state: { refreshed: Date.now() },
      toast: relayCustom ? "Enviado ✓ Mira tu perfil: «Kino TV» y «▶ Probando Kino TV» (2 min)." : "Enviado ✓ Mira tu perfil de Discord.",
      toastEn: relayCustom ? "Sent ✓ Check your profile: “Kino TV” and “▶ Probando Kino TV” (2 min)." : "Sent ✓ Check your Discord profile.",
    };
  }
  const st = relayState();
  return {
    state: { refreshed: Date.now() },
    toast: "No llegó al relay: " + (st.es || "sin conexión con el servidor"),
    toastEn: "The relay did not accept it: " + (st.en || "no connection to the server"),
  };
}

async function onScreenEvent(ev) {
  const name = String(ev.name || "");
  const en = isEn(ev.lang);
  const state = ev.state || {};

  if (name === "open") return onOpen(ev);
  if (name === "tick") return { state: { refreshed: Date.now() } };

  if (name === "tab") {
    const tab = TABS.includes(ev.value) ? ev.value : "estado";
    return { state: { tab } };
  }

  if (name === "rpc") {
    const on = ev.value !== false;
    sset("rpc_enabled", on ? "1" : "0");
    return {
      state: { refreshed: Date.now() },
      toast: on ? "Actividad encendida" : "Actividad apagada",
      toastEn: on ? "Activity on" : "Activity off",
    };
  }

  if (name === "test") return onTest(en);

  if (name === "clear") {
    const ok = await clearPresence();
    return {
      state: { refreshed: Date.now() },
      toast: ok ? "Estado de Discord borrado ✓" : "No se pudo borrar el estado.",
      toastEn: ok ? "Discord status cleared ✓" : "The status could not be cleared.",
    };
  }

  if (name === "link") return onLink(en);

  if (name === "save_token") return onSaveToken(ev);

  if (name === "unlink") {
    await doUnlink();
    return {
      state: { refreshed: Date.now() },
      config: { discord_token: null },
      toast: "Cuenta desvinculada.",
      toastEn: "Account unlinked.",
    };
  }

  if (name === "novedades_ok") {
    sset("novedades_vista", PLUGIN_VERSION);
    return { state: { refreshed: Date.now() } };
  }

  if (name === "saved") {
    const keys = (ev.value && ev.value.keys) || [];
    if (keys.indexOf("discord_token") >= 0) {
      sdel("rej_pending");
      sdel("rej_notified");
    }
    return { state: { refreshed: Date.now() } };
  }

  return null;
}

export async function screenEvent(ev) {
  try {
    return await onScreenEvent(ev || {});
  } catch (e) {
    kino.log("discord-rpc: screenEvent", e && (e.code || e.message));
    return {
      toast: "Algo salió mal: inténtalo de nuevo.",
      toastEn: "Something went wrong: try again.",
    };
  }
}

// ── Panel del reproductor (pestaña aportada) ──────────────────────────────────

function panelStatusText(snap, en) {
  if (!snap.tokenOk) return en ? "⚠ No account linked" : "⚠ Sin cuenta vinculada";
  if (!snap.rpcOn) return en ? "⏸ Activity off" : "⏸ Actividad apagada";
  if (snap.age >= 0) {
    return en
      ? `✓ Status sent ${formatAge(snap.age, true)} (relay)`
      : `✓ Estado enviado ${formatAge(snap.age, false)} (relay)`;
  }
  if (snap.sentEver || (en ? snap.relayErrEn : snap.relayErrEs)) {
    const head = en ? "✗ Last send failed" : "✗ El último envío falló";
    const detail = en ? snap.relayErrEn : snap.relayErrEs;
    // El detalle clasificado del relay (texto plano, recortado al tope del panel).
    return (detail ? `${head}: ${detail}` : head).slice(0, PANEL_STATUS_CHARS);
  }
  return en ? "○ Waiting for playback" : "○ Esperando reproducción";
}

export async function panel(context) {
  try {
    const en = isEn(context && context.lang);
    const token = await getToken();
    const rel = relayState();
    const snap = {
      tokenOk: isValidToken(token),
      rpcOn: rpcEnabled(),
      age: lastSyncAge(),
      sentEver: Number(sget("stats_last") || 0) > 0,
      relayErrEs: rel.ok ? "" : rel.es,
      relayErrEn: rel.ok ? "" : rel.en,
    };

    const pos = formatMs(context && context.positionMs);
    const dur = context && context.durationMs ? formatMs(context.durationMs) : "--:--";
    const title = (context && context.title) || "—";

    const elements = [
      { type: "status", text: panelStatusText(snap, en) },
      { type: "text", text: `${en ? "Now playing" : "Reproduciendo"}: ${title}` },
      { type: "text", text: `${en ? "Position" : "Posición"}: ${pos} / ${dur}` },
    ];

    if (context && context.kind === "episode") {
      const episode = [
        context.season ? `T${context.season}` : null,
        context.episode ? `E${context.episode}` : null,
        context.episodeTitle || null,
      ].filter(Boolean).join(" · ") || "—";
      elements.push({ type: "text", text: `${en ? "Episode" : "Episodio"}: ${episode}` });
    }

    elements.push({
      type: "row",
      gap: "small",
      children: [
        {
          type: "button",
          key: "rpc_toggle",
          label: snap.rpcOn
            ? (en ? "Activity: on" : "Actividad: encendida")
            : (en ? "Activity: off" : "Actividad: apagada"),
        },
        { type: "button", key: "sync_now", label: en ? "Sync now" : "Sincronizar" },
        { type: "button", key: "clear_rpc", label: en ? "Clear status" : "Borrar estado" },
      ],
    });

    return {
      title: "Discord RPC",
      accent: "#5865F2",
      refreshMs: 15000,
      elements,
    };
  } catch (e) {
    kino.log("discord-rpc: panel", e && (e.code || e.message));
    return {
      title: "Discord RPC",
      accent: "#5865F2",
      elements: [{ type: "status", text: "Error al dibujar el panel / Error drawing the panel" }],
    };
  }
}

export async function panelAction(event, context) {
  try {
    const en = isEn(context && context.lang);
    const key = event && event.key;

    // El `message` de un panel pasa por la misma regla que un userMessage de la
    // app (kino-shim `sentenceRefusal`): sin símbolos como ✓, sin paréntesis ni
    // comillas, sin la palabra Kino, dos palabras como mínimo y160 caracteres.
    // El detalle del relay vive en la línea `status` del panel, que no se filtra
    // (sólo `message` pasa por esa regla).
    if (key === "rpc_toggle") {
      const on = !rpcEnabled();
      sset("rpc_enabled", on ? "1" : "0");
      return {
        panel: await panel(context),
        message: en
          ? (on
              ? "Activity on: Discord now shows what you're watching."
              : "Activity off: your Discord profile stays as it is.")
          : (on
              ? "Actividad encendida: tu perfil de Discord ya la muestra."
              : "Actividad apagada: tu perfil de Discord queda como está."),
      };
    }

    if (key === "sync_now") {
      if (!isValidToken(await getToken())) {
        return {
          message: en
            ? "Link your Discord account first, from this plugin's screen."
            : "Primero vincula tu cuenta de Discord en la pantalla de este plugin.",
        };
      }
      if (!rpcEnabled()) {
        return {
          message: en
            ? "The activity is off: turn it on with the button on the left."
            : "La actividad está apagada: enciéndela con el botón de la izquierda.",
        };
      }
      const activity = context && context.kind
        ? buildActivity(context, context.paused)
        : storedActivity();
      if (!activity) {
        return {
          message: en ? "There is nothing to sync yet." : "Todavía no hay nada que sincronizar.",
        };
      }
      const ok = await sendPresence(activity, PANEL_BUDGET_MS, context && context.paused, null);
      return {
        message: ok
          ? (en ? "Status synced with Discord: check your profile." : "Estado sincronizado con Discord: mira tu perfil.")
          : (en
              ? "The relay refused it: try again in a few seconds."
              : "No llegó al relay: inténtalo de nuevo en unos segundos."),
      };
    }

    if (key === "clear_rpc") {
      const ok = await clearPresence();
      return {
        message: ok
          ? (en ? "Discord status cleared." : "Estado de Discord borrado.")
          : (en ? "The status could not be cleared." : "No se pudo borrar el estado."),
      };
    }

    return null;
  } catch (e) {
    kino.log("discord-rpc: panelAction", e && (e.code || e.message));
    return { message: "Algo salió mal: inténtalo de nuevo." };
  }
}

// ── Player slot (apiVersion 23): una llamada cada refreshMs mientras se ve
// algo en la tele, sin abrir nada. Renueva el TTL del relay.

export async function playerSlot(context) {
  try {
    const token = await getToken();
    let label = "Discord ✗";

    if (!rpcEnabled()) {
      label = "Discord ⏸";
    } else if (isValidToken(token)) {
      const ctx = contextFromPanel(context);
      const paused = Boolean(context && context.paused);
      const activity = ctx ? buildActivity(ctx, paused) : storedActivity();

      if (activity) {
        const relayCustom = persistStatus() && ctx && !paused
          ? { text: customStatusText(ctx, false), expiresInSec: Math.round(CUSTOM_STATUS_TTL_MS / 1000) }
          : null;
        const ok = await sendPresence(activity, SLOT_BUDGET_MS, paused, relayCustom);
        label = ok ? "Discord ✓" : "Discord ✗";
      } else {
        label = "Discord ○"; // todavía no hay nada que refrescar
      }
    } else {
      label = "Discord ⚠";
    }

    return { items: [{ id: "rpc", text: label }], refreshMs: 20000 };
  } catch (e) {
    kino.log("discord-rpc: playerSlot", e && (e.code || e.message));
    return { items: [{ id: "rpc", text: "Discord ?" }], refreshMs: 20000 };
  }
}

export async function playerSlotAction() {
  return null;
}

// ── Reproducción ──────────────────────────────────────────────────────────────
// "tracking" es el único gancho que ve TODO lo que se reproduce en el aparato,
// venga del plugin que venga.

export async function track(event) {
  try {
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

    if (!rpcEnabled()) {
      kino.log(`discord-rpc v${PLUGIN_VERSION}: ${type} con la actividad apagada, no se envía nada`);
      return { ok: true };
    }

    if (type === "start" || type === "progress") {
      const paused = type === "progress" && event.paused === true;
      const context = contextFromTrack(event);
      const activity = buildActivity(context, paused);

      // El estado personalizado lo escribe el servidor (y lo restaura solo al
      // parar), así que viaja dentro del mismo POST.
      const relayCustom = persistStatus()
        ? { text: customStatusText(context, paused), expiresInSec: Math.round(CUSTOM_STATUS_TTL_MS / 1000) }
        : null;

      const ok = await sendPresence(activity, TRACK_BUDGET_MS, paused, relayCustom);
      kino.log(
        `discord-rpc v${PLUGIN_VERSION}: ${type}${paused ? " (pausa)" : ""} · presencia ${ok ? "enviada" : "NO"}` +
          ` · ${Date.now() - startedAt} ms`
      );
    } else if (type === "stop" || type === "watched") {
      await clearPresence();
      kino.log(`discord-rpc v${PLUGIN_VERSION}: ${type} · presencia borrada · ${Date.now() - startedAt} ms`);
    }

    // Nunca se falla: un estado que no se pudo enviar no merece reintentos.
    return { ok: true };
  } catch (e) {
    kino.log("discord-rpc: track", e && (e.code || e.message));
    return { ok: true };
  }
}
