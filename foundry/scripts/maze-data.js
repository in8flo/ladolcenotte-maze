// La Dolce Notte — Maze Data
// The 25x25 grid and all feature locations. Shared by all module logic.

export const GRID_SIZE = 25;

// Cell type codes
export const CELL = {
  WALL: 0,
  PATH: 1,
  ENTRY: 2,
  SAL: 3,
  ELEANOR: 4,
  EVERLY: 5,
  LAVINIA: 6,
  RUPERT: 7,
  PORTAL: 8,
  SPRITE: 9,
  PRISON: 10,
};

// The locked 25x25 maze (matches maze_25x25_v1.json)
export const MAZE = [
  [0,0,0,0,0,0,0,0,0,0,0,0,8,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,1,1,9,1,1,0,0,1,1,1,1,1,1,1,0,8,1,1,0,0,9,1,1,0],
  [0,8,0,1,0,1,1,1,1,0,1,3,3,3,1,0,0,0,9,1,1,1,0,8,0],
  [0,0,0,1,0,0,0,1,0,0,1,3,3,3,1,0,1,1,1,0,0,1,0,0,0],
  [0,1,1,1,1,1,0,1,1,1,1,3,3,3,1,0,1,0,0,1,1,1,1,1,0],
  [0,1,6,6,6,1,0,0,0,0,1,1,1,1,1,1,1,0,0,1,7,7,7,1,0],
  [0,1,6,6,6,1,0,1,1,1,0,0,8,0,0,0,0,1,1,1,7,7,7,1,0],
  [0,1,6,6,6,1,1,1,0,1,1,9,1,0,1,0,0,1,0,1,7,7,7,1,0],
  [0,1,1,1,1,1,0,1,0,0,0,1,0,0,1,0,0,1,0,1,1,1,1,1,0],
  [0,0,0,0,0,0,0,1,0,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0],
  [0,0,0,0,1,1,1,9,1,0,0,0,1,0,0,0,1,0,0,0,0,0,0,0,0],
  [0,1,1,1,1,0,0,0,0,0,0,0,1,0,0,0,1,1,1,1,0,1,1,8,0],
  [0,0,1,0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0,1,0,9,0,0,0],
  [0,1,1,1,1,1,0,0,0,1,0,0,0,0,9,1,1,1,0,1,1,1,1,1,0],
  [0,1,4,4,4,1,1,1,1,1,0,8,10,8,0,1,0,8,0,1,5,5,5,1,0],
  [0,1,4,4,4,1,0,0,0,1,0,10,10,10,0,1,0,0,0,1,5,5,5,1,0],
  [0,1,4,4,4,1,0,0,0,1,0,8,10,8,0,1,0,0,0,1,5,5,5,1,0],
  [0,1,1,1,1,1,0,0,0,8,0,0,0,0,0,1,1,1,1,1,1,1,1,1,0],
  [0,0,1,0,0,1,1,1,1,0,0,0,0,1,1,1,0,1,0,0,0,0,0,1,0],
  [0,0,1,1,0,0,0,0,9,1,1,1,0,1,0,0,0,1,0,0,0,1,1,1,0],
  [0,8,0,1,1,1,1,0,1,0,0,1,0,1,0,0,0,9,1,1,1,1,0,0,0],
  [0,1,0,0,0,0,1,0,0,0,0,1,0,1,0,0,0,1,0,1,0,0,0,0,0],
  [0,1,1,1,1,1,1,1,1,1,1,2,2,2,1,1,0,1,0,1,1,1,1,1,0],
  [0,0,0,1,0,0,0,1,0,0,0,2,2,2,0,1,1,1,1,1,0,0,0,8,0],
  [0,0,0,0,0,0,0,0,0,0,0,2,2,2,0,0,0,0,0,0,0,0,0,0,0],
];

// Feature colors (RGB, pre-brightness) — from CONFIG.md
export const COLORS = {
  CORRIDOR: [40, 30, 15],
  HORDE: [0, 255, 40],
  PORTAL: [230, 40, 120],
  SPRITE: [180, 255, 60],
  SAL: [255, 140, 0],
  ELEANOR: [255, 68, 68],
  EVERLY: [33, 150, 243],
  LAVINIA: [124, 110, 224],
  RUPERT: [0, 191, 165],
  PRISON: [255, 23, 68],
  ENTRY: [0, 184, 148],
};

// Per-player marker colors (assign each PC a distinct hue)
export const PLAYER_COLORS = {
  Vis: [255, 255, 255],     // white
  Bob: [255, 200, 0],       // amber
  Lys: [255, 215, 0],       // gold
  Gideon: [139, 90, 43],    // brown/bear
  Carter: [0, 200, 255],    // cyan
};

// Brightness multipliers — from CONFIG.md
export const BRIGHTNESS = {
  CORRIDOR: 0.5,
  HORDE: 0.8,
  PLAYER: 1.0,
  PORTAL: 1.0,
  SPRITE: 0.8,
  TENT: 0.8,
};

// Apply a brightness multiplier to an RGB triple
export function dim(rgb, mult) {
  return [
    Math.round(rgb[0] * mult),
    Math.round(rgb[1] * mult),
    Math.round(rgb[2] * mult),
  ];
}

// Find all cells of a given type
export function findCells(type) {
  const cells = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (MAZE[r][c] === type) cells.push([r, c]);
    }
  }
  return cells;
}

// Is a cell walkable (not a wall)?
export function isWalkable(r, c) {
  if (r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) return false;
  return MAZE[r][c] !== CELL.WALL;
}
