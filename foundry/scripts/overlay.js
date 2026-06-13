// La Dolce Notte — On-Screen LED Overlay
// Draws the module's computed LED state as translucent colored squares directly
// on the Foundry canvas, so the DM sees exactly what the physical LEDs would
// show — no hardware required. This is the testing-phase stand-in for the real
// WS2812B grid; it consumes the SAME cell -> color map the bridge would.
//
// It adds nothing about physical LED layout. It only knows: maze cell -> screen
// rectangle (via the scene grid + a configurable cell offset).

import { GRID_SIZE } from "./maze-data.js";

const MODULE_ID = "ladolcenotte-maze";

export class LedOverlay {
  constructor() {
    this.container = null;     // PIXI.Container attached to the canvas
    this.graphics = null;      // PIXI.Graphics we redraw each frame
    this.visible = true;
    this.opacity = 0.5;        // base alpha (maze art shows through)
    this.lastState = null;     // last drawn LED-state map, for redraws
    this.labelLayer = null;    // PIXI.Container for portal-number labels
    this.portalLabels = [];    // [{ row, col, text }]
  }

  // Configurable maze position on the scene grid (in CELLS), so the maze can
  // sit anywhere and still line up with token -> cell mapping.
  get offsetX() {
    try { return game.settings.get(MODULE_ID, "gridOffsetX") ?? 0; } catch { return 0; }
  }
  get offsetY() {
    try { return game.settings.get(MODULE_ID, "gridOffsetY") ?? 0; } catch { return 0; }
  }

  // (Re)create the PIXI container and attach it to the active canvas. Safe to
  // call repeatedly (e.g. on every canvasReady) — it tears down the old one.
  attach() {
    if (!canvas?.ready) return;
    this.detach();

    this.container = new PIXI.Container();
    this.container.eventMode = "none";          // never intercept pointer events
    this.container.interactive = false;
    this.container.interactiveChildren = false; // DM can still click tokens
    this.container.zIndex = 100;
    this.container.visible = this.visible;

    this.graphics = new PIXI.Graphics();
    this.container.addChild(this.graphics);

    // Portal-number labels live above the colored squares.
    this.labelLayer = new PIXI.Container();
    this.labelLayer.eventMode = "none";
    this.container.addChild(this.labelLayer);

    // Attach to the interface group (above tokens, scene-coordinate space, so
    // it pans/zooms with the map). Fall back to the stage root if needed.
    const parent = canvas.interface ?? canvas.stage;
    parent.sortableChildren = true;
    parent.addChild(this.container);

    if (this.lastState) this.draw(this.lastState);
    this.drawLabels();
  }

  detach() {
    if (this.container) {
      this.container.parent?.removeChild(this.container);
      try { this.container.destroy({ children: true }); } catch (_) { /* ignore */ }
    }
    this.container = null;
    this.graphics = null;
    this.labelLayer = null;
  }

  // Set the portal-number labels to draw on the map: [{ row, col, text }].
  setPortalLabels(labels) {
    this.portalLabels = Array.isArray(labels) ? labels : [];
    this.drawLabels();
  }

  // (Re)build the portal-number text objects at their cell centers.
  drawLabels() {
    if (!this.labelLayer || this.labelLayer.destroyed) return;
    if (!canvas?.ready || !canvas.grid) return;
    for (const child of this.labelLayer.removeChildren()) {
      try { child.destroy(); } catch (_) { /* ignore */ }
    }
    const gs = canvas.grid.size;
    for (const lbl of this.portalLabels) {
      const { x, y, w, h } = this.cellRect(lbl.row, lbl.col);
      const text = new PIXI.Text(String(lbl.text), {
        fontFamily: "Signika, sans-serif",
        fontSize: Math.max(12, Math.round(gs * 0.42)),
        fontWeight: "bold",
        fill: 0xffffff,
        stroke: 0x1a0010,
        strokeThickness: Math.max(2, Math.round(gs * 0.06)),
        align: "center",
      });
      text.anchor.set(0.5);
      text.position.set(x + w / 2, y + h / 2);
      this.labelLayer.addChild(text);
    }
  }

  setVisible(v) {
    this.visible = !!v;
    if (this.container) this.container.visible = this.visible;
  }

  toggle() {
    this.setVisible(!this.visible);
    return this.visible;
  }

  setOpacity(o) {
    const n = Number(o);
    if (!Number.isNaN(n)) this.opacity = Math.max(0.05, Math.min(1, n));
    if (this.lastState) this.draw(this.lastState);
  }

  clear() {
    this.lastState = null;
    if (this.graphics) this.graphics.clear();
  }

  // Maze cell (row, col) -> pixel rectangle on the canvas. Uses Foundry's grid
  // helpers (which already account for scene padding), then applies the manual
  // cell offset. Inverse of main.js tokenToCell(), so squares line up with the
  // cells tokens light.
  cellRect(row, col) {
    const gs = canvas.grid.size;
    const gi = row + this.offsetY;   // grid-row index
    const gj = col + this.offsetX;   // grid-col index
    let x, y;
    if (typeof canvas.grid.getTopLeftPoint === "function") {
      const p = canvas.grid.getTopLeftPoint({ i: gi, j: gj });
      x = p.x; y = p.y;
    } else {
      x = gj * gs; y = gi * gs;
    }
    return { x, y, w: gs, h: gs };
  }

  // Draw an LED-state map: { "row,col": [r,g,b] }.
  draw(ledState) {
    this.lastState = ledState;
    if (!this.container || this.container.destroyed) return;
    if (!canvas?.ready || !canvas.grid) return;
    if (!this.visible) return;
    if (!this.graphics || this.graphics.destroyed) return;

    const g = this.graphics;
    g.clear();

    for (const [key, rgb] of Object.entries(ledState)) {
      const parts = key.split(",");
      const row = Number(parts[0]);
      const col = Number(parts[1]);
      if (row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE) continue;

      const r = rgb[0] | 0, gr = rgb[1] | 0, b = rgb[2] | 0;
      const maxCh = Math.max(r, gr, b);
      if (maxCh <= 0) continue; // unlit cell -> leave the map clean

      // Brightness-weighted alpha: dim "ambient" corridors stay subtle while
      // bright horde/player cells pop — mimicking how real LEDs emit light, and
      // keeping the underlying maze art readable.
      const alpha = this.opacity * (0.3 + 0.7 * (maxCh / 255));
      const color = (r << 16) + (gr << 8) + b;

      const { x, y, w, h } = this.cellRect(row, col);
      // PIXI v7 (Foundry v13) uses beginFill/endFill; guard for a future v8.
      if (typeof g.beginFill === "function") {
        g.beginFill(color, alpha);
        g.drawRect(x, y, w, h);
        g.endFill();
      } else {
        g.rect(x, y, w, h).fill({ color, alpha });
      }
    }
  }
}
