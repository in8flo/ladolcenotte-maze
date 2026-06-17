// La Dolce Notte — Maze & Horde
// Main module: wires up the horde engine, the LED state dispatcher, the
// on-screen overlay, token tracking, and the DM control panel.
//
// Output is decoupled from hardware: by default the module runs "overlay-only"
// so it works fully in Foundry (incl. The Forge) with NO LED bridge present.

import { HordeEngine } from "./horde.js";
import { LedController, OUTPUT_MODE, defaultColorForName } from "./led-controller.js";
import { LedOverlay } from "./overlay.js";
import { Atmosphere } from "./atmosphere.js";
import { GRID_SIZE, MAZE, CELL, findCells } from "./maze-data.js";

const MODULE_ID = "ladolcenotte-maze";
const SOCKET_NS = `module.${MODULE_ID}`;

let horde = null;
let led = null;
let overlay = null;
let tickInterval = null;
let panel = null; // HordePanel singleton
let atmosphere = null;     // player-facing fog/atmosphere layer
let atmosphereTick = null;

// ============ SETTINGS HELPERS ============
function getSetting(key, fallback) {
  try {
    const v = game.settings.get(MODULE_ID, key);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// ============ GRID MAPPING ============
// Convert a token's top-left pixel position (+ its grid dimensions) to a maze
// (row, col). Taking explicit coordinates lets callers pass the authoritative
// destination from an update payload, instead of a possibly-stale document read.
function cellFromTopLeft(x, y, doc) {
  const offX = getSetting("gridOffsetX", 0);
  const offY = getSetting("gridOffsetY", 0);
  const gs = canvas.grid.size;
  const w = ((doc?.width) ?? 1) * gs;
  const h = ((doc?.height) ?? 1) * gs;
  const cx = x + w / 2;
  const cy = y + h / 2;

  let gi, gj;
  if (canvas?.grid && typeof canvas.grid.getOffset === "function") {
    const o = canvas.grid.getOffset({ x: cx, y: cy }); // { i: row, j: col }
    gi = o.i; gj = o.j;
  } else {
    gi = Math.floor(cy / gs);
    gj = Math.floor(cx / gs);
  }
  return [gi - offY, gj - offX];
}

// A token's current maze cell, from its authoritative document position.
function tokenToCell(token) {
  const doc = token.document ?? token;
  return cellFromTopLeft(doc.x, doc.y, doc);
}

// Maze cell (row, col) -> top-left pixel on the canvas (inverse of tokenToCell).
function cellTopLeftPixel(row, col) {
  const offX = getSetting("gridOffsetX", 0);
  const offY = getSetting("gridOffsetY", 0);
  const gs = canvas.grid.size;
  const gi = row + offY, gj = col + offX;
  if (typeof canvas.grid.getTopLeftPoint === "function") {
    const p = canvas.grid.getTopLeftPoint({ i: gi, j: gj });
    return { x: p.x, y: p.y };
  }
  return { x: gj * gs, y: gi * gs };
}

// ============ COLOR HELPERS ============
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
function rgbToHex(rgb) {
  const h = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}
function colorHexForPlayer(name) {
  const cfg = getPlayerConfig()[name];
  if (cfg?.color) return cfg.color;
  return rgbToHex(defaultColorForName(name));
}

// ============ PER-PLAYER CONFIG (colors + alternate/charm counters) ============
// Stored on the world: { [tokenName]: { color: "#rrggbb", charm: number } }
function getPlayerConfig() {
  return foundry.utils.deepClone(getSetting("playerConfig", {}));
}
function setPlayerConfig(cfg) {
  return game.settings.set(MODULE_ID, "playerConfig", cfg);
}
function getPlayerEntry(name) {
  const cfg = getPlayerConfig();
  return cfg[name] ?? { color: null, charm: 0 };
}
async function setPlayerColor(name, hex) {
  const cfg = getPlayerConfig();
  cfg[name] = { ...(cfg[name] ?? { charm: 0 }), color: hex };
  await setPlayerConfig(cfg);
  applyPlayerColors();
  led.render();
}
async function adjustCharm(name, delta) {
  const cfg = getPlayerConfig();
  const cur = cfg[name] ?? { color: null, charm: 0 };
  cur.charm = Math.max(0, (cur.charm ?? 0) + delta);
  cfg[name] = cur;
  await setPlayerConfig(cfg);
  refreshPanel();
  return cur.charm;
}
// Push DM-configured colors into the LED controller.
function applyPlayerColors() {
  if (!led) return;
  const cfg = getPlayerConfig();
  const map = {};
  for (const [name, entry] of Object.entries(cfg)) {
    const rgb = hexToRgb(entry?.color);
    if (rgb) map[name] = rgb;
  }
  led.setPlayerColors(map);
}

// ============ TOKEN LOOKUP ============
function characterTokens() {
  if (!canvas?.tokens) return [];
  return canvas.tokens.placeables.filter(t => t.actor?.type === "character");
}
function findTokenByName(name) {
  return characterTokens().find(t => t.name === name) ?? null;
}

// ============ TELEPORT ============
async function teleportTokenToCell(token, row, col) {
  if (!token) return;
  const { x, y } = cellTopLeftPixel(row, col);
  // teleport:true → instant move that ignores wall collision (GM-style teleport
  // through the maze); ldnSkipTriggers → don't fire sprite sprints on arrival.
  await token.document.update({ x, y }, { teleport: true, animate: false, ldnSkipTriggers: true });
  // Record where they landed so arriving on a portal doesn't immediately re-prompt.
  portalState[token.id] = (MAZE[row]?.[col] === CELL.PORTAL) ? `${row},${col}` : null;
  refreshPlayers({ skipTriggers: true });
}

// ============ INITIALIZATION ============
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);

  game.settings.register(MODULE_ID, "hordeState", {
    scope: "world", config: false, type: Object, default: {},
  });
  game.settings.register(MODULE_ID, "playerConfig", {
    scope: "world", config: false, type: Object, default: {},
  });
  // Portal numbering: { "row,col": 1..8 } — which numbered portal each tile is.
  game.settings.register(MODULE_ID, "portalNumbers", {
    scope: "world", config: false, type: Object, default: {},
  });

  game.settings.register(MODULE_ID, "outputMode", {
    name: "LED output mode",
    hint: "Where the computed LED state goes. 'Overlay only' needs no hardware (use this for testing on The Forge). 'Bridge' modes talk to the Python LED bridge.",
    scope: "world", config: true, type: String,
    choices: {
      [OUTPUT_MODE.OVERLAY_ONLY]: "Overlay only (on-screen, no hardware)",
      [OUTPUT_MODE.OVERLAY_AND_BRIDGE]: "Overlay + LED bridge",
      [OUTPUT_MODE.BRIDGE_ONLY]: "LED bridge only (physical LEDs)",
    },
    default: OUTPUT_MODE.OVERLAY_ONLY,
    onChange: (mode) => { if (led) led.setOutputMode(mode); refreshPanel(); },
  });

  game.settings.register(MODULE_ID, "ledBridgeUrl", {
    name: "LED Bridge URL",
    hint: "WebSocket URL for the Python LED bridge (only used in a bridge mode).",
    scope: "world", config: true, type: String,
    default: "ws://localhost:8765",
    onChange: (url) => { if (led) led.wsUrl = url; },
  });

  game.settings.register(MODULE_ID, "gridOffsetX", {
    name: "Maze grid offset — X (cells)",
    hint: "Column of the scene grid where the maze's left edge begins. (Mike's Act 2 scene needs 7.)",
    scope: "world", config: true, type: Number, default: 0,
    onChange: () => { rebuildOverlay(); },
  });
  game.settings.register(MODULE_ID, "gridOffsetY", {
    name: "Maze grid offset — Y (cells)",
    hint: "Row of the scene grid where the maze's top edge begins. (Mike's Act 2 scene needs 7.)",
    scope: "world", config: true, type: Number, default: 0,
    onChange: () => { rebuildOverlay(); },
  });

  game.settings.register(MODULE_ID, "overlayOpacity", {
    name: "Overlay opacity",
    hint: "Base opacity of the on-screen LED squares (0.05–1.0). Lower lets more maze art show through.",
    scope: "world", config: true, type: Number,
    range: { min: 0.05, max: 1, step: 0.05 },
    default: 0.5,
    onChange: (v) => { if (overlay) overlay.setOpacity(v); },
  });

  game.settings.register(MODULE_ID, "overlayVisible", {
    scope: "client", config: false, type: Boolean, default: true,
  });

  game.settings.register(MODULE_ID, "debugAlignment", {
    name: "Debug: log token cells",
    hint: "Log each token's computed (row, col) to the console when it moves, to confirm grid alignment.",
    scope: "world", config: true, type: Boolean, default: false,
  });

  game.settings.register(MODULE_ID, "disableMovementHistory", {
    name: "Hide token movement history",
    hint: "Overrides Foundry v13 so the movement path/distance no longer appears when you hover a token (cleaner combat). Existing trails are cleared when toggled.",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => { clearAllMovementHistory(); },
  });

  // --- Player-facing atmosphere layer (fog hints) ---
  game.settings.register(MODULE_ID, "atmosphereEnabled", {
    name: "Player fog atmosphere",
    hint: "Show players maze structure + point-of-interest hints (hedges, tents, portals) above the fog, so they sense the map's design and where to explore.",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => { setupAtmosphere(); },
  });
  game.settings.register(MODULE_ID, "atmospherePreviewGM", {
    name: "Preview player atmosphere (GM)",
    hint: "Show the player atmosphere layer on YOUR screen too, to preview what players see.",
    scope: "client", config: false, type: Boolean, default: false, // GM toggles via the panel
    onChange: () => { setupAtmosphere(); },
  });
  // Which scene the maze overlays (LED overlay + player atmosphere) appear on.
  // Empty = legacy (show on the current scene). GM sets it from the panel.
  game.settings.register(MODULE_ID, "mazeSceneId", {
    scope: "world", config: false, type: String, default: "",
    onChange: () => { reevaluateOverlay(); setupAtmosphere(); refreshPanel(); },
  });

  game.keybindings.register(MODULE_ID, "toggleOverlay", {
    name: "Toggle LED overlay",
    hint: "Show/hide the on-screen LED overlay.",
    editable: [{ key: "KeyO", modifiers: ["Shift"] }],
    restricted: true,
    onDown: () => { toggleOverlay(); return true; },
  });
});

