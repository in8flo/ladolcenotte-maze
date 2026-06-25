# LED Bridge — setup & calibration

`bridge.py` connects Foundry (WebSocket) to the Pico (USB serial). Foundry's
module computes the cell→color map; the bridge maps each maze cell to physical
LED indices and drives the strips via the serial-listener firmware.

## Run it

```bash
pip install websockets pyserial

python bridge.py --list-ports        # find the Pico's COM port
python bridge.py --port COM5         # live bridge
python bridge.py                     # no port → dry-run (logs, no LEDs)
```

Then in Foundry (module settings, **Configure Settings → La Dolce Notte**):
- **LED output mode** → `Overlay + LED bridge` (keep the on-screen view too) or
  `LED bridge only`.
- **LED Bridge URL** → `ws://localhost:8765` (default).

Move a token / advance the horde → the bridge logs frames and lights the LEDs.
If the Pico isn't plugged in, the bridge runs dry (no crash) so you can still test
the Foundry side.

## Hardware state

- **1 Pico 2 (non-W)**, quadrants on **GP0, GP2, GP3, GP4, GP5** (GP1 is dead).
- **193 LEDs/quadrant**, 5 quadrants. Each quadrant = 5 grid columns × 25 rows,
  vertical serpentine.
- Only **GP0 + GP2** are wired today. The firmware's `PINS = [board.GP0, board.GP2]`
  — add `board.GP3, board.GP4, board.GP5` as you wire the rest.

## Calibrating the cell → LED map (important)

The mapping is parameterized at the top of `bridge.py`. The 2-1-2 pattern maths to
**190** LEDs/quad, but the strips measured **193** — so the alignment must be
confirmed on the real strips. Use calibration:

```bash
python bridge.py --port COM5 --calibrate
```

Useful commands:
- `walk 0` — steps a single lit LED through quadrant 0's strip (0…192). Watch the
  physical path: it tells you the serpentine **start corner** and **direction**.
- `cell 0 0` / `cell 24 0` / `cell 0 4` — light specific tiles and check they land
  where expected. (Grid is `row, col`; row 0 = top, col 0 = left.)
- `col 0`, `row 0` — light a whole column/row to see a clean line.
- `raw 0 192` — light a raw LED index, ignoring the mapping.

Then adjust the four knobs near the top of `bridge.py` until `cell R C` lights the
right tile:
- `LED_PER_TILE` — the 25-entry 2-1-2 pattern (this is where the missing 3 LEDs
  per quadrant get placed; tweak until `cell` lines up end-to-end).
- `COLUMN_ORDER` — order the strip visits the quadrant's 5 columns.
- `FIRST_RUN_UP` — does the first column run bottom→top or top→bottom.

Send me the `walk 0` behavior (which corner it starts, which way it snakes) and a
couple of `cell` mismatches and I'll lock the pattern in.

## Show tuning

- `--brightness 0.5` — extra dimming on top of the firmware's 0.3.
- `--min 25` — skip cells dimmer than 25 (hides the faint corridor ambient so only
  players / horde / portals light up — keeps the show sparse and fast).
