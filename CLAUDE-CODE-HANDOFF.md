# Claude Code Handoff — La Dolce Notte Maze Module (Foundry Test Phase)

**Goal:** Get the La Dolce Notte maze/horde module running and testable in
Foundry VTT hosted on **The Forge**, with **on-screen visual feedback only**
(no physical LEDs yet). The DM (Mike) needs to test horde advancement, player
tracking, sprite sprints, and Swarm Tactics before the LED hardware is wired.

**Source code:** All module code is in `ledmaze/foundry/`. It's complete but
was written assuming local Foundry + a live LED bridge. This phase decouples it
from the hardware and adds an on-screen visual overlay so Mike can see the game
state without LEDs.

---

## Context you need

- **Game:** D&D 5e one-shot, "La Dolce Notte: A Midnight Toast", running June 27 2026.
- **Act 2** is a maze chase: players navigate a 25×25 hedge maze while the
  "Bliss Horde" advances as a wall of green from the south, trying to reach
  Sal's tent (and the players) before they escape.
- **Hosting:** Foundry on The Forge (cloud). The DM runs the module in their
  browser. Players have their own browser clients.
- **Physical build (LATER):** a 3D-printed maze with WS2812B LEDs underneath,
  driven by 4 Pico controllers via a local Python bridge. NOT part of this phase.

---

## The core architecture (already built — don't redesign)

```
Foundry module (GM browser)
    │  computes cell colors: { "row,col": [r,g,b] }
    ├─→ [PHASE 1: on-screen overlay]  ← BUILD THIS
    └─→ [PHASE 2: WebSocket → Python bridge → LEDs]  ← already written, test later
```

The module already separates **game logic** (horde, players, sprites) from
**output** (currently a WebSocket LED client). The key insight: the module emits
an abstract "LED state" — a map of grid cells to RGB colors. Right now that goes
to a WebSocket. For testing, we want that SAME state drawn as an overlay on the
Foundry canvas so Mike sees exactly what the LEDs would show.

---

## What to build in this phase

### Task 1: On-screen LED overlay (PIXI canvas layer)

Create a visual overlay that draws the computed LED state directly on the Foundry
scene. This replaces the need for physical LEDs during testing.

- Add a new file `foundry/scripts/overlay.js`.
- Draw a 25×25 grid of translucent colored squares over the maze scene, one per
  cell, colored by the LED state map the module already computes in
  `led-controller.js`.
- The overlay should update every time `LedController.render()` is called.
- Refactor `led-controller.js` so `render()` computes the cell→color map ONCE,
  then dispatches it to BOTH the WebSocket (if connected) AND the overlay.
  Right now `render()` sends straight to WebSocket; extract the color computation
  into a method like `computeLedState()` that returns the map, then have both
  outputs consume it.
- Overlay squares should be ~40-50% opacity so the maze art shows through.
- Add a toggle (button in the DM panel or a hotkey) to show/hide the overlay.

### Task 2: Grid alignment + token→cell mapping

The module maps token (x,y) pixel position to maze (row, col) via
`Math.floor(token.x / grid.size)`. This assumes the scene grid's origin (0,0) is
the top-left corner of the maze and the maze fills the grid 1:1.

- Verify/adjust `tokenToCell()` in `main.js` for the actual Act 2 scene.
- The Act 2 scene may have padding/offset. Add configurable offset settings
  (gridOffsetX, gridOffsetY in cells) so the maze can be positioned anywhere
  on the scene and still map correctly.
- Add a debug mode that logs each token's computed (row, col) when it moves, so
  Mike can confirm alignment.

### Task 3: Decouple from LED bridge for testing

- Make the WebSocket connection optional and non-blocking. If the bridge isn't
  running (which it won't be during this phase), the module should work fully
  with just the overlay — no errors, no hangs.
- The existing code already guards WebSocket sends behind `this.connected`, but
  verify there are no places where a missing bridge breaks the game logic.
- Add a setting "LED output mode": `overlay-only` | `overlay-and-bridge` |
  `bridge-only`. Default to `overlay-only` for this phase.

### Task 4: Package for The Forge

The Forge installs modules via a manifest URL or the Bazaar, not by copying
files. Options:

1. **Manifest URL (recommended):** Host the module files somewhere with a public
   `module.json` manifest URL (GitHub repo + release, or GitHub Pages). Then in
   Forge: Game Settings → Manage Modules → Install Module → paste the manifest URL.
2. **Forge Bazaar upload:** If Mike has a Forge subscription tier that allows
   custom module uploads, package as a zip and upload.

- Set up a GitHub repo for the module with a proper release and manifest URL.
- The `module.json` needs valid `manifest` and `download` URLs pointing to the
  release. Update the existing `module.json` accordingly.
- Provide Mike with the exact manifest URL to paste into Forge.

### Task 5: Test plan + walkthrough doc

Write a short doc Mike follows to test in Forge:

1. Install the module via manifest URL.
2. Enable it on the Act 2 world.
3. Open the Act 2 scene, confirm the overlay appears and aligns with the maze.
4. Drop player tokens, move them, confirm positions light up in the overlay.
5. Open the 🎭 Horde Control panel.
6. Click "Start Horde", advance rounds, watch the green wall climb in the overlay.
7. Move a token across a sprite, confirm the sprint message + faster horde.
8. Move a token into the horde, start its turn, confirm the Swarm Tactics dialog.
9. Confirm all config sliders (speed, delay, DC) work live.

---

## Important constraints

- **Don't change the horde mechanics or game logic.** They're locked and correct.
  Modes, speeds, sprite sprints, Swarm Tactics (DC 13 Wis, 2d6 psychic or charm)
  are all final. Only change the OUTPUT layer (add overlay) and packaging.
- **The LED index mapping lives in the Python bridge, not Foundry.** Don't add
  LED-position logic to the module. The module only ever emits cell→color maps.
  The reason: the physical LED layout (1 or 2 LEDs per tile, positions) isn't
  finalized, and when it is, only `bridge.py` changes.
- **GM-only:** all horde control and LED/overlay logic must stay gated behind
  `game.user.isGM`. Players should never trigger horde advancement or see the
  control panel.
- **Foundry v13** is the target (verified compatible). Forge runs current Foundry.

---

## Files in the handoff

```
ledmaze/foundry/
├── module.json                    ← update manifest/download URLs for Forge
├── scripts/
│   ├── main.js                    ← DM panel, hooks, token tracking
│   ├── horde.js                   ← horde engine (DON'T modify logic)
│   ├── led-controller.js          ← refactor: extract computeLedState()
│   ├── maze-data.js               ← 25×25 maze (verified correct, don't touch)
│   └── overlay.js                 ← NEW: build the on-screen overlay
└── styles/maze.css                ← add overlay toggle styles if needed
```

Also in `ledmaze/`:
- `CONFIG.md` — shared constants (LED layout, colors, horde params)
- `bridge/bridge.py` — Python LED bridge (PHASE 2, don't need it yet)
- `firmware/code.py` — Pico firmware (PHASE 2)

---

## Definition of done for this phase

- [ ] Module installs on The Forge via manifest URL
- [ ] Overlay draws the 25×25 LED state on the Act 2 scene, aligned to the maze
- [ ] Player tokens light their cells in the overlay as they move
- [ ] Horde advances visually as a green wall when unleashed
- [ ] Sprite crossing speeds the horde + posts a message
- [ ] Swarm Tactics dialog fires when a player starts its turn in the horde
- [ ] All config values are live-editable and persist
- [ ] No errors when the LED bridge is absent
- [ ] Mike has a step-by-step test doc and the manifest URL