// ============ MOVEMENT-HISTORY OVERRIDE ============
// Foundry v13 records each token's movement and shows the path/distance on hover.
// Patch TokenDocument#_shouldRecordMovementHistory so nothing is recorded while
// the setting is on — leaving the hover with nothing to draw.
Hooks.once("setup", () => {
  const TD = foundry?.documents?.TokenDocument
    ?? (typeof TokenDocument !== "undefined" ? TokenDocument : null);
  const proto = TD?.prototype;
  if (proto && typeof proto._shouldRecordMovementHistory === "function" && !proto._ldnHistoryPatched) {
    const orig = proto._shouldRecordMovementHistory;
    proto._shouldRecordMovementHistory = function (...args) {
      try {
        if (game.settings.get(MODULE_ID, "disableMovementHistory")) return false;
      } catch (_) { /* setting not ready */ }
      return orig.apply(this, args);
    };
    proto._ldnHistoryPatched = true;
    console.log(`${MODULE_ID} | token movement-history override installed`);
  }
});

// Clear any recorded movement trails (used on load and when the setting toggles).
async function clearAllMovementHistory() {
  if (!game.user?.isGM || !canvas?.tokens) return;
  if (!getSetting("disableMovementHistory", true)) return;
  for (const t of canvas.tokens.placeables) {
    try { await t.document.clearMovementHistory?.(); } catch (_) { /* ignore */ }
  }
}

Hooks.once("ready", () => {
  // The atmosphere layer is player-facing — set it up for everyone (the rest of
  // this hook is GM-only).
  setupAtmosphere();
  // Cross-client messaging (portal roll request → player; roll result → GM).
  game.socket.on(SOCKET_NS, onLdnSocket);
  if (!game.user.isGM) return;

  horde = new HordeEngine();
  horde.loadJSON(game.settings.get(MODULE_ID, "hordeState"));

  overlay = new LedOverlay();
  overlay.opacity = getSetting("overlayOpacity", 0.5);
  overlay.visible = getSetting("overlayVisible", true);

  led = new LedController(horde);
  led.overlay = overlay;
  led.outputMode = getSetting("outputMode", OUTPUT_MODE.OVERLAY_ONLY);
  led.wsUrl = getSetting("ledBridgeUrl", "ws://localhost:8765");
  applyPlayerColors();
  led.connect();

  reevaluateOverlay(); // attach only if this is the maze scene

  tickInterval = setInterval(() => led.tick(), 100);

  game.ladolcenotte = {
    horde, led, overlay, openPanel, refreshPlayers, toggleOverlay,
    buildMazeWalls, portalTeleport, sendToPrison, randomizePortalNumbers,
    sendSelectedToPrison, clearAllMovementHistory,
    get atmosphere() { return atmosphere; }, setupAtmosphere,
  };

  refreshPlayers();
  clearAllMovementHistory();

  console.log(`${MODULE_ID} | ready (output: ${led.outputMode})`);
  ui.notifications?.info("La Dolce Notte maze module loaded. Use the 🎭 scene control to open the horde panel.");
});

Hooks.on("canvasReady", () => {
  if (!game.user.isGM || !overlay) return;
  reevaluateOverlay();              // overlay only on the maze scene
  if (isMazeScene()) refreshPlayers();
  clearAllMovementHistory();         // movement-history hide stays global
});

// Atmosphere layer (all users): re-evaluate per scene on every scene change.
Hooks.on("canvasReady", () => { setupAtmosphere(); });
Hooks.on("updateToken", (tokenDoc, changes) => {
  if (atmosphere && ("x" in changes || "y" in changes)) atmosphere.recompute();
});
// When the GM resets the scene's fog, Foundry deletes the FogExploration docs —
// clear the atmosphere's revealed hedges too so they go back to black.
Hooks.on("deleteFogExploration", () => { if (atmosphere) atmosphere.resetReveal(); });

// ============ TOKEN TRACKING ============
// The highlight follows the token via refreshToken, which fires as the token
// animates AND when it settles — so the lit cell always lands under the token's
// final position (the previous updateToken-only path lagged on v13 movement).
Hooks.on("refreshToken", (token) => {
  if (!game.user.isGM || !led) return;
  if (token.actor?.type !== "character") return;
  const [row, col] = tokenToCell(token);
  const prev = led.playerPositions[token.name];
  if (!prev || prev[0] !== row || prev[1] !== col) {
    led.setPlayer(token.name, row, col);
    led.render();
  }
});

