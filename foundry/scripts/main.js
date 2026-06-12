// La Dolce Notte — Maze & Horde
// Main module: wires up the horde engine, the LED state dispatcher, the
// on-screen overlay, token tracking, and the DM control panel.
//
// Output is decoupled from hardware: by default the module runs "overlay-only"
// so it works fully in Foundry (incl. The Forge) with NO LED bridge present.

import { HordeEngine } from "./horde.js";
import { LedController, OUTPUT_MODE } from "./led-controller.js";
import { LedOverlay } from "./overlay.js";
import { MAZE, CELL } from "./maze-data.js";

const MODULE_ID = "ladolcenotte-maze";

let horde = null;
let led = null;
let overlay = null;
let tickInterval = null;

// ============ GRID MAPPING ============
// Convert a Foundry token's pixel position to a maze (row, col).
//
// Uses the scene grid (which already accounts for scene padding) and a
// configurable cell offset, so the maze can sit anywhere on the scene and still
// map 1:1. The overlay's cellRect() is the exact inverse of this.
function tokenToCell(token) {
  const offX = getSetting("gridOffsetX", 0);
  const offY = getSetting("gridOffsetY", 0);
  const center = token.center ?? { x: token.x, y: token.y };

  let gi, gj;
  if (canvas?.grid && typeof canvas.grid.getOffset === "function") {
    const o = canvas.grid.getOffset(center); // { i: row, j: col }
    gi = o.i; gj = o.j;
  } else {
    const gs = canvas.grid.size;
    gi = Math.floor(center.y / gs);
    gj = Math.floor(center.x / gs);
  }
  return [gi - offY, gj - offX];
}

