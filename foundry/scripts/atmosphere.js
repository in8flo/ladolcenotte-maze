// La Dolce Notte — Atmosphere Layer (player-facing)
// Draws maze structure + point-of-interest hints ABOVE Foundry's fog/vision, so
// players sense the map's design and where to explore — without the map being
// fully revealed. This COMPLEMENTS Foundry's vision; it does not replace it.
//
//  • Hedges fade in near explored corridors (progressive structure).
//  • The entry is structure-revealed from the start (tokens spawn there).
//  • Tents + portals pulse as hints above the fog, and a hint disappears once a
//    token actually gains line of sight to it (Foundry then reveals the real art).

import { GRID_SIZE, MAZE, CELL, COLORS, findCells } from "./maze-data.js";

const MODULE_ID = "ladolcenotte-maze";
const NEIGHBORS8 = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
const HEDGE_RGB = [46, 74, 48]; // muted hedge green for the silhouette

function gset(key, fallback) {
  try { const v = game.settings.get(MODULE_ID, key); return v ?? fallback; } catch { return fallback; }
}

export class Atmosphere {
  constructor() {
    this.container = null;
    this.hedgeG = null;       // graphics: revealed hedge silhouettes
    this.poiG = null;         // graphics: pulsing POI hints
    this.visible = true;
    this.phase = 0;
    this.tickCount = 0;
    this.revealedHedges = new Set(); // "r,c" wall cells shown as structure
    this.seenCorridors = new Set();  // "r,c" walkable cells already processed
    this.portalCells = [];           // [[r,c], …] eligible portals (set by main)
    this.poiVisible = {};            // "r,c" -> currently in line of sight?
    this._pois = null;               // cached static POI list (tents + portals)
    this._seeded = false;
  }

  get offsetX() { return gset("gridOffsetX", 0); }
  get offsetY() { return gset("gridOffsetY", 0); }

  setPortalCells(cells) {
    this.portalCells = Array.isArray(cells) ? cells : [];
    this._pois = null; // invalidate cache
  }

  // Static (always-shown) hint POIs: the five tents + the eligible portals.
  pois() {
    if (this._pois) return this._pois;
    const list = [];
    const tents = [
      [CELL.SAL, COLORS.SAL], [CELL.ELEANOR, COLORS.ELEANOR], [CELL.EVERLY, COLORS.EVERLY],
      [CELL.LAVINIA, COLORS.LAVINIA], [CELL.RUPERT, COLORS.RUPERT],
    ];
    for (const [type, color] of tents) {
      const center = this.centerOf(findCells(type));
      if (center) list.push({ row: center[0], col: center[1], color, kind: "tent" });
    }
    for (const [r, c] of this.portalCells) {
      list.push({ row: r, col: c, color: COLORS.PORTAL, kind: "portal" });
    }
    this._pois = list;
    return list;
  }

  centerOf(cells) {
    if (!cells.length) return null;
    let sr = 0, sc = 0;
    for (const [r, c] of cells) { sr += r; sc += c; }
    return [Math.round(sr / cells.length), Math.round(sc / cells.length)];
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
    this.hedgeG = new PIXI.Graphics();
    this.poiG = new PIXI.Graphics();
    this.container.addChild(this.hedgeG, this.poiG);

    const parent = canvas.interface ?? canvas.stage;
    parent.sortableChildren = true;
    parent.addChild(this.container);

    this.seedEntry();
    this.recompute(); // draws hedges + pois (keeps accumulated reveal across re-attach)
  }

  detach() {
    if (this.container) {
      this.container.parent?.removeChild(this.container);
      try { this.container.destroy({ children: true }); } catch (_) { /* ignore */ }
    }
    this.container = null; this.hedgeG = null; this.poiG = null;
  }

  setVisible(v) {
    this.visible = !!v;
    if (this.container) this.container.visible = this.visible;
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

  // Scan unseen corridors; reveal hedges near any that are now visible. Each
  // corridor is tested only until first seen, so the scan shrinks over time.
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
    for (const poi of this.pois()) {
      const { x, y, w, h } = this.cellRect(poi.row, poi.col);
      this.poiVisible[`${poi.row},${poi.col}`] = this.isVisible(x + w / 2, y + h / 2);
    }
    if (changed) this.drawHedges();
    this.drawPois();
  }

  fillRect(g, x, y, w, h, color, alpha) {
    if (typeof g.beginFill === "function") { g.beginFill(color, alpha); g.drawRect(x, y, w, h); g.endFill(); }
    else g.rect(x, y, w, h).fill({ color, alpha });
  }

  drawHedges() {
    if (!this.hedgeG || this.hedgeG.destroyed) return;
    const g = this.hedgeG;
    g.clear();
    const color = (HEDGE_RGB[0] << 16) + (HEDGE_RGB[1] << 8) + HEDGE_RGB[2];
    for (const key of this.revealedHedges) {
      const [r, c] = key.split(",").map(Number);
      const { x, y, w, h } = this.cellRect(r, c);
      this.fillRect(g, x, y, w, h, color, 0.5);
    }
  }

  drawPois() {
    if (!this.poiG || this.poiG.destroyed) return;
    const g = this.poiG;
    g.clear();
    const pulse = 0.5 + 0.5 * Math.sin(this.phase); // 0..1
    for (const poi of this.pois()) {
      if (this.poiVisible[`${poi.row},${poi.col}`]) continue; // revealed → hint done
      const { x, y, w, h } = this.cellRect(poi.row, poi.col);
      const color = (poi.color[0] << 16) + (poi.color[1] << 8) + poi.color[2];
      const alpha = 0.18 + 0.34 * pulse; // 0.18 .. 0.52
      if (poi.kind === "tent") this.drawDiamond(g, x + w / 2, y + h / 2, w * 0.42, color, alpha);
      else this.fillRect(g, x, y, w, h, color, alpha);
    }
  }

  drawDiamond(g, cx, cy, r, color, alpha) {
    const pts = [cx, cy - r, cx + r, cy, cx, cy + r, cx - r, cy];
    if (typeof g.beginFill === "function") { g.beginFill(color, alpha); g.drawPolygon(pts); g.endFill(); }
    else g.poly(pts).fill({ color, alpha });
  }

  tick() {
    this.phase += 0.18;
    if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
    this.tickCount++;
    if (this.tickCount % 5 === 0) this.recompute(); // periodic reveal refresh
    else this.drawPois();
  }
}