// Game-logic triggers (sprite sprints + portal entry) fire on the authoritative
// move event, using the token's final position.
Hooks.on("updateToken", (tokenDoc, changes, options) => {
  if (!game.user.isGM || !led) return;
  if (!("x" in changes || "y" in changes)) return;
  const skip = options?.ldnSkipTriggers === true;
  refreshPlayers({ skipTriggers: skip });
  if (!skip) {
    // Use the change payload's final position so entry fires the instant they
    // move INTO the portal/sprite, not on a later move.
    const x = ("x" in changes) ? changes.x : tokenDoc.x;
    const y = ("y" in changes) ? changes.y : tokenDoc.y;
    checkPortalEntry(tokenDoc, x, y);
    checkSpriteEntry(tokenDoc, x, y);
  }
});

Hooks.on("createToken", () => { if (game.user.isGM) refreshPlayers(); });
Hooks.on("deleteToken", () => { if (game.user.isGM) refreshPlayers(); });

function refreshPlayers({ skipTriggers = false } = {}) {
  if (!led || !canvas?.tokens) return;
  const debug = getSetting("debugAlignment", false);
  led.clearPlayers();
  for (const token of characterTokens()) {
    const [row, col] = tokenToCell(token);
    const name = token.name;
    led.setPlayer(name, row, col);

    if (debug) {
      const doc = token.document ?? token;
      console.log(`${MODULE_ID} | ${name} -> row ${row}, col ${col} (doc ${doc.x}, ${doc.y})`);
    }
  }
  led.render();
}

// ============ COMBAT HOOKS ============
Hooks.on("combatRound", (combat, updateData) => {
  if (!game.user.isGM || !horde) return;
  if (!horde.active) return;
  autoAdvanceHorde();
});

Hooks.on("combatTurn", (combat) => {
  if (!game.user.isGM || !horde || !horde.active) return;
  const combatant = combat.combatant;
  if (!combatant?.token) return;
  const token = canvas.tokens.get(combatant.token.id);
  if (!token || token.actor?.type !== "character") return;

  const [row, col] = tokenToCell(token);
  if (horde.isInHorde(row, col)) {
    promptSwarmTactics(token.name);
  }
});

// ============ HORDE START / ADVANCE ============
function startHorde() {
  horde.start();
  persistHorde();
  led.render();
  // Public flavor for the players; private bookkeeping for the GM.
  ChatMessage.create({
    content: `<p style="font-style:italic">A low, sweet hum rolls through the hedges. <strong>The Bliss Horde has entered the maze</strong> — formless and patient, drawn to the scent of the party. It is coming.</p>`,
  });
  ChatMessage.create({
    content: `🎭 Horde armed (off-map). It surges onto the south edge after <strong>${horde.config.startDelay}</strong> round(s). Nothing is on the board yet.`,
    whisper: ChatMessage.getWhisperRecipients("GM"),
  });
  ui.notifications.warn("🌊 The Bliss Horde is loose in the maze.");
  refreshPanel();
}

function autoAdvanceHorde() {
  const result = horde.advanceRound();
  persistHorde();
  led.render();

  if (result.appeared) {
    ChatMessage.create({
      content: `<p style="font-style:italic">The hedges convulse — a wall of blissful green <strong>floods in from the south</strong>, swallowing the maze's mouth. It begins to climb.</p>`,
    });
    ChatMessage.create({
      content: `🌊 Horde surged onto the map at row ${result.frontRow}${result.sprints > 0 ? ` (+${result.sprints} sprite sprint!)` : ""}.`,
      whisper: ChatMessage.getWhisperRecipients("GM"),
    });
  } else if (result.moved) {
    let msg = `🌊 The Bliss Horde surges forward to row ${result.frontRow}`;
    if (result.sprints > 0) msg += ` (+${result.sprints} sprite sprint!)`;
    if (result.reachedTop) msg += " — IT HAS CONSUMED EVERYTHING.";
    ChatMessage.create({ content: msg, whisper: ChatMessage.getWhisperRecipients("GM") });
  } else {
    ChatMessage.create({
      content: `🌊 The horde stirs but holds — ${result.reason}.`,
      whisper: ChatMessage.getWhisperRecipients("GM"),
    });
  }
  refreshPanel();
}

// ============ SWARM TACTICS (reworked) ============
// On a failed DC save the player chooses, BLIND, between taking the psychic
// damage or "the Bliss Horde ignores you" — which secretly tallies an alternate
// count that raises the final Nymph's charm DC against that character by +1 each.
function promptSwarmTactics(name) {
  const entry = getPlayerEntry(name);
  new Dialog({
    title: "Swarm Tactics — The Ecstasy",
    content: `
      <div style="padding:8px">
        <p><strong>${name}</strong> begins their turn engulfed by the Bliss Horde.</p>
        <p>They must make a <strong>DC ${horde.config.swarmDC} Wisdom save</strong>.</p>
        <p style="color:#bbb">On a failure, offer the player the choice — they do <em>not</em>
        know what the second option does. Current alternate tally for ${name}:
        <strong>${entry.charm ?? 0}</strong>.</p>
      </div>`,
    buttons: {
      damage: {
        label: `Take ${horde.config.swarmDamage} psychic`,
        callback: () => {
          const roll = new Roll(horde.config.swarmDamage);
          roll.evaluate({ async: true }).then(r => {
            r.toMessage({ flavor: `${name} resists but the ecstasy burns — psychic damage` });
          });
        },
      },
      alternate: {
        label: `"It ignores you" (secret +1 Nymph DC)`,
        callback: async () => {
          const total = await adjustCharm(name, 1);
          // Players see nothing happen…
          ChatMessage.create({
            content: `<p style="font-style:italic">The green tide laps at <strong>${name}</strong> and… rolls past, indifferent. <strong>Nothing happens.</strong> The Bliss Horde seems to ignore them entirely.</p>`,
          });
          // …the GM sees the real cost accrue.
          ChatMessage.create({
            content: `💜 <strong>${name}</strong> took the alternate. The final Nymph's charm DC vs. ${name} is now <strong>+${total}</strong> (total ${total} mark${total === 1 ? "" : "s"}).`,
            whisper: ChatMessage.getWhisperRecipients("GM"),
          });
        },
      },
      save: {
        label: "Passed the save",
        callback: () => {
          ChatMessage.create({ content: `✨ ${name} resists the ecstasy and holds their mind.` });
        },
      },
    },
    default: "save",
  }).render(true);
}

// Bounding box of a set of [row, col] cells.
function bbox(cells) {
  if (!cells.length) return null;
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const [r, c] of cells) {
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  }
  return { minR, maxR, minC, maxC };
}

// ============ PORTALS (d8 teleport) ============
// The 8 destination portals = every portal cell EXCEPT:
//   • the two portals flanking Sal's tent in its column (the one above the tent
//     and the one just below it), and
//   • the four portals inside the prison zone.
// On this maze that leaves exactly 8, so a d8 maps 1:1 to a destination.
function eligiblePortalCells() {
  const portals = findCells(CELL.PORTAL); // row-major order
  if (!portals.length) return [];
  const prison = bbox(findCells(CELL.PRISON));
  const sal = bbox(findCells(CELL.SAL));
  const inBox = (r, c, b) => b && r >= b.minR && r <= b.maxR && c >= b.minC && c <= b.maxC;
  // "Near Sal's tent" = the tent's columns, within 2 rows above or below it.
  const nearSal = (r, c) => sal && c >= sal.minC && c <= sal.maxC && r >= sal.minR - 2 && r <= sal.maxR + 2;
  return portals.filter(([r, c]) => !inBox(r, c, prison) && !nearSal(r, c));
}

