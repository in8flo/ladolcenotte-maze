// La Dolce Notte — LED State Calculator + Output Dispatcher
// Computes the color of every maze cell each frame and dispatches that ONE
// "LED state" map to every enabled output: the on-screen overlay (for testing)
// and/or the Python LED bridge over WebSocket (for the physical build).
//
// The key contract: this module only ever produces an abstract cell -> color
// map ({ "row,col": [r,g,b] }). It knows nothing about physical LED indices —
// that mapping lives in the Python bridge. Outputs are interchangeable consumers
// of the same state.

import {
  GRID_SIZE, MAZE, CELL, COLORS, PLAYER_COLORS, BRIGHTNESS,
  dim,
} from "./maze-data.js";

// Output modes (mirrors the "outputMode" world setting)
export const OUTPUT_MODE = {
  OVERLAY_ONLY: "overlay-only",
  OVERLAY_AND_BRIDGE: "overlay-and-bridge",
  BRIDGE_ONLY: "bridge-only",
};

export class LedController {
  constructor(hordeEngine) {
    this.horde = hordeEngine;

    // Outputs
    this.overlay = null;                       // LedOverlay instance (set by main.js)
    this.outputMode = OUTPUT_MODE.OVERLAY_ONLY;

    // Bridge (WebSocket) state
    this.ws = null;
    this.connected = false;
    this.wsUrl = "ws://localhost:8765";

    // Render state
    this.portalPhase = 0;        // for pulsing portal animation
    this.playerPositions = {};   // name -> [row, col]
    this.enabled = true;
    this.lastState = null;       // most recent computed/dispatched map
    this.testOverride = null;    // when set, render() shows this instead of game state
  }

  // ---- Output-mode helpers ----
  get bridgeEnabled() {
    return this.outputMode === OUTPUT_MODE.OVERLAY_AND_BRIDGE
        || this.outputMode === OUTPUT_MODE.BRIDGE_ONLY;
  }

  get overlayEnabled() {
    return this.outputMode === OUTPUT_MODE.OVERLAY_ONLY
        || this.outputMode === OUTPUT_MODE.OVERLAY_AND_BRIDGE;
  }

  setOutputMode(mode) {
    const prevBridge = this.bridgeEnabled;
    this.outputMode = mode;
    // Bring the bridge up or down to match the new mode.
    if (this.bridgeEnabled && !this.connected) this.connect();
    if (!this.bridgeEnabled && prevBridge) this.disconnect();
    this.render();
  }

