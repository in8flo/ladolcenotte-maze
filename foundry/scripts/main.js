// La Dolce Notte — Maze & Horde
// Main module: wires up the horde engine, the LED state dispatcher, the
// on-screen overlay, token tracking, and the DM control panel.
//
// Output is decoupled from hardware: by default the module runs "overlay-only"
// so it works fully in Foundry (incl. The Forge) with NO LED bridge present.

import { HordeEngine } from "./horde.js";
import { LedController, OUTPUT_MODE, defaultColorForName } from "./led-controller.js";
import { LedOverlay } from "./overlay.js";
import { GRID_SIZE, MAZE, CELL, findCells } from "./maze-data.js";

const MODULE_ID = "ladolcenotte-maze";

let horde = null;
let led = null;
let overlay = null;
let tickInterval = null;
let panel = null; // HordePanel singleton

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
// Convert a token to its maze (row, col). Uses the token's *document* position
// (the authoritative target) rather than the animated placeable position, so the
// highlight snaps to the destination cell immediately instead of lagging behind.
function tokenToCell(token) {
  const offX = getSetting("gridOffsetX", 0);
  const offY = getSetting("gridOffsetY", 0);
  const doc = token.document ?? token;
  const gs = canvas.grid.size;
  const w = (doc.width ?? 1) * gs;
  const h = (doc.height ?? 1) * gs;
  const cx = doc.x + w / 2;
  const cy = doc.y + h / 2;

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
  // animate:false → instant; ldnSkipTriggers → don't fire sprite sprints on arrival.
  await token.document.update({ x, y }, { animate: false, ldnSkipTriggers: true });
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

  game.keybindings.register(MODULE_ID, "toggleOverlay", {
    name: "Toggle LED overlay",
    hint: "Show/hide the on-screen LED overlay.",
    editable: [{ key: "KeyO", modifiers: ["Shift"] }],
    restricted: true,
    onDown: () => { toggleOverlay(); return true; },
  });
});

Hooks.once("ready", () => {
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

  overlay.attach();

  tickInterval = setInterval(() => led.tick(), 100);

  game.ladolcenotte = {
    horde, led, overlay, openPanel, refreshPlayers, toggleOverlay,
    buildMazeWalls, portalTeleport, sendToPrison,
  };

  refreshPlayers();

  console.log(`${MODULE_ID} | ready (output: ${led.outputMode})`);
  ui.notifications?.info("La Dolce Notte maze module loaded. Use the 🎭 scene control to open the horde panel.");
});

Hooks.on("canvasReady", () => {
  if (!game.user.isGM || !overlay) return;
  overlay.attach();
  refreshPlayers();
});