// The four portal cells inside the prison box (its corners). These are OUTGOING
// ONLY: stepping onto one rolls a d8 and flings you to one of the 8 destinations,
// but they are never a destination themselves.
function prisonPortalCells() {
  const prison = bbox(findCells(CELL.PRISON));
  if (!prison) return [];
  return findCells(CELL.PORTAL).filter(([r, c]) =>
    r >= prison.minR && r <= prison.maxR && c >= prison.minC && c <= prison.maxC);
}

// Cells that TRIGGER a portal roll when a token steps on them: the 8 numbered
// destinations + the 4 outgoing prison portals.
function portalTriggerCells() {
  return [...eligiblePortalCells(), ...prisonPortalCells()];
}

// ---- Portal numbering: each of the 8 portals carries a number 1..8 ----
// Resolves a number for every eligible portal, filling any unset tile with a
// row-major default so a d8 always lands somewhere.
function getPortalNumberMap() {
  const portals = eligiblePortalCells(); // row-major
  const saved = getSetting("portalNumbers", {});
  const map = {};
  portals.forEach((p, i) => {
    const key = `${p[0]},${p[1]}`;
    const n = parseInt(saved[key], 10);
    map[key] = (Number.isInteger(n) && n >= 1 && n <= portals.length) ? n : (i + 1);
  });
  return map;
}

// Number -> [row, col] of the portal carrying that number.
function portalCellForNumber(n) {
  const map = getPortalNumberMap();
  for (const [key, num] of Object.entries(map)) {
    if (num === n) return key.split(",").map(Number);
  }
  const portals = eligiblePortalCells();
  return portals[(n - 1) % portals.length] ?? null;
}

// Labels for the on-map overlay: [{ row, col, text }].
function portalLabels() {
  return Object.entries(getPortalNumberMap()).map(([key, n]) => {
    const [row, col] = key.split(",").map(Number);
    return { row, col, text: n };
  });
}

function syncPortalLabels() {
  if (overlay) overlay.setPortalLabels(portalLabels());
}

async function setPortalNumber(cellKey, n) {
  const map = getPortalNumberMap();
  const current = map[cellKey];
  if (current === n) return;
  // Swap with whichever portal currently holds n, so 1..8 stays a clean set.
  for (const [k, v] of Object.entries(map)) {
    if (v === n && k !== cellKey) { map[k] = current; break; }
  }
  map[cellKey] = n;
  await game.settings.set(MODULE_ID, "portalNumbers", map);
  syncPortalLabels();
  refreshPanel();
}