function getSetting(key, fallback) {
  try {
    const v = game.settings.get(MODULE_ID, key);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// ============ INITIALIZATION ============
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);

  game.settings.register(MODULE_ID, "hordeState", {
    scope: "world", config: false, type: Object, default: {},
  });

  // --- Output / testing-phase settings ---
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

  // --- Overlay alignment settings ---
  game.settings.register(MODULE_ID, "gridOffsetX", {
    name: "Maze grid offset — X (cells)",
    hint: "Column of the scene grid where the maze's left edge begins. Increase if the overlay sits too far left of the maze art.",
    scope: "world", config: true, type: Number, default: 0,
    onChange: () => { rebuildOverlay(); },
  });
  game.settings.register(MODULE_ID, "gridOffsetY", {
    name: "Maze grid offset — Y (cells)",
    hint: "Row of the scene grid where the maze's top edge begins. Increase if the overlay sits too high above the maze art.",
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

  // --- Keybinding: toggle the overlay (GM only) ---
  game.keybindings.register(MODULE_ID, "toggleOverlay", {
    name: "Toggle LED overlay",
    hint: "Show/hide the on-screen LED overlay.",
    editable: [{ key: "KeyO", modifiers: ["Shift"] }],
    restricted: true, // GM only
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
  led.connect(); // no-op unless a bridge mode is selected

  // Attach the overlay to the current scene and draw the initial state.
  overlay.attach();

  // Portal pulse animation — 10 fps
  tickInterval = setInterval(() => led.tick(), 100);

  // Expose for macros/console
  game.ladolcenotte = { horde, led, overlay, openPanel, refreshPlayers, toggleOverlay };

  refreshPlayers();

  console.log(`${MODULE_ID} | ready (output: ${led.outputMode})`);
  ui.notifications?.info("La Dolce Notte maze module loaded. Use the 🎭 scene control to open the horde panel.");
});

// Re-attach the overlay whenever a scene is (re)drawn — the old PIXI stage is
// destroyed on scene change, so the container must be recreated.
Hooks.on("canvasReady", () => {
  if (!game.user.isGM || !overlay) return;
  overlay.attach();
  refreshPlayers();
});

// ============ TOKEN TRACKING ============
Hooks.on("updateToken", (tokenDoc, changes) => {
  if (!game.user.isGM || !led) return;
  if (!("x" in changes || "y" in changes)) return;
  refreshPlayers();
});

Hooks.on("createToken", () => { if (game.user.isGM) refreshPlayers(); });
Hooks.on("deleteToken", () => { if (game.user.isGM) refreshPlayers(); });

function refreshPlayers() {
  if (!led || !canvas?.tokens) return;
  const debug = getSetting("debugAlignment", false);
  led.clearPlayers();
  for (const token of canvas.tokens.placeables) {
    // Only track player-character tokens
    if (token.actor?.type !== "character") continue;
    const [row, col] = tokenToCell(token);
    const name = token.name;
    led.setPlayer(name, row, col);

    if (debug) {
      console.log(`${MODULE_ID} | ${name} -> row ${row}, col ${col} (px ${Math.round(token.center?.x ?? token.x)}, ${Math.round(token.center?.y ?? token.y)})`);
    }

    // Sprite crossing → horde sprint
    if (MAZE[row]?.[col] === CELL.SPRITE) {
      if (horde.triggerSprite(row, col)) {
        ui.notifications?.info(`${name} disturbed a sprite! Horde will sprint +${horde.config.spriteSprint} next round.`);
      }
    }
  }
  led.render();
}

// ============ COMBAT HOOKS ============
// Advance the horde when the round advances (after the start delay).
Hooks.on("combatRound", (combat, updateData) => {
  if (!game.user.isGM || !horde) return;
  if (!horde.active) return;
  autoAdvanceHorde();
});

// Swarm Tactics: check at the start of each combatant's turn.
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

function autoAdvanceHorde() {
  const result = horde.advanceRound();
  persistHorde();
  led.render();

  if (result.moved) {
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

function promptSwarmTactics(name) {
  new Dialog({
    title: "Swarm Tactics — The Ecstasy",
    content: `
      <div style="padding:8px">
        <p><strong>${name}</strong> begins their turn engulfed by the Bliss Horde.</p>
        <p>They must make a <strong>DC ${horde.config.swarmDC} Wisdom save</strong>.</p>
        <p>On a failure, choose The Ecstasy:</p>
      </div>`,
    buttons: {
      damage: {
        label: `${horde.config.swarmDamage} Psychic`,
        callback: () => {
          const roll = new Roll(horde.config.swarmDamage);
          roll.evaluate({ async: true }).then(r => {
            r.toMessage({ flavor: `${name} resists but the ecstasy burns — psychic damage` });
          });
        },
      },
      charm: {
        label: "Charmed (move deeper)",
        callback: () => {
          ChatMessage.create({
            content: `💜 ${name} is <strong>Charmed</strong> by the Nymph for one turn — they must use their movement to go deeper into the horde.`,
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
  // Keep the scene-control toggle button's state in sync.
  if (ui.controls?.render) ui.controls.render();
  refreshPanel();
}

// Rebuild the overlay container (used when the maze offset changes).
function rebuildOverlay() {
  if (!overlay) return;
  overlay.attach();
  if (led) led.render();
}

// ============ DM CONTROL PANEL ============
function openPanel() {
  const c = horde.config;
  const outputMode = getSetting("outputMode", OUTPUT_MODE.OVERLAY_ONLY);
  const overlayOn = overlay?.visible;
  const bridgeOn = led?.bridgeEnabled;

  const content = `
    <div class="ldn-panel">
      <div class="ldn-status">
        <div class="ldn-status-row">
          <span>Horde:</span>
          <strong class="${horde.active ? 'active' : 'inactive'}">
            ${horde.active ? 'UNLEASHED' : 'dormant'}
          </strong>
        </div>
        <div class="ldn-status-row"><span>Mode:</span> <strong>${horde.mode}</strong></div>
        <div class="ldn-status-row"><span>Front row:</span> <strong>${horde.frontRow >= 25 ? 'off-map' : horde.frontRow}</strong></div>
        <div class="ldn-status-row"><span>Rounds elapsed:</span> <strong>${horde.roundsElapsed}</strong></div>
        <div class="ldn-status-row"><span>Pending sprints:</span> <strong>${horde.pendingSprints}</strong></div>
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
        <button data-action="mode-split" class="ldn-btn ${horde.mode==='split'?'sel':''}">Split party</button>
        <button data-action="mode-together" class="ldn-btn ${horde.mode==='together'?'sel':''}">Together</button>
      </div>

      <hr>
      <div class="ldn-config">
        <label>Start delay (rounds): <input type="number" data-cfg="startDelay" value="${c.startDelay}" min="0" max="10"></label>
        <label>Split speed (rows/rnd): <input type="number" data-cfg="splitSpeed" value="${c.splitSpeed}" min="1" max="10"></label>
        <label>Together speed (rows/rnd): <input type="number" data-cfg="togetherSpeed" value="${c.togetherSpeed}" min="1" max="10"></label>
        <label>Sprite sprint (+rows): <input type="number" data-cfg="spriteSprint" value="${c.spriteSprint}" min="0" max="5"></label>
        <label>Swarm save DC: <input type="number" data-cfg="swarmDC" value="${c.swarmDC}" min="1" max="30"></label>
      </div>

      <hr>
      <div class="ldn-buttons">
        <button data-action="sprint" class="ldn-btn">+1 Manual Sprint</button>
        <button data-action="refresh" class="ldn-btn">🔄 Sync Players</button>
      </div>

      <hr>
      <div class="ldn-overlay-controls">
        <div class="ldn-status-row">
          <span>On-screen overlay:</span>
          <button data-action="overlay-toggle" class="ldn-btn ${overlayOn ? 'sel' : ''}">
            ${overlayOn ? '👁 Visible' : '🚫 Hidden'}
          </button>
        </div>
        <label>Overlay opacity:
          <input type="range" data-cfg-overlay="overlayOpacity" min="0.05" max="1" step="0.05" value="${getSetting("overlayOpacity", 0.5)}">
        </label>
        <div class="ldn-status-row"><span>Output mode:</span> <strong>${outputMode}</strong></div>
      </div>

      <hr>
      <div class="ldn-led">
        <label>Test:</label>
        <button data-action="led-test-panels" class="ldn-btn">Test Panels</button>
        <button data-action="led-test-rainbow" class="ldn-btn">Rainbow</button>
        <button data-action="led-clear" class="ldn-btn">Clear</button>
        <span class="ldn-led-status">${bridgeOn ? (led.connected ? '🟢 bridge connected' : '🔴 bridge offline') : '🖥 overlay'}</span>
      </div>
    </div>
  `;

  const dlg = new Dialog({
    title: "🎭 La Dolce Notte — Horde Control",
    content,
    buttons: { close: { label: "Close" } },
    default: "close",
    render: (html) => {
      html.on("click", "[data-action]", (ev) => {
        const action = ev.currentTarget.dataset.action;
        handlePanelAction(action, html);
      });
      html.on("change", "[data-cfg]", (ev) => {
        const key = ev.currentTarget.dataset.cfg;
        const val = parseInt(ev.currentTarget.value, 10);
        if (!isNaN(val)) {
          horde.config[key] = val;
          persistHorde();
          led.render();
        }
      });
      html.on("input", "[data-cfg-overlay]", (ev) => {
        const val = parseFloat(ev.currentTarget.value);
        if (!isNaN(val)) {
          game.settings.set(MODULE_ID, "overlayOpacity", val);
          if (overlay) overlay.setOpacity(val);
        }
      });
    },
  }, { width: 420, classes: ["ldn-dialog"] });
  dlg.render(true);
}

function getPanelWindow() {
  return Object.values(ui.windows).find(w => w.title?.includes("Horde Control"));
}

// Re-render the panel in place if it's open (after state changes).
function refreshPanel() {
  const dlg = getPanelWindow();
  if (dlg) dlg.close().then(() => openPanel());
}

function handlePanelAction(action, html) {
  let rerender = false;
  switch (action) {
    case "start": horde.start(); ui.notifications.warn("🌊 The Bliss Horde is unleashed!"); rerender = true; break;
    case "advance": autoAdvanceHorde(); return; // autoAdvanceHorde already refreshes the panel
    case "stop": horde.stop(); rerender = true; break;
    case "reset": horde.reset(); rerender = true; break;
    case "mode-split": horde.mode = "split"; rerender = true; break;
    case "mode-together": horde.mode = "together"; rerender = true; break;
    case "sprint": horde.addSprint(1); rerender = true; break;
    case "refresh": refreshPlayers(); break;
    case "overlay-toggle": toggleOverlay(); return; // toggleOverlay refreshes the panel
    case "led-test-panels": led.test("panels"); break;
    case "led-test-rainbow": led.test("rainbow"); break;
    case "led-clear": led.clear(); break;
  }
  persistHorde();
  led.render();
  if (rerender) refreshPanel();
}

// ============ SCENE CONTROL BUTTONS ============
// Works across Foundry v12 (controls/tools are arrays) and v13 (records).
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
