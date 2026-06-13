// La Dolce Notte — Atmosphere Layer (player-facing)
// Reveals slices of the MAP'S OWN ART above Foundry's fog, so players sense the
// maze's design and where to explore — without fully lifting the fog. It does
// this by drawing a copy of the scene background texture, MASKED to just the
// cells we want to show:
//   • hedge cells next to corridors the player has explored (progressive), and
//   • the 3x3 tent areas (revealed from the start as landmarks).
// Portals stay as pulsing colored squares (a deliberate "something's here" hint).
//
// This COMPLEMENTS Foundry's vision; it does not replace it.

import { GRID_SIZE, MAZE, CELL, COLORS, findCells } from "./maze-data.js";

const MODULE_ID = "ladolcenotte-maze";
const NEIGHBORS8 = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];

function gset(key, fallback) {
  try { const v = game.settings.get(MODULE_ID, key); return v ?? fallback; } catch { return fallback; }
}

export class Atmosphere {
  constructor() {
    this.container = null;
    this.artSprite = null;    // a copy of the scene background, masked to revealed cells
    this.artMask = null;      // PIXI.Graphics defining which cells show the art
    this.poiG = null;         // pulsing portal hints
    this.visible = true;
    this.phase = 0;
    this.tickCount = 0;
    this.revealedHedges = new Set(); // "r,c" hedge cells whose art is shown
    this.seenCorridors = new Set();  // "r,c" walkable cells already processed
    this.portalCells = [];           // [[r,c], …] eligible portals (set by main)
    this.poiVisible = {};            // "r,c" -> currently in line of sight?
    this._tentCells = null;          // cached [[r,c], …] of all tent cells
    this._seeded = false;
  }

  get offsetX() { return gset("gridOffsetX", 0); }
  get offsetY() { return gset("gridOffsetY", 0); }

  setPortalCells(cells) { this.portalCells = Array.isArray(cells) ? cells : []; }

  // Every cell occupied by any of the five tents (their 3x3 areas).
  tentCells() {
    if (this._tentCells) return this._tentCells;
    const types = [CELL.SAL, CELL.ELEANOR, CELL.EVERLY, CELL.LAVINIA, CELL.RUPERT];
    const cells = [];
    for (const t of types) cells.push(...findCells(t));
    this._tentCells = cells;
    return cells;
  }

  attach() {
    if (!canvas?.ready) return;
    this.detach();
    this.container = new PIXI.Container();
    this.container.eventMode = "none";
    this.container.interactive = false;
    this.container.interactiveChildren = false;
    this.container.zIndex = 90;            // above fog, below the GM LED overlay (100)
    this.container.visible = this.visible;

    this.poiG = new PIXI.Graphics();
    this.container.addChild(this.poiG);

    // A copy of the scene's background art, clipped (masked) to the revealed
    // cells. Inserted below the portal pulses.
    this.buildArtSprite();

    const parent = canvas.interface ?? canvas.stage;
    parent.sortableChildren = true;
    parent.addChild(this.container);

    this.seedEntry();
    this.buildArtMask(); // draw the already-known hedges + tents right away
    this.recompute();    // then refresh reveal from current vision + draw pois
  }

  detach() {
    if (this.container) {
      this.container.parent?.removeChild(this.container);
      try { this.container.destroy({ children: true }); } catch (_) { /* ignore */ }
    }
    this.container = null; this.artSprite = null; this.artMask = null; this.poiG = null;
  }

  setVisible(v) {
    this.visible = !!v;
    if (this.container) this.container.visible = this.visible;
  }

  // Acquire the scene background texture (sync if already loaded, else load the
  // scene's background source and finish when ready), then build the art sprite.
  buildArtSprite() {
    const tex = canvas.primary?.background?.texture;
    if (tex && tex.valid !== false && (tex.width || tex.baseTexture)) {
      this._makeArtSprite(tex);
      return;
    }
    const src = canvas.scene?.background?.src;
    const loader = foundry?.canvas?.loadTexture ?? (typeof loadTexture === "function" ? loadTexture : null);
    if (src && loader) {
      Promise.resolve(loader(src)).then((t) => {
        if (t && this.container && !this.container.destroyed && !this.artSprite) {
          this._makeArtSprite(t);
          this.buildArtMask();
        }
      }).catch(() => { /* no art available */ });
    }
  }