async function randomizePortalNumbers() {
  const portals = eligiblePortalCells();
  const nums = portals.map((_, i) => i + 1);
  for (let i = nums.length - 1; i > 0; i--) {       // Fisher–Yates shuffle
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  const map = {};
  portals.forEach((p, i) => { map[`${p[0]},${p[1]}`] = nums[i]; });
  await game.settings.set(MODULE_ID, "portalNumbers", map);
  syncPortalLabels();
  refreshPanel();
  ui.notifications.info("Portal numbers randomized.");
}

// ---- Portal teleport: roll d8 → teleport to the portal with that number ----
async function portalTeleport(token) {
  if (!token) return;
  const portals = eligiblePortalCells();
  if (!portals.length) {
    ui.notifications.warn("No eligible portals found on this maze.");
    return;
  }
  // If they're standing on a numbered portal, auto-reroll so the d8 never sends
  // them to the portal they're already on.
  const [curR, curC] = tokenToCell(token);
  const currentNum = getPortalNumberMap()[`${curR},${curC}`];

  let n, tries = 0;
  do {
    const r = new Roll("1d8");
    await r.evaluate({ async: true });
    await r.toMessage({ flavor: `<strong>${token.name}</strong> — portal d8` });
    n = r.total;
    tries++;
  } while (currentNum && n === currentNum && tries < 20);

  const dest = portalCellForNumber(n);
  if (!dest) { ui.notifications.warn(`No portal numbered ${n}.`); return; }

  await teleportTokenToCell(token, dest[0], dest[1]);
  ChatMessage.create({
    content: `🌀 <strong>${token.name}</strong> is flung to <strong>portal #${n}</strong>.`,
  });
}

// ---- Portal entry detection: fires once when a token steps onto a portal ----
const portalState = {}; // tokenId -> portal cell key currently occupied, or null

function checkPortalEntry(tokenDoc, x, y) {
  if (tokenDoc.actor?.type !== "character") return;
  const [row, col] = cellFromTopLeft(x, y, tokenDoc);
  const onPortal = MAZE[row]?.[col] === CELL.PORTAL && portalTriggerCells().some(([r, c]) => r === row && c === col);
  const key = onPortal ? `${row},${col}` : null;
  const prev = portalState[tokenDoc.id] ?? null;
  portalState[tokenDoc.id] = key;
  if (!onPortal || key === prev) return;

  const token = canvas.tokens.get(tokenDoc.id);
  if (!token) return;
  const portalNumber = getPortalNumberMap()[key];
  const owner = owningPlayer(tokenDoc);
  if (owner) {
    // Ask the owning player to roll; their result comes back for GM approval.
    game.socket.emit(SOCKET_NS, {
      type: "portal-request", forUserId: owner.id,
      tokenId: token.id, tokenName: token.name, portalNumber,
    });
    ui.notifications?.info(`${token.name} stepped on a portal — waiting for ${owner.name} to roll.`);
  } else {
    // GM-owned / no online owner → GM handles it directly.
    promptPortal(token, portalNumber);
  }
}

// A non-GM, currently-online user who owns this token's actor.
function owningPlayer(tokenDoc) {
  const actor = tokenDoc.actor;
  if (!actor) return null;
  return game.users.find(u => u.active && !u.isGM && actor.testUserPermission(u, "OWNER")) ?? null;
}

// GM-direct fallback (GM-owned token / no online owner): roll + teleport now.
function promptPortal(token, number) {
  new Dialog({
    title: "Portal!",
    content: `<div style="padding:8px">
      <p><strong>${token.name}</strong> has stepped onto <strong>portal #${number ?? "?"}</strong>.</p>
      <p>Roll a d8 — they are flung to the portal with that number.</p>
    </div>`,
    buttons: {
      go: { icon: '<i class="fas fa-dice-d6"></i>', label: "Roll d8 & Teleport", callback: () => portalTeleport(token) },
      no: { label: "Not now" },
    },
    default: "go",
  }).render(true);
}

// ---- Cross-client portal flow: player rolls, GM approves ----
function onLdnSocket(data) {
  if (!data || typeof data !== "object") return;
  if (data.type === "portal-request" && game.user.id === data.forUserId) showPlayerPortalRoll(data);
  else if (data.type === "portal-roll" && game.user.isGM) showGmPortalApproval(data);
}

// Player side: roll the d8 (auto-reroll if it matches the portal they're on),
// then send the result to the GM for approval. They can also decline.
function showPlayerPortalRoll(data) {
  new Dialog({
    title: "A Portal Stirs",
    content: `<div style="padding:8px">
      <p>Your token <strong>${data.tokenName}</strong> has stepped onto a shimmering portal.</p>
      <p>Roll a d8 to be swept through — or step back.</p>
    </div>`,
    buttons: {
      roll: {
        icon: '<i class="fas fa-dice-d6"></i>', label: "Roll d8",
        callback: async () => {
          let n, tries = 0;
          do {
            const r = new Roll("1d8");
            await r.evaluate({ async: true });
            await r.toMessage({ flavor: `${data.tokenName} — portal d8` });
            n = r.total; tries++;
          } while (data.portalNumber && n === data.portalNumber && tries < 20);
          game.socket.emit(SOCKET_NS, {
            type: "portal-roll", tokenId: data.tokenId, tokenName: data.tokenName,
            roll: n, fromUserName: game.user.name,
          });
          ui.notifications?.info("Rolled — waiting for the GM to confirm the portal.");
        },
      },
      stay: { label: "Stay" },
    },
    default: "roll",
  }).render(true);
}

// GM side: approve the player's rolled portal before the token actually moves.
function showGmPortalApproval(data) {
  new Dialog({
    title: "Portal — Approve?",
    content: `<div style="padding:8px">
      <p><strong>${data.fromUserName}</strong> rolled a <strong>${data.roll}</strong> for <strong>${data.tokenName}</strong>.</p>
      <p>Send them through to <strong>portal #${data.roll}</strong>?</p>
    </div>`,
    buttons: {
      approve: { icon: '<i class="fas fa-check"></i>', label: "Approve teleport", callback: () => approvePortalTeleport(data.tokenId, data.roll) },
      deny: { icon: '<i class="fas fa-times"></i>', label: "Deny" },
    },
    default: "approve",
  }).render(true);
}

async function approvePortalTeleport(tokenId, n) {
  const token = canvas.tokens.get(tokenId);
  if (!token) { ui.notifications.warn("That token is no longer on the scene."); return; }
  const dest = portalCellForNumber(n);
  if (!dest) { ui.notifications.warn(`No portal numbered ${n}.`); return; }
  await teleportTokenToCell(token, dest[0], dest[1]);
  ChatMessage.create({ content: `🌀 <strong>${token.name}</strong> is flung to <strong>portal #${n}</strong>.` });
}

// ---- Sprite entry: GM accepts/ignores the horde sprint ----
const spriteState = {}; // tokenId -> sprite cell key currently on, or null

function checkSpriteEntry(tokenDoc, x, y) {
  if (tokenDoc.actor?.type !== "character") return;
  const [row, col] = cellFromTopLeft(x, y, tokenDoc);
  const onSprite = MAZE[row]?.[col] === CELL.SPRITE;
  const key = onSprite ? `${row},${col}` : null;
  const prev = spriteState[tokenDoc.id] ?? null;
  spriteState[tokenDoc.id] = key;
  if (onSprite && key !== prev && !horde.spriteCrossed(row, col)) {
    promptSprite(tokenDoc.name, row, col);
  }
}

function promptSprite(name, row, col) {
  new Dialog({
    title: "Sprite Disturbed",
    content: `<div style="padding:8px">
      <p><strong>${name}</strong> moved across a sprite.</p>
      <p>Apply a <strong>+${horde.config.spriteSprint}</strong> horde sprint next round?</p>
    </div>`,
    buttons: {
      accept: {
        icon: '<i class="fas fa-bolt"></i>', label: `Accept (+${horde.config.spriteSprint})`,
        callback: () => {
          if (horde.confirmSprite(row, col)) {
            persistHorde(); led.render(); refreshPanel();
            ChatMessage.create({
              content: `⚡ ${name} disturbed a sprite — the horde will sprint <strong>+${horde.config.spriteSprint}</strong> next round.`,
              whisper: ChatMessage.getWhisperRecipients("GM"),
            });
          }
        },
      },
      ignore: { label: "Ignore" },
    },
    default: "accept",
  }).render(true);
}

// ============ PRISON (teleport + escape) ============
// Captured tokens go ONLY on the 5 red prison cells (the cross), never the four
// corner portals — so they don't get flung away the instant they're imprisoned.
function prisonCellsOrdered() {
  const cells = findCells(CELL.PRISON); // the 5 cross cells
  if (!cells.length) return { center: [15, 12], ordered: [[15, 12]] };
  let minR = 99, maxR = -1, minC = 99, maxC = -1;
  for (const [r, c] of cells) {
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  }
  const center = [Math.round((minR + maxR) / 2), Math.round((minC + maxC) / 2)];
  // Center first, then the other prison cells by distance from center.
  const ordered = cells.slice().sort((a, b) =>
    (Math.abs(a[0] - center[0]) + Math.abs(a[1] - center[1])) -
    (Math.abs(b[0] - center[0]) + Math.abs(b[1] - center[1])));
  return { center, ordered };
}

// ⛓ Teleport into the cell only — the escape check is posted separately, by the
// DM, when the character actually attempts to break out (postEscapeCard).
async function sendToPrison(token) {
  if (!token) return;
  const { ordered } = prisonCellsOrdered();

  // Cells currently occupied by other character tokens.
  const occupied = new Set();
  for (const t of characterTokens()) {
    if (t.id === token.id) continue;
    const [r, c] = tokenToCell(t);
    occupied.add(`${r},${c}`);
  }
  const dest = ordered.find(([r, c]) => !occupied.has(`${r},${c}`)) ?? ordered[0];
  await teleportTokenToCell(token, dest[0], dest[1]);

  ChatMessage.create({
    content: `<p style="font-style:italic">⛓ <strong>${token.name}</strong> is dragged through the hedges and thrown into the iron holding cell at the maze's heart.</p>`,
  });
  ui.notifications.info(`${token.name} sent to the prison. Click 🗝 when they attempt their escape.`);
}

// 🗝 Post the escape check on demand (manual trigger).
function postEscapeCard(name) {
  ChatMessage.create({
    content: `
      <div class="ldn-chat-card">
        <h3>🗝 ${name} attempts to escape the cell</h3>
        <p><strong>Escape — DC 15</strong> (choose one):</p>
        <ul>
          <li><strong>Athletics</strong> (force the bars), or</li>
          <li><strong>Acrobatics</strong> or <strong>Sleight of Hand</strong> (slip the lock)</li>
        </ul>
        <p><strong>On a success they break free, but:</strong></p>
        <ul>
          <li>Gain <strong>1 level of exhaustion</strong></li>
          <li>Their <strong>Dorium weapon loses 2 standard charges</strong></li>
          <li>They get a <strong>short rest</strong> and may <strong>spend Hit Dice</strong> to recover HP</li>
        </ul>
      </div>`,
  });
}

// Operate on whatever token(s) the DM has selected on the canvas — works for any
// token (incl. one freshly dropped on the scene), not just the player list.
function sendSelectedToPrison() {
  const toks = canvas.tokens?.controlled ?? [];
  if (!toks.length) { ui.notifications.warn("Select a token on the canvas first, then click."); return; }
  for (const t of toks) sendToPrison(t);
}
function escapeCardForSelected() {
  const toks = canvas.tokens?.controlled ?? [];
  if (!toks.length) { ui.notifications.warn("Select a token on the canvas first, then click."); return; }
  for (const t of toks) postEscapeCard(t.name);
}

// ============ MAZE WALLS ============
// Build Foundry walls along every boundary between a walkable cell and a hedge
// (or the maze edge), using the same grid offset as the overlay.
async function buildMazeWalls() {
  if (!canvas?.scene) return;
  const offX = getSetting("gridOffsetX", 0);
  const offY = getSetting("gridOffsetY", 0);
  const gs = canvas.grid.size;

  const corner = (gi, gj) => {
    if (typeof canvas.grid.getTopLeftPoint === "function") {
      const p = canvas.grid.getTopLeftPoint({ i: gi, j: gj });
      return [p.x, p.y];
    }
    return [gj * gs, gi * gs];
  };
  const walkable = (r, c) =>
    r >= 0 && r < GRID_SIZE && c >= 0 && c < GRID_SIZE && MAZE[r][c] !== CELL.WALL;

  const seen = new Set();
  const segs = [];
  const addSeg = (x1, y1, x2, y2) => {
    const key = (x1 < x2 || (x1 === x2 && y1 <= y2))
      ? `${x1},${y1},${x2},${y2}` : `${x2},${y2},${x1},${y1}`;
    if (seen.has(key)) return;
    seen.add(key);
    segs.push({ c: [x1, y1, x2, y2] });
  };

  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (!walkable(r, c)) continue;
      const [x, y] = corner(r + offY, c + offX);
      const x2 = x + gs, y2 = y + gs;
      if (!walkable(r - 1, c)) addSeg(x, y, x2, y);    // top
      if (!walkable(r + 1, c)) addSeg(x, y2, x2, y2);  // bottom
      if (!walkable(r, c - 1)) addSeg(x, y, x, y2);    // left
      if (!walkable(r, c + 1)) addSeg(x2, y, x2, y2);  // right
    }
  }

  const existing = canvas.scene.walls?.size ?? 0;
  const proceed = await Dialog.confirm({
    title: "Build Maze Walls",
    content: `<p>This will create <strong>${segs.length}</strong> wall segments to match the hedge maze
      (grid offset ${offX}, ${offY}).</p>
      ${existing ? `<p><strong>${existing}</strong> walls already exist on this scene.
      Delete them first?</p>` : ""}
      <p style="color:#bbb">Tip: confirm the offset is correct (your scene uses 7, 7) before building.</p>`,
    yes: () => true, no: () => false,
  });
  if (!proceed) return;

  if (existing) {
    const clear = await Dialog.confirm({
      title: "Clear existing walls?",
      content: `<p>Delete the ${existing} existing wall(s) before building? Choose <strong>No</strong> to keep them.</p>`,
      yes: () => true, no: () => false,
    });
    if (clear) {
      const ids = canvas.scene.walls.map(w => w.id);
      await canvas.scene.deleteEmbeddedDocuments("Wall", ids);
    }
  }

  // Create in chunks to be safe with large sets.
  for (let i = 0; i < segs.length; i += 200) {
    await canvas.scene.createEmbeddedDocuments("Wall", segs.slice(i, i + 200));
  }
  ui.notifications.info(`Built ${segs.length} maze wall segments at offset (${offX}, ${offY}).`);
}

