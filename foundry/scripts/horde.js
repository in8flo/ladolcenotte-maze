// La Dolce Notte — Horde Engine
// Tracks the Bliss Horde's advance, handles modes, sprite sprints,
// and Swarm Tactics saves.

import { GRID_SIZE, MAZE, CELL, findCells } from "./maze-data.js";

export class HordeEngine {
  constructor() {
    // Configurable parameters (DM can change in the panel)
    this.config = {
      startDelay: 2,        // rounds before the horde begins moving
      splitSpeed: 3,        // rows/round when party is split
      togetherSpeed: 4,     // rows/round when party sticks together
      spriteSprint: 1,      // extra rows when a sprite is crossed
      startRow: 24,         // south edge
      swarmDC: 13,          // Wisdom save DC
      swarmDamage: "2d6",   // psychic damage on failed save
    };

    // Runtime state
    this.active = false;       // has the horde been unleashed?
    this.mode = "split";       // "split" or "together"
    this.frontRow = 25;        // current northernmost occupied row (25 = off-map south)
    this.roundsElapsed = 0;    // rounds since unleash
    this.pendingSprints = 0;   // queued sprite sprint bonuses
    this.spritesCrossed = new Set();  // "r,c" of sprites already triggered
  }

  get speed() {
    return this.mode === "split" ? this.config.splitSpeed : this.config.togetherSpeed;
  }

  // Has the horde reached/passed a given row?
  rowOccupied(row) {
    return this.active && row >= this.frontRow;
  }

  // Cells occupied by the horde (entire rows, solid wall)
  occupiedCells() {
    const cells = [];
    if (!this.active) return cells;
    for (let r = Math.max(0, this.frontRow); r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        cells.push([r, c]);
      }
    }
    return cells;
  }

  // Unleash the horde (DM clicks "Start Horde").
  // The horde starts OFF-MAP (frontRow = GRID_SIZE) and lights up NOTHING until
  // the start delay elapses — at which point it surges onto the south edge.
  start() {
    this.active = true;
    this.frontRow = GRID_SIZE;   // off-map: occupiedCells() is empty during the delay
    this.roundsElapsed = 0;
    this.pendingSprints = 0;
    this.spritesCrossed.clear();
  }

  // Stop/pause the horde
  stop() {
    this.active = false;
  }

  // Reset to pre-combat state
  reset() {
    this.active = false;
    this.frontRow = 25;
    this.roundsElapsed = 0;
    this.pendingSprints = 0;
    this.spritesCrossed.clear();
  }

  // Advance the horde one round. Returns info about what happened.
  advanceRound() {
    if (!this.active) return { moved: false, reason: "not active" };

    this.roundsElapsed++;

    // Still gathering beyond the south edge — NOTHING is on the map yet.
    if (this.roundsElapsed < this.config.startDelay) {
      return {
        moved: false,
        reason: `gathering (${this.roundsElapsed}/${this.config.startDelay})`,
        frontRow: this.frontRow,
      };
    }

    // The round the delay is reached: the horde surges onto the map at the
    // south edge for the first time (it was off-map until now).
    if (this.frontRow >= GRID_SIZE) {
      const sprints = this.pendingSprints;
      this.frontRow = this.config.startRow;
      this.pendingSprints = 0;
      return {
        moved: true,
        appeared: true,
        advance: 0,
        sprints,
        oldRow: GRID_SIZE,
        frontRow: this.frontRow,
        reachedTop: this.frontRow === 0,
      };
    }

    // Subsequent rounds: advance north.
    const advance = this.speed + this.pendingSprints;
    const oldRow = this.frontRow;
    this.frontRow = Math.max(0, this.frontRow - advance);
    const sprints = this.pendingSprints;
    this.pendingSprints = 0;

    return {
      moved: true,
      advance,
      sprints,
      oldRow,
      frontRow: this.frontRow,
      reachedTop: this.frontRow === 0,
    };
  }

  // A player crossed a sprite — queue a sprint bonus (once per sprite)
  triggerSprite(r, c) {
    const key = `${r},${c}`;
    if (this.spritesCrossed.has(key)) return false;
    if (MAZE[r][c] !== CELL.SPRITE) return false;
    this.spritesCrossed.add(key);
    this.pendingSprints += this.config.spriteSprint;
    return true;
  }

  // Manual sprint (DM forces a +1 advance bonus next round)
  addSprint(n = 1) {
    this.pendingSprints += n;
  }

  // Is a token at (row, col) inside the horde? (for Swarm Tactics)
  isInHorde(row, col) {
    return this.rowOccupied(row);
  }

  // Estimate rounds until the horde reaches a given row
  roundsToReach(targetRow) {
    if (!this.active) return null;
    const remainingDelay = Math.max(0, this.config.startDelay - this.roundsElapsed);
    const rowsToGo = this.frontRow - targetRow;
    if (rowsToGo <= 0) return 0;
    return remainingDelay + Math.ceil(rowsToGo / this.speed);
  }

  // Serialize for persistence
  toJSON() {
    return {
      config: this.config,
      active: this.active,
      mode: this.mode,
      frontRow: this.frontRow,
      roundsElapsed: this.roundsElapsed,
      pendingSprints: this.pendingSprints,
      spritesCrossed: [...this.spritesCrossed],
    };
  }

  loadJSON(data) {
    if (!data) return;
    this.config = { ...this.config, ...(data.config || {}) };
    this.active = data.active ?? false;
    this.mode = data.mode ?? "split";
    this.frontRow = data.frontRow ?? 25;
    this.roundsElapsed = data.roundsElapsed ?? 0;
    this.pendingSprints = data.pendingSprints ?? 0;
    this.spritesCrossed = new Set(data.spritesCrossed || []);
  }
}