  _makeArtSprite(tex) {
    if (!this.container || this.container.destroyed) return;
    const r = canvas.dimensions.sceneRect;
    this.artSprite = new PIXI.Sprite(tex);
    this.artSprite.position.set(r.x, r.y);
    this.artSprite.width = r.width;
    this.artSprite.height = r.height;
    this.artMask = new PIXI.Graphics();
    this.artSprite.mask = this.artMask;
    // Keep the art (and its mask) below the portal pulses.
    this.container.addChildAt(this.artMask, 0);
    this.container.addChildAt(this.artSprite, 0);
  }

  cellRect(row, col) {
    const gs = canvas.grid.size;
    const gi = row + this.offsetY, gj = col + this.offsetX;
    if (typeof canvas.grid.getTopLeftPoint === "function") {
      const p = canvas.grid.getTopLeftPoint({ i: gi, j: gj });
      return { x: p.x, y: p.y, w: gs, h: gs };
    }
    return { x: gj * gs, y: gi * gs, w: gs, h: gs };
  }

  isVisible(px, py) {
    try { return canvas.visibility?.testVisibility?.({ x: px, y: py }, { tolerance: 2 }) ?? false; }
    catch { return false; }
  }

  // The entry is visible from the start (player tokens spawn there).
  seedEntry() {
    if (this._seeded) return;
    for (const [r, c] of findCells(CELL.ENTRY)) this.revealCorridor(r, c);
    this._seeded = true;
  }

  revealCorridor(r, c) {
    this.seenCorridors.add(`${r},${c}`);
    for (const [dr, dc] of NEIGHBORS8) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < GRID_SIZE && nc >= 0 && nc < GRID_SIZE && MAZE[nr][nc] === CELL.WALL) {
        this.revealedHedges.add(`${nr},${nc}`);
      }
    }
  }

  // Scan unseen corridors; reveal hedge art near any now visible. Each corridor
  // is tested only until first seen, so the scan shrinks over time.
  recompute() {
    if (!this.container || !canvas?.ready || !canvas.grid) return;
    let changed = false;
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        if (MAZE[r][c] === CELL.WALL) continue;
        const key = `${r},${c}`;
        if (this.seenCorridors.has(key)) continue;
        const { x, y, w, h } = this.cellRect(r, c);
        if (this.isVisible(x + w / 2, y + h / 2)) { this.revealCorridor(r, c); changed = true; }
      }
    }
    for (const [r, c] of this.portalCells) {
      const { x, y, w, h } = this.cellRect(r, c);
      this.poiVisible[`${r},${c}`] = this.isVisible(x + w / 2, y + h / 2);
    }
    if (changed) this.buildArtMask();
    this.drawPois();
  }

  // Fill the mask at every revealed hedge cell + every tent cell, so the art
  // sprite shows the real map there.
  buildArtMask() {
    if (!this.artMask || this.artMask.destroyed) return;
    const g = this.artMask;
    g.clear();
    const fill = (r, c) => {
      const { x, y, w, h } = this.cellRect(r, c);
      if (typeof g.beginFill === "function") { g.beginFill(0xffffff, 1); g.drawRect(x, y, w, h); g.endFill(); }
      else g.rect(x, y, w, h).fill({ color: 0xffffff, alpha: 1 });
    };
    for (const key of this.revealedHedges) { const [r, c] = key.split(",").map(Number); fill(r, c); }
    for (const [r, c] of this.tentCells()) fill(r, c);
  }

  // Pulsing portal hints — hidden once a token has line of sight to that cell.
  drawPois() {
    if (!this.poiG || this.poiG.destroyed) return;
    const g = this.poiG;
    g.clear();
    const pulse = 0.5 + 0.5 * Math.sin(this.phase); // 0..1
    const color = (COLORS.PORTAL[0] << 16) + (COLORS.PORTAL[1] << 8) + COLORS.PORTAL[2];
    const alpha = 0.18 + 0.34 * pulse; // 0.18 .. 0.52
    for (const [r, c] of this.portalCells) {
      if (this.poiVisible[`${r},${c}`]) continue; // revealed → hint done
      const { x, y, w, h } = this.cellRect(r, c);
      if (typeof g.beginFill === "function") { g.beginFill(color, alpha); g.drawRect(x, y, w, h); g.endFill(); }
      else g.rect(x, y, w, h).fill({ color, alpha });
    }
  }

  tick() {
    this.phase += 0.18;
    if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
    this.tickCount++;
    if (this.tickCount % 5 === 0) this.recompute(); // periodic reveal refresh
    else this.drawPois();
  }
}