// ============ PERSISTENCE ============
function persistHorde() {
  if (!horde) return;
  game.settings.set(MODULE_ID, "hordeState", horde.toJSON());
}

// ============ OVERLAY TOGGLE ============
function toggleOverlay() {
  if (!game.user.isGM || !overlay) return;
  const visible = overlay.toggle();
  game.settings.set(MODULE_ID, "overlayVisible", visible);
  if (visible && led) led.render();
  ui.notifications?.info(`LED overlay ${visible ? "shown" : "hidden"}.`);
  if (ui.controls?.render) ui.controls.render();
  refreshPanel();
}

function rebuildOverlay() {
  if (!overlay) return;
  overlay.attach();
  if (led) led.render();
}

// ============ ATMOSPHERE (player-facing fog hints) ============
// Players always get it (when enabled); the GM only sees it when previewing.
// Is the active scene the one the maze overlays belong on? Empty setting =
// legacy behavior (show on whatever scene is open).
function isMazeScene() {
  const id = getSetting("mazeSceneId", "");
  if (!id) return true;
  return canvas?.scene?.id === id;
}

// GM LED overlay: attach on the maze scene, detach elsewhere.
function reevaluateOverlay() {
  if (!game.user.isGM || !overlay) return;
  if (isMazeScene()) { overlay.attach(); syncPortalLabels(); }
  else { overlay.detach(); }
}

function atmosphereActive() {
  if (!getSetting("atmosphereEnabled", true)) return false;
  return game.user.isGM ? getSetting("atmospherePreviewGM", false) : true;
}

function setupAtmosphere() {
  if (!atmosphereActive()) { teardownAtmosphere(); return; }
  if (!atmosphere) atmosphere = new Atmosphere();
  atmosphere.setPortalCells(eligiblePortalCells());
  if (!atmosphereTick) atmosphereTick = setInterval(() => { if (atmosphere) atmosphere.tick(); }, 100);
  // Scene scoping: show only on the maze scene. Detach (don't destroy) elsewhere
  // so accumulated reveal survives switching scenes and back.
  if (isMazeScene()) { atmosphere.setVisible(true); atmosphere.attach(); }
  else { atmosphere.detach(); }
  refreshPanel();
}

function teardownAtmosphere() {
  if (atmosphere) { atmosphere.detach(); atmosphere = null; }
  if (atmosphereTick) { clearInterval(atmosphereTick); atmosphereTick = null; }
  refreshPanel();
}

