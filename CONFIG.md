# La Dolce Notte — LED Maze System Configuration

**The single source of truth for the physical-digital combat system.**

This document defines the constants every component shares. The firmware, Python bridge, and Foundry module all reference these values. If you change a number here, change it everywhere.

---

## Grid

| Constant | Value |
|----------|-------|
| Grid size | 25 × 25 squares |
| Tile size | 50.8mm (2 inch) |
| LED spacing | 33.3mm (30 LEDs/m) |
| LEDs per row | 38 |
| Total LEDs | 950 |
| LED pattern per row | `[1,2,1,2,1,2,1,2,1,2,2,1,2,1,2,1,2,1,2,1,2,1,2,1,2]` |

The pattern alternates 1-2-1-2 because the 33.3mm LED spacing doesn't divide evenly into 50.8mm tiles. Some tiles get one LED (near center), some get two (near edges). The firmware addresses LEDs by index and doesn't care how many are under each tile.

---

## Panels (4 Picos)

Each Pico drives a horizontal band of rows. The LED strip snakes through each row in a serpentine (even rows left-to-right, odd rows right-to-left).

| Pico | Rows | LEDs | Serial Port (example) |
|------|------|------|----------------------|
| 0 | 0–6 (7 rows) | 266 | COM3 / /dev/ttyACM0 |
| 1 | 7–12 (6 rows) | 228 | COM4 / /dev/ttyACM1 |
| 2 | 13–18 (6 rows) | 228 | COM5 / /dev/ttyACM2 |
| 3 | 19–24 (6 rows) | 228 | COM6 / /dev/ttyACM3 |

Data pin on every Pico: **GP1** (GP0 was non-functional in POC testing).

---

## Serpentine LED Indexing

Within each panel, the LED strip runs continuously:
- **Even rows** (0, 2, 4...): LEDs indexed left-to-right (col 0 → col 24)
- **Odd rows** (1, 3, 5...): LEDs indexed right-to-left (col 24 → col 0)

The global LED index increments continuously through the serpentine. The bridge computes `(row, col) → [led indices]` using this rule.

---

## Brightness Levels

Brightness is baked into color values (Pico global brightness stays at 1.0).

| Element | Brightness | Notes |
|---------|-----------|-------|
| Corridor ambient | 0.5 | Subtle warm glow on walkable cells |
| Horde | 0.8 | Bright green wall |
| Player position | 1.0 | Full brightness marker |
| Portals | 1.0 | Pulsing magenta |
| Sprites | 0.8 | Yellow-green |
| Tent glow | 0.8 | Patron's color |

---

## Colors (RGB, pre-brightness)

| Element | RGB | Hex |
|---------|-----|-----|
| Corridor ambient | (40, 30, 15) | warm dim amber |
| Horde | (0, 255, 40) | bliss green |
| Player (default) | (255, 255, 255) | white |
| Portal | (230, 40, 120) | magenta |
| Sprite | (180, 255, 60) | yellow-green |
| Sal tent | (255, 140, 0) | orange |
| Eleanor tent | (255, 68, 68) | red |
| Everly tent | (33, 150, 243) | blue |
| Lavinia tent | (124, 110, 224) | purple |
| Rupert tent | (0, 191, 165) | teal |
| Prison | (255, 23, 68) | crimson |
| Entry | (0, 184, 148) | green |

Per-player colors can be assigned in the Foundry module (each PC gets a distinct hue).

---

## Horde Mechanics

| Parameter | Default | Configurable |
|-----------|---------|:------------:|
| Start delay (rounds before horde moves) | 2 | ✓ |
| Split mode speed (rows/round) | 3 | ✓ |
| Together mode speed (rows/round) | 4 | ✓ |
| Sprite sprint bonus (rows when sprite crossed) | 1 | ✓ |
| Starting row | 24 (south edge) | ✓ |
| Direction | North (toward row 0) | — |

**Occupation:** The horde fills ALL cells in occupied rows — a solid advancing wall, not just corridors.

**Swarm Tactics** (player starts turn in horde cell):
- DC 13 Wisdom save
- On failure, DM chooses:
  - 2d6 psychic damage, OR
  - Charmed 1 turn — must use movement to go deeper into the horde

---

## Communication Architecture

```
Foundry module (JS)
    │  WebSocket (ws://localhost:8765)
    ▼
Python bridge (bridge.py)
    │  USB serial (per-Pico command stream)
    ▼
4 Pico controllers (CircuitPython)
    │  WS2812B data on GP1
    ▼
LED strips
```

The bridge runs on the DM laptop. Start it once before the session. Foundry connects automatically.

---

## Serial Protocol (Bridge → Pico)

Compact binary frames for speed. Each frame:

```
0xFF 0xFF  <count:2 bytes>  <led_idx:2 bytes> <R> <G> <B> ... 0xFE
```

- Header: `0xFF 0xFF`
- Count: number of LED updates in this frame (uint16, little-endian)
- Each update: led index (uint16 LE) + R + G + B (1 byte each)
- Footer: `0xFE`

A "show" command (`0xFF 0xFF 0x00 0x00 0xFE`, count=0) tells the Pico to latch and display.

---

## WebSocket Protocol (Foundry → Bridge)

JSON messages:

```json
{ "type": "led_state", "leds": { "row,col": [r, g, b], ... } }
{ "type": "horde", "front_row": 18 }
{ "type": "clear" }
{ "type": "test", "pattern": "rainbow" }
```

The bridge converts `(row, col)` cell colors into per-LED commands using the serpentine map.