// ============ TOKEN TRACKING ============
Hooks.on("updateToken", (tokenDoc, changes, options) => {
  if (!game.user.isGM || !led) return;
  if (!("x" in changes || "y" in changes)) return;
  refreshPlayers({ skipTriggers: options?.ldnSkipTriggers === true });
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

    // Sprite crossing → horde sprint (suppressed for programmatic teleports).
    if (!skipTriggers && MAZE[row]?.[col] === CELL.SPRITE) {
      if (horde.triggerSprite(row, col)) {
        ui.notifications?.info(`${name} disturbed a sprite! Horde will sprint +${horde.config.spriteSprint} next round.`);
      }
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

// ============ PORTALS (d8 random teleport) ============
// Eligible portals = every portal cell EXCEPT the topmost one (above Sal's tent).
function eligiblePortalCells() {
  const portals = findCells(CELL.PORTAL); // row-major order
  if (!portals.length) return [];
  // Exclude the topmost portal (smallest row) — the escape portal after Sal's tent.
  let topRow = portals[0][0];
  for (const [r] of portals) topRow = Math.min(topRow, r);
  return portals.filter(([r]) => r !== topRow);
}

async function portalTeleport(token) {
  if (!token) return;
  const [curR, curC] = tokenToCell(token);
  const choices = eligiblePortalCells().filter(([r, c]) => !(r === curR && c === curC));
  if (!choices.length) {
    ui.notifications.warn("No eligible portals found on this maze.");
    return;
  }
  const roll = new Roll("1d8");
  await roll.evaluate({ async: true });
  // The d8 is the players' roll for drama; the destination is chosen at random
  // among the eligible portals (matching "corresponds to one of the portals,
  // chosen randomly").
  const pick = choices[Math.floor(Math.random() * choices.length)];
  await teleportTokenToCell(token, pick[0], pick[1]);

  await roll.toMessage({
    flavor: `<strong>${token.name}</strong> is seized by a portal and dragged through the weave of the maze… (d8)`,
  });
  ChatMessage.create({
    content: `🌀 <strong>${token.name}</strong> tumbles out of a portal elsewhere in the hedges.`,
  });
}

// ============ PRISON (teleport + escape) ============
// The prison is the 3×3 box bounding the red prison cells; center is preferred.
function prisonCellsOrdered() {
  const cells = findCells(CELL.PRISON);
  if (!cells.length) return { center: [15, 12], ordered: [[15, 12]] };
  let minR = 99, maxR = -1, minC = 99, maxC = -1;
  for (const [r, c] of cells) {
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  }
  const center = [Math.round((minR + maxR) / 2), Math.round((minC + maxC) / 2)];
  const box = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) box.push([r, c]);
  const isPrison = (r, c) => MAZE[r]?.[c] === CELL.PRISON;
  // Center first, then the other actual prison (red) cells, then the rest of the box.
  box.sort((a, b) => {
    const score = ([r, c]) => {
      if (r === center[0] && c === center[1]) return 0;
      if (isPrison(r, c)) return 1;
      return 2;
    };
    const sa = score(a), sb = score(b);
    if (sa !== sb) return sa - sb;
    return (Math.abs(a[0] - center[0]) + Math.abs(a[1] - center[1])) -
           (Math.abs(b[0] - center[0]) + Math.abs(b[1] - center[1]));
  });
  return { center, ordered: box };
}

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
    content: `
      <div class="ldn-chat-card">
        <h3>⛓ ${token.name} is dragged to the holding cell</h3>
        <p>Captured and thrown into the iron pen at the maze's heart.</p>
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
  ui.notifications.info(`${token.name} sent to the prison.`);
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
      width: 440,
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
      overlayOn: overlay?.visible,
      overlayOpacity: getSetting("overlayOpacity", 0.5),
      outputMode: getSetting("outputMode", OUTPUT_MODE.OVERLAY_ONLY),
      bridgeOn: led?.bridgeEnabled,
      bridgeConnected: led?.connected,
      offX: getSetting("gridOffsetX", 0),
      offY: getSetting("gridOffsetY", 0),
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
      <button class="ldn-mini" data-player-action="portal" data-name="${p.name}" title="Portal teleport (d8)">🌀</button>
      <button class="ldn-mini" data-player-action="prison" data-name="${p.name}" title="Send to prison">⛓</button>
    </div>`).join("") : `<div class="ldn-empty">No player-character tokens on the scene.</div>`;

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
        <button data-action="sprint" class="ldn-btn">+1 Manual Sprint</button>
        <button data-action="refresh" class="ldn-btn">🔄 Sync Players</button>
      </div>

      <hr>
      <div class="ldn-section-title">Players</div>
      <div class="ldn-players">${playerRows}</div>

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
      <div class="ldn-buttons">
        <button data-action="build-walls" class="ldn-btn">🧱 Build Maze Walls</button>
      </div>
      <div class="ldn-hint">Uses grid offset (${d.offX}, ${d.offY}). Set both to 7 for the Act 2 scene first.</div>

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
    case "refresh": refreshPlayers(); refreshPanel(); return;
    case "overlay-toggle": toggleOverlay(); return;
    case "build-walls": buildMazeWalls(); return;
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
    case "prison":
      if (!token) return ui.notifications.warn(`No token named "${name}" on the scene.`);
      sendToPrison(token); return;
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