// ============ DM CONTROL PANEL (persistent Application) ============
// A real Application (not a re-created Dialog) so it keeps its position when the
// user drags it aside and re-renders in place on every state change. Also works
// with the "Popout!" module to tear it into a separate browser window.
class HordePanel extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "ldn-horde-panel",
      title: "🎭 La Dolce Notte — Horde Control",
      classes: ["ldn-dialog"],
      template: null,
      width: 460,
      height: "auto",
      resizable: true,
      popOut: true,
      scrollY: [".ldn-panel"], // preserve scroll across in-place re-renders
    });
  }

  getData() {
    const c = horde.config;
    const players = characterTokens().map(t => {
      const e = getPlayerEntry(t.name);
      return { name: t.name, hex: colorHexForPlayer(t.name), charm: e.charm ?? 0 };
    });
    return {
      active: horde.active,
      mode: horde.mode,
      frontRow: horde.frontRow,
      frontLabel: horde.frontRow >= GRID_SIZE ? "off-map" : String(horde.frontRow),
      roundsElapsed: horde.roundsElapsed,
      pendingSprints: horde.pendingSprints,
      c,
      players,
      portals: portalLabels().sort((a, b) => a.text - b.text), // by number for the UI
      overlayOn: overlay?.visible,
      overlayOpacity: getSetting("overlayOpacity", 0.5),
      outputMode: getSetting("outputMode", OUTPUT_MODE.OVERLAY_ONLY),
      bridgeOn: led?.bridgeEnabled,
      bridgeConnected: led?.connected,
      offX: getSetting("gridOffsetX", 0),
      offY: getSetting("gridOffsetY", 0),
      historyOff: getSetting("disableMovementHistory", true),
      atmosphereOn: getSetting("atmosphereEnabled", true),
      atmospherePreview: getSetting("atmospherePreviewGM", false),
      mazeSceneSet: !!getSetting("mazeSceneId", ""),
      isMazeScene: isMazeScene(),
      mazeSceneName: (() => {
        const id = getSetting("mazeSceneId", "");
        return id ? (game.scenes?.get(id)?.name ?? "(missing scene)") : "";
      })(),
    };
  }

  async _renderInner(data) {
    return $(buildPanelHTML(data));
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.on("click", "[data-action]", (ev) => {
      ev.preventDefault();
      handlePanelAction(ev.currentTarget.dataset.action);
    });
    html.on("click", "[data-player-action]", (ev) => {
      ev.preventDefault();
      const el = ev.currentTarget;
      handlePlayerAction(el.dataset.playerAction, el.dataset.name);
    });
    html.on("change", "[data-cfg]", (ev) => {
      const key = ev.currentTarget.dataset.cfg;
      const val = parseInt(ev.currentTarget.value, 10);
      if (!isNaN(val)) { horde.config[key] = val; persistHorde(); led.render(); }
    });
    html.on("change", "[data-player-color]", (ev) => {
      setPlayerColor(ev.currentTarget.dataset.playerColor, ev.currentTarget.value);
    });
    html.on("change", "[data-portal-num]", (ev) => {
      const key = ev.currentTarget.dataset.portalNum;
      const n = parseInt(ev.currentTarget.value, 10);
      if (Number.isInteger(n) && n >= 1 && n <= 8) setPortalNumber(key, n);
    });
    html.on("input", "[data-cfg-overlay]", (ev) => {
      const val = parseFloat(ev.currentTarget.value);
      if (!isNaN(val)) {
        game.settings.set(MODULE_ID, "overlayOpacity", val);
        if (overlay) overlay.setOpacity(val);
      }
    });
  }
}

function buildPanelHTML(d) {
  const playerRows = d.players.length ? d.players.map(p => `
    <div class="ldn-player" data-name="${p.name}">
      <input type="color" data-player-color="${p.name}" value="${p.hex}" title="Marker color for ${p.name}">
      <span class="ldn-player-name">${p.name}</span>
      <span class="ldn-charm" title="Alternate / secret-charm tally">Alt ${p.charm}</span>
      <button class="ldn-mini" data-player-action="charm-dec" data-name="${p.name}" title="−1 alt">−</button>
      <button class="ldn-mini" data-player-action="charm-inc" data-name="${p.name}" title="+1 alt">＋</button>
      <button class="ldn-mini" data-player-action="portal" data-name="${p.name}" title="Force a portal roll (d8)">🌀</button>
    </div>`).join("") : `<div class="ldn-empty">No player-character tokens on the scene.</div>`;

  const portalRows = d.portals.length ? d.portals.map(p => `
    <div class="ldn-portal-row">
      <span class="ldn-portal-loc">#${p.text} → (row ${p.row}, col ${p.col})</span>
      <label>set #<input type="number" min="1" max="8" data-portal-num="${p.row},${p.col}" value="${p.text}"></label>
    </div>`).join("") : `<div class="ldn-empty">No portals on this maze.</div>`;

  return `
    <div class="ldn-panel">
      <div class="ldn-status">
        <div class="ldn-status-row"><span>Horde:</span>
          <strong class="${d.active ? 'active' : 'inactive'}">${d.active ? 'UNLEASHED' : 'dormant'}</strong></div>
        <div class="ldn-status-row"><span>Mode:</span> <strong>${d.mode}</strong></div>
        <div class="ldn-status-row"><span>Front row:</span> <strong>${d.frontLabel}</strong></div>
        <div class="ldn-status-row"><span>Rounds elapsed:</span> <strong>${d.roundsElapsed}</strong></div>
        <div class="ldn-status-row"><span>Pending sprints:</span> <strong>${d.pendingSprints}</strong></div>
      </div>

      <hr>
      <div class="ldn-buttons">
        <button data-action="start" class="ldn-btn ldn-btn-danger">🌊 Start Horde</button>
        <button data-action="advance" class="ldn-btn">⏭ Advance Now</button>
        <button data-action="stop" class="ldn-btn">⏸ Pause</button>
        <button data-action="reset" class="ldn-btn">↺ Reset</button>
      </div>

      <hr>
      <div class="ldn-mode">
        <label>Mode:</label>
        <button data-action="mode-split" class="ldn-btn ${d.mode==='split'?'sel':''}"
          title="Use when the party splits up — horde advances ${d.c.splitSpeed} rows/round">Split party</button>
        <button data-action="mode-together" class="ldn-btn ${d.mode==='together'?'sel':''}"
          title="Use when the party stays grouped — horde advances ${d.c.togetherSpeed} rows/round">Together</button>
      </div>

      <hr>
      <div class="ldn-config">
        <label>Start delay (rounds): <input type="number" data-cfg="startDelay" value="${d.c.startDelay}" min="0" max="10"></label>
        <label>Split speed (rows/rnd): <input type="number" data-cfg="splitSpeed" value="${d.c.splitSpeed}" min="1" max="10"></label>
        <label>Together speed (rows/rnd): <input type="number" data-cfg="togetherSpeed" value="${d.c.togetherSpeed}" min="1" max="10"></label>
        <label>Sprite sprint (+rows): <input type="number" data-cfg="spriteSprint" value="${d.c.spriteSprint}" min="0" max="5"></label>
        <label>Swarm save DC: <input type="number" data-cfg="swarmDC" value="${d.c.swarmDC}" min="1" max="30"></label>
      </div>

      <hr>
      <div class="ldn-buttons">
        <button data-action="sprint" class="ldn-btn">+1 Sprint</button>
        <button data-action="sprint-down" class="ldn-btn">−1 Sprint</button>
        <button data-action="sprint-clear" class="ldn-btn">Clear sprints</button>
        <button data-action="refresh" class="ldn-btn">🔄 Sync Players</button>
      </div>

      <hr>
      <div class="ldn-section-title">Players</div>
      <div class="ldn-players">${playerRows}</div>

      <hr>
      <div class="ldn-section-title">Prison</div>
      <div class="ldn-buttons">
        <button data-action="prison-selected" class="ldn-btn">⛓ Send selected → Prison</button>
        <button data-action="escape-selected" class="ldn-btn">🗝 Escape card</button>
      </div>
      <div class="ldn-hint">Select a token on the canvas first, then click. Works for any token (even one just dropped in).</div>

      <hr>
      <div class="ldn-section-title">Portals (d8 destinations)</div>
      <div class="ldn-buttons">
        <button data-action="portal-randomize" class="ldn-btn">🎲 Randomize numbers</button>
      </div>
      <div class="ldn-portals">${portalRows}</div>
      <div class="ldn-hint">Numbers show on the map. Stepping onto a portal prompts a d8 → flings the token to the portal with that number.</div>

      <hr>
      <div class="ldn-overlay-controls">
        <div class="ldn-status-row">
          <span>On-screen overlay:</span>
          <button data-action="overlay-toggle" class="ldn-btn ${d.overlayOn ? 'sel' : ''}">${d.overlayOn ? '👁 Visible' : '🚫 Hidden'}</button>
        </div>
        <label>Overlay opacity:
          <input type="range" data-cfg-overlay="overlayOpacity" min="0.05" max="1" step="0.05" value="${d.overlayOpacity}">
        </label>
        <div class="ldn-status-row"><span>Output mode:</span> <strong>${d.outputMode}</strong></div>
      </div>

      <hr>
      <div class="ldn-section-title">Scene setup</div>
      <div class="ldn-status-row">
        <span>Maze scene:</span>
        <strong>${d.mazeSceneSet ? d.mazeSceneName : '⚠ not set (shows on every scene)'}</strong>
      </div>
      <div class="ldn-buttons">
        <button data-action="set-maze-scene" class="ldn-btn ${d.isMazeScene && d.mazeSceneSet ? 'sel' : ''}">📍 Use THIS scene</button>
        ${d.mazeSceneSet ? `<button data-action="clear-maze-scene" class="ldn-btn">Clear</button>` : ''}
      </div>
      <div class="ldn-hint">Open your Act 2 maze scene, then click "Use THIS scene" so the overlays only appear there.</div>
      <div class="ldn-buttons" style="margin-top:8px">
        <button data-action="build-walls" class="ldn-btn">🧱 Build Maze Walls</button>
      </div>
      <div class="ldn-hint">Uses grid offset (${d.offX}, ${d.offY}). Set both to 7 for the Act 2 scene first.</div>
      <div class="ldn-buttons" style="margin-top:8px">
        <button data-action="toggle-history" class="ldn-btn ${d.historyOff ? 'sel' : ''}">${d.historyOff ? '🚫 Move-trails OFF' : '👣 Move-trails ON'}</button>
        <button data-action="clear-history" class="ldn-btn">🧹 Clear trails now</button>
      </div>

      <hr>
      <div class="ldn-section-title">Player view (atmosphere)</div>
      <div class="ldn-buttons">
        <button data-action="atmosphere-toggle" class="ldn-btn ${d.atmosphereOn ? 'sel' : ''}">${d.atmosphereOn ? '🌫 Atmosphere ON' : '⬛ Atmosphere OFF'}</button>
        <button data-action="atmosphere-preview" class="ldn-btn ${d.atmospherePreview ? 'sel' : ''}">${d.atmospherePreview ? '👁 Previewing' : '👁 Preview here'}</button>
        <button data-action="atmosphere-reset" class="ldn-btn">↺ Reset reveal</button>
      </div>
      <div class="ldn-hint">Hedges reveal real map art as players explore; tents/portals are landmarks. Foundry's <strong>Reset Fog</strong> also clears the hedges back to black (then they re-reveal). ↺ resets your own preview now.</div>

      <hr>
      <div class="ldn-led">
        <label>Test:</label>
        <button data-action="led-test-panels" class="ldn-btn">Test Panels</button>
        <button data-action="led-test-rainbow" class="ldn-btn">Rainbow</button>
        <button data-action="led-clear" class="ldn-btn">Clear</button>
        <span class="ldn-led-status">${d.bridgeOn ? (d.bridgeConnected ? '🟢 bridge' : '🔴 bridge') : '🖥 overlay'}</span>
      </div>
    </div>
  `;
}

