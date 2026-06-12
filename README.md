# La Dolce Notte — LED Maze System

Complete physical-digital combat system for Act 2. Foundry VTT drives RGB LEDs
under the physical maze, tracks the Bliss Horde, handles portals, sprites,
prison, and Swarm Tactics.

```
ledmaze/
├── CONFIG.md              ← shared constants (read this first)
├── README.md             ← you are here
├── firmware/
│   └── code.py           ← flash to each Pico (set PANEL_ID 0-3)
├── bridge/
│   └── bridge.py         ← run on laptop, bridges Foundry ↔ Picos
└── foundry/
    ├── module.json
    ├── scripts/
    │   ├── main.js        ← module entry, DM panel, hooks
    │   ├── horde.js       ← horde engine
    │   ├── led-controller.js ← LED state calc + WebSocket client
    │   └── maze-data.js   ← the 25×25 grid + colors
    └── styles/maze.css
```

---

## Setup (one-time)

### 1. Flash the 4 Picos

For each Pico (panel 0, 1, 2, 3):

1. Install CircuitPython 10.x on the Pico (drag the UF2 while holding BOOTSEL).
2. Copy the `neopixel` and `adafruit_pixelbuf` libraries to the Pico's `lib/` folder.
3. Open `firmware/code.py`, change `PANEL_ID = 0` to the right number (0-3).
4. Save it to the Pico as `code.py`.
5. On boot, each Pico blinks green (PANEL_ID + 1) times so you can identify it.

Wiring per Pico: data wire from **GP1** to the strip's DIN, plus 5V and GND from
the ALITOVE power supply (not from the Pico — the Pico only sends data).

### 2. Install the bridge

On the DM laptop:

```bash
pip install websockets pyserial
```

Find your Pico serial ports:

```bash
python -m serial.tools.list_ports
```

Edit `bridge/bridge.py` → `SERIAL_PORTS` to match (COM3/COM4... on Windows,
/dev/ttyACM0... on Mac/Linux).

### 3. Install the Foundry module

1. Copy the `foundry/` folder into Foundry's `Data/modules/ladolcenotte-maze/`.
2. In Foundry: Manage Modules → enable "La Dolce Notte — Maze & Horde".
3. The Act 2 scene grid must align 1:1 with the maze (25×25, one grid cell per
   tile). Token (x, y) maps to (row, col) via the grid size.

> Hosting on **The Forge** instead of local Foundry? Install via a manifest URL —
> see **`PACKAGING.md`** to publish the repo and **`TESTING-FORGE.md`** for the
> full test walkthrough.

---

## Testing without LEDs (on-screen overlay)

The module's output is decoupled from the hardware. An **LED output mode** world
setting controls where the computed LED state goes:

| Mode | What it does |
|------|--------------|
| **Overlay only** (default) | Draws the LED state as translucent squares on the Foundry canvas. No bridge, no LEDs, no errors when the bridge is absent. Use this to test the whole encounter on The Forge. |
| **Overlay + LED bridge** | On-screen overlay *and* physical LEDs. |
| **LED bridge only** | Physical LEDs only (original behavior). |

The overlay shows **exactly** what the LEDs would show — the same cell→color map
feeds both. Toggle it with the **▦ button** in the token tools, the **Shift+O**
hotkey, or the 🎭 panel.

**Alignment:** if the overlay doesn't sit on the maze art, set **Maze grid
offset — X/Y (cells)** in the module settings, and enable **Debug: log token
cells** to print each token's computed `(row, col)` to the console. Full steps in
`TESTING-FORGE.md`.

---

## Running a session

1. **Start the bridge** on the laptop: `python bridge/bridge.py`
   You'll see "X/4 panels connected".
2. **Open Foundry**, load the Act 2 scene. The module connects to the bridge
   automatically (look for "LED bridge connected").
3. **Test the LEDs**: open the 🎭 Horde Control panel (token scene controls),
   click "Test Panels" — each row band lights a different color. Then "Clear".
4. **Place player tokens** on the maze. Their positions light up in their colors.
5. **Run combat** in Foundry's tracker as normal.
6. **Unleash the horde** when the moment is right: click "🌊 Start Horde".
   - After the start delay, the horde advances automatically each round.
   - The advancing green wall shows on the LEDs.
   - Use "Advance Now", "Pause", or "+1 Manual Sprint" for control.
7. **Sprite sprints** trigger automatically when a player token crosses a sprite.
8. **Swarm Tactics**: when a player starts their turn inside the horde, a dialog
   pops up to roll the DC 13 Wisdom save and apply the consequence.

---

## DM Control Panel

Open via the 🎭 button in the token scene controls.

| Control | What it does |
|---------|--------------|
| 🌊 Start Horde | Unleashes the horde at the south edge |
| ⏭ Advance Now | Manually advance one round |
| ⏸ Pause | Stops auto-advancement |
| ↺ Reset | Returns horde off-map, clears state |
| Split / Together | Switches speed mode |
| +1 Manual Sprint | Adds a one-time sprint bonus next round |
| 🔄 Sync Players | Re-reads all token positions |
| Test Panels / Rainbow / Clear | LED diagnostics |
| Config fields | Start delay, speeds, sprite sprint, save DC — all live-editable |

---

## Horde Mechanics

- **Occupation:** solid wall filling entire rows, advancing north from row 24.
- **Start delay:** configurable rounds before it moves (default 2).
- **Split mode:** 3 rows/round (default). **Together mode:** 4 rows/round.
- **Sprite sprint:** +1 row when a player crosses a sprite (configurable).
- **Swarm Tactics:** start your turn in the horde → DC 13 Wisdom save → on fail,
  DM picks 2d6 psychic OR charmed (move deeper).

All numbers are live-editable in the panel and persist between sessions.

---

## Troubleshooting

**Bridge says 0/4 panels connected** — check `SERIAL_PORTS` matches your system,
and that the Picos are plugged in and running `code.py`. The bridge still runs in
"dry-run" mode (logs state, no LEDs) so you can test Foundry separately.

**LEDs don't match positions** — verify the Foundry scene grid is 25×25 with one
cell per tile, and the scene's grid origin is at the top-left of the maze. Use
"Test Panels" to confirm the row bands light in the right place.

**Wrong panel lights up** — the PANEL_ID in each Pico's `code.py` must match its
physical row band (0 = top 7 rows, 1-3 = next 6 each). Re-flash if needed.

**Portal pulse stutters** — the 10fps tick may lag on a busy scene. Lower the
animation rate in `main.js` (`setInterval(..., 100)` → larger number).
