// Exports the current Act 2 maze (25x25) + its feature interpretation to
// maze-export.json, for handing off to another tool (e.g. Claude Desktop).
// Reads maze-data.js directly so it's always accurate.
//
//   node export-maze.mjs   ->   writes maze-export.json next to this file.

import { writeFileSync } from "node:fs";
import { GRID_SIZE, MAZE, CELL, COLORS, findCells } from "./foundry/scripts/maze-data.js";

const nameByCode = {
  [CELL.WALL]: "wall_hedge",
  [CELL.PATH]: "path",
  [CELL.ENTRY]: "entry",
  [CELL.SAL]: "tent_sal",
  [CELL.ELEANOR]: "tent_eleanor",
  [CELL.EVERLY]: "tent_everly",
  [CELL.LAVINIA]: "tent_lavinia",
  [CELL.RUPERT]: "tent_rupert",
  [CELL.PORTAL]: "portal",
  [CELL.SPRITE]: "sprite",
  [CELL.PRISON]: "prison",
};

// Single-char symbols for the human-readable ASCII view.
const sym = {
  [CELL.WALL]: "#", [CELL.PATH]: ".", [CELL.ENTRY]: "E",
  [CELL.SAL]: "S", [CELL.ELEANOR]: "N", [CELL.EVERLY]: "V",
  [CELL.LAVINIA]: "L", [CELL.RUPERT]: "R",
  [CELL.PORTAL]: "O", [CELL.SPRITE]: "*", [CELL.PRISON]: "P",
};

const bbox = (cells) => {
  if (!cells.length) return null;
  let minR = 1e9, maxR = -1e9, minC = 1e9, maxC = -1e9;
  for (const [r, c] of cells) {
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  }
  return { minR, maxR, minC, maxC };
};

const prison = bbox(findCells(CELL.PRISON));
const sal = bbox(findCells(CELL.SAL));
const inBox = (r, c, b) => b && r >= b.minR && r <= b.maxR && c >= b.minC && c <= b.maxC;
const nearSal = (r, c) => sal && c >= sal.minC && c <= sal.maxC && r >= sal.minR - 2 && r <= sal.maxR + 2;

const allPortals = findCells(CELL.PORTAL); // row-major
const destinations = allPortals.filter(([r, c]) => !inBox(r, c, prison) && !nearSal(r, c)); // 8
const prisonPortals = allPortals.filter(([r, c]) => inBox(r, c, prison));                   // 4
const inactivePortals = allPortals.filter(([r, c]) => nearSal(r, c));                        // 2

const out = {
  name: "La Dolce Notte — Act 2 Maze",
  gridSize: GRID_SIZE,
  indexing: "cells are [row, col], 0-indexed; row 0 = north (top), col 0 = west (left)",
  legend: Object.fromEntries(Object.entries(nameByCode).map(([code, n]) => [code, n])),
  asciiLegend: {
    "#": "wall / hedge", ".": "path", "E": "entry",
    S: "tent — Sal", N: "tent — Eleanor", V: "tent — Everly",
    L: "tent — Lavinia", R: "tent — Rupert",
    O: "portal", "*": "sprite", P: "prison",
  },
  grid: MAZE, // 25x25 of the numeric codes above (authoritative)
  ascii: MAZE.map((row) => row.map((c) => sym[c]).join("")),
  features: {
    entry: findCells(CELL.ENTRY),
    sprites: findCells(CELL.SPRITE),
    tents: {
      sal: findCells(CELL.SAL),
      eleanor: findCells(CELL.ELEANOR),
      everly: findCells(CELL.EVERLY),
      lavinia: findCells(CELL.LAVINIA),
      rupert: findCells(CELL.RUPERT),
    },
    prison: {
      playerCells: findCells(CELL.PRISON), // the 5 cross cells captives go on
      cornerPortals: prisonPortals,        // 4 corners — outgoing only
    },
    portals: {
      destinations: destinations.map(([r, c], i) => ({ number: i + 1, row: r, col: c })),
      destinationsNote: "Default row-major numbering 1-8. The GM may have randomized these in-game (stored in the Foundry world, not in this file).",
      outgoingOnly: prisonPortals,   // prison corners: stepping in triggers a roll, never a destination
      inactive: inactivePortals,     // above & below Sal's tent: neither a trigger nor a destination
    },
  },
  notes: [
    "This is the abstract 25x25 logic grid. In the Foundry scene the maze is placed at grid offset (7, 7); that offset is a scene-placement detail and is not part of this grid.",
    "Portals total 14 cells: 8 numbered destinations + 4 outgoing-only prison corners + 2 inactive (around Sal's tent).",
  ],
};

const path = new URL("./maze-export.json", import.meta.url);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log("wrote", path.pathname, "—", JSON.stringify(out).length, "bytes");
console.log("destinations:", out.features.portals.destinations.length,
  "prisonPortals:", prisonPortals.length, "inactive:", inactivePortals.length);