function openPanel() {
  if (!panel) panel = new HordePanel();
  panel.render(true); // brings to front; preserves position if already open
}

// Re-render the panel in place (keeps position) if it's open.
function refreshPanel() {
  if (panel?.rendered) panel.render(false);
}

function handlePanelAction(action) {
  switch (action) {
    case "start": startHorde(); return;
    case "advance": autoAdvanceHorde(); return;
    case "stop": horde.stop(); persistHorde(); led.render(); refreshPanel(); return;
    case "reset": horde.reset(); persistHorde(); led.render(); refreshPanel(); return;
    case "mode-split": horde.mode = "split"; persistHorde(); led.render(); refreshPanel(); return;
    case "mode-together": horde.mode = "together"; persistHorde(); led.render(); refreshPanel(); return;
    case "sprint": horde.addSprint(1); persistHorde(); led.render(); refreshPanel(); return;
    case "sprint-down": horde.addSprint(-1); persistHorde(); led.render(); refreshPanel(); return;
    case "sprint-clear": horde.clearSprints(); persistHorde(); led.render(); refreshPanel(); return;
    case "refresh": refreshPlayers(); refreshPanel(); return;
    case "overlay-toggle": toggleOverlay(); return;
    case "prison-selected": sendSelectedToPrison(); return;
    case "escape-selected": escapeCardForSelected(); return;
    case "portal-randomize": randomizePortalNumbers(); return;
    case "build-walls": buildMazeWalls(); return;
    case "toggle-history":
      game.settings.set(MODULE_ID, "disableMovementHistory", !getSetting("disableMovementHistory", true))
        .then(() => refreshPanel());
      return;
    case "clear-history": clearAllMovementHistory(); return;
    case "atmosphere-toggle":
      game.settings.set(MODULE_ID, "atmosphereEnabled", !getSetting("atmosphereEnabled", true))
        .then(() => refreshPanel());
      return;
    case "atmosphere-preview":
      game.settings.set(MODULE_ID, "atmospherePreviewGM", !getSetting("atmospherePreviewGM", false))
        .then(() => refreshPanel());
      return;
    case "atmosphere-reset": if (atmosphere) atmosphere.resetReveal(); return;
    case "set-maze-scene":
      game.settings.set(MODULE_ID, "mazeSceneId", canvas?.scene?.id ?? "");
      return;
    case "clear-maze-scene":
      game.settings.set(MODULE_ID, "mazeSceneId", "");
      return;
    case "led-test-panels": led.test("panels"); return;
    case "led-test-rainbow": led.test("rainbow"); return;
    case "led-clear": led.clear(); return;
  }
}

function handlePlayerAction(action, name) {
  const token = findTokenByName(name);
  switch (action) {
    case "charm-inc": adjustCharm(name, 1); return;
    case "charm-dec": adjustCharm(name, -1); return;
    case "portal":
      if (!token) return ui.notifications.warn(`No token named "${name}" on the scene.`);
      portalTeleport(token); return;
  }
}

// ============ SCENE CONTROL BUTTONS (v12 array / v13 record compatible) ============
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;

  const isTokenCtl = (c) => c?.name === "token" || c?.name === "tokens";
  const tokenCtl = Array.isArray(controls)
    ? controls.find(isTokenCtl)
    : (controls.tokens ?? controls.token ?? Object.values(controls).find(isTokenCtl));
  if (!tokenCtl || !tokenCtl.tools) return;

  const hordeTool = {
    name: "ldn-horde",
    title: "La Dolce Notte — Horde Control",
    icon: "fas fa-theater-masks",
    button: true,
    onClick: () => openPanel(),
    onChange: () => openPanel(),
  };
  const overlayTool = {
    name: "ldn-overlay",
    title: "Toggle LED Overlay (Shift+O)",
    icon: "fas fa-border-all",
    toggle: true,
    active: overlay?.visible ?? true,
    onClick: () => toggleOverlay(),
    onChange: () => toggleOverlay(),
  };

  if (Array.isArray(tokenCtl.tools)) {
    tokenCtl.tools.push(hordeTool, overlayTool);
  } else {
    let order = Object.keys(tokenCtl.tools).length;
    tokenCtl.tools[hordeTool.name] = { ...hordeTool, order: order++ };
    tokenCtl.tools[overlayTool.name] = { ...overlayTool, order: order++ };
  }
});