  // ---- Bridge connection (fully optional / non-blocking) ----
  connect() {
    // The bridge is hardware-phase only. In overlay-only mode we never open a
    // socket, so a missing bridge can't error, hang, or block the game.
    if (!this.bridgeEnabled) return;
    if (typeof WebSocket === "undefined") return;
    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => {
        this.connected = true;
        console.log("LED bridge connected");
        ui.notifications?.info("LED bridge connected");
        this.render();
      };
      this.ws.onclose = () => {
        this.connected = false;
        console.log("LED bridge disconnected");
      };
      this.ws.onerror = (e) => {
        // Expected during this phase — the bridge isn't running. Stay quiet.
        console.warn("LED bridge unavailable (overlay still works):", e?.message ?? e);
      };
    } catch (e) {
      console.warn("Could not connect to LED bridge (overlay still works):", e);
    }
  }

  disconnect() {
    try { this.ws?.close(); } catch (_) { /* ignore */ }
    this.ws = null;
    this.connected = false;
  }

  send(msg) {
    if (this.bridgeEnabled && this.ws && this.connected) {
      try { this.ws.send(JSON.stringify(msg)); } catch (e) { console.warn("LED bridge send failed:", e); }
    }
  }

  // ---- Player tracking ----
  setPlayer(name, row, col) {
    this.playerPositions[name] = [row, col];
  }

  clearPlayers() {
    this.playerPositions = {};
  }

  // ---- Core: compute the abstract LED state ONCE ----
  // Returns { "row,col": [r,g,b] }. No I/O, no early returns — both outputs
  // consume the exact same result.
  computeLedState() {
    const leds = {};

    // Layer 1: base — walkable cells get ambient, features get their color.
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const cell = MAZE[r][c];
        if (cell === CELL.WALL) continue; // walls stay dark (omitted from the map)

        let color;
        switch (cell) {
          case CELL.PATH:    color = dim(COLORS.CORRIDOR, BRIGHTNESS.CORRIDOR); break;
          case CELL.SAL:     color = dim(COLORS.SAL, BRIGHTNESS.TENT); break;
          case CELL.ELEANOR: color = dim(COLORS.ELEANOR, BRIGHTNESS.TENT); break;
          case CELL.EVERLY:  color = dim(COLORS.EVERLY, BRIGHTNESS.TENT); break;
          case CELL.LAVINIA: color = dim(COLORS.LAVINIA, BRIGHTNESS.TENT); break;
          case CELL.RUPERT:  color = dim(COLORS.RUPERT, BRIGHTNESS.TENT); break;
          case CELL.ENTRY:   color = dim(COLORS.ENTRY, BRIGHTNESS.TENT); break;
          case CELL.PRISON:  color = dim(COLORS.PRISON, BRIGHTNESS.TENT); break;
          case CELL.SPRITE:  color = dim(COLORS.SPRITE, BRIGHTNESS.SPRITE); break;
          case CELL.PORTAL: {
            const pulse = 0.6 + 0.4 * Math.sin(this.portalPhase);
            color = dim(COLORS.PORTAL, BRIGHTNESS.PORTAL * pulse);
            break;
          }
          default: color = dim(COLORS.CORRIDOR, BRIGHTNESS.CORRIDOR);
        }
        leds[`${r},${c}`] = color;
      }
    }

    // Layer 2: horde — a solid green wall overwriting every occupied row.
    if (this.horde?.active) {
      for (const [r, c] of this.horde.occupiedCells()) {
        leds[`${r},${c}`] = dim(COLORS.HORDE, BRIGHTNESS.HORDE);
      }
    }

    // Layer 3: players — brightest, on top.
    for (const [name, pos] of Object.entries(this.playerPositions)) {
      const [r, c] = pos;
      if (r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) continue;
      const color = PLAYER_COLORS[name] || [255, 255, 255];
      leds[`${r},${c}`] = dim(color, BRIGHTNESS.PLAYER);
    }

    return leds;
  }

  // ---- Dispatch: compute once, send to every enabled output ----
  render() {
    if (!this.enabled) return;

    // A test pattern, if active, takes over until cleared.
    const leds = this.testOverride ?? this.computeLedState();
    this.lastState = leds;

    if (this.overlayEnabled && this.overlay) {
      try { this.overlay.draw(leds); } catch (e) { console.warn("Overlay draw failed:", e); }
    }
    if (this.bridgeEnabled && this.connected) {
      this.send({ type: "led_state", leds });
    }
  }

  // ---- Diagnostics ----
  clear() {
    // Drop any test pattern and return to the live game state on every output.
    this.testOverride = null;
    if (this.overlay) this.overlay.clear();
    this.send({ type: "clear" });
    this.render();
  }

  test(pattern) {
    // Build the pattern as an LED-state map so it lights the SAME way on the
    // overlay and (later) the physical LEDs — no separate code path.
    this.testOverride = this.buildTestPattern(pattern);
    this.render();
  }

  buildTestPattern(pattern) {
    const leds = {};
    if (pattern === "panels") {
      // The 4 Pico row-bands (see CONFIG.md), each a distinct color, so the DM
      // can confirm row alignment top-to-bottom.
      const bands = [[0, 6], [7, 12], [13, 18], [19, 24]];
      const colors = [[255, 40, 40], [40, 255, 80], [40, 120, 255], [255, 200, 0]];
      bands.forEach(([a, b], i) => {
        for (let r = a; r <= b; r++) {
          for (let c = 0; c < GRID_SIZE; c++) leds[`${r},${c}`] = colors[i];
        }
      });
    } else if (pattern === "rainbow") {
      for (let r = 0; r < GRID_SIZE; r++) {
        for (let c = 0; c < GRID_SIZE; c++) {
          leds[`${r},${c}`] = hsvToRgb((c / GRID_SIZE) * 360, 1, 1);
        }
      }
    }
    return leds;
  }

  // Animate portals (called on a timer ~10fps from main.js).
  tick() {
    this.portalPhase += 0.15;
    if (this.portalPhase > Math.PI * 2) this.portalPhase -= Math.PI * 2;
    this.render();
  }
}

// HSV (h in degrees, s/v in 0..1) -> [r,g,b] 0..255. Local helper for test patterns.
function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}
