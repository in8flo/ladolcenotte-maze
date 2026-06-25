#!/usr/bin/env python
"""
La Dolce Notte - LED Bridge   (Foundry WebSocket  ->  Pico USB serial)

Runs on the DM laptop. The Foundry module computes an abstract cell->color map
and pushes it over WebSocket; this bridge translates each maze cell into physical
LED indices and sends them to the Pico over USB serial, using the proven
serial-listener protocol.

HARDWARE (finalized):
  * ONE Pico 2 (non-W) drives 5 quadrants on GP0, GP2, GP3, GP4, GP5 (GP1 dead).
  * 193 LEDs per quadrant (empirical), 965 total.
  * Each quadrant = 5 grid columns x 25 rows, VERTICAL serpentine (4 U-turns).
  * 2-1-2 LEDs-per-tile (some tiles 1 LED, some 2).

USAGE:
  pip install websockets pyserial
  python bridge.py --list-ports         # find the Pico's COM port
  python bridge.py --port COM5          # run the live bridge
  python bridge.py --port COM5 --calibrate   # interactive mapping/calibration
  python bridge.py                      # no port -> dry-run (logs, no LEDs)

The grid->LED mapping below is PARAMETERIZED. The 2-1-2 pattern maths to 190/quad
but the strips measured 193, so the alignment must be confirmed on hardware --
use --calibrate (the `walk` and `cell` commands) to verify and tweak the four
MAPPING knobs near the top of this file.
"""

import argparse
import asyncio
import json
import sys
import time

try:
    import websockets
except ImportError:
    websockets = None
try:
    import serial
    import serial.tools.list_ports
except ImportError:
    serial = None

# ============================================================ CONFIG
WS_HOST = "localhost"
WS_PORT = 8765
SERIAL_BAUD = 115200

GRID = 25
NUM_QUADRANTS = 5
QUAD_COLS = 5            # grid columns per quadrant (5 cols x 5 quads = 25)
LEDS_PER_QUADRANT = 193  # empirical, per BRIDGE-HANDOFF

# ---- MAPPING KNOBS (confirm these on hardware with --calibrate) ----
# Per-tile LED counts ALONG ONE vertical column run (25 entries, strip order).
# From CONFIG.md's 2-1-2 pattern; sums to 38 -> 5 runs = 190 (vs 193 measured).
LED_PER_TILE = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]
# Order the strip visits the 5 local columns of a quadrant (0=leftmost grid col
# of the quadrant). [0,1,2,3,4] = strip starts at the quadrant's left column.
COLUMN_ORDER = [0, 1, 2, 3, 4]
# Direction of the FIRST run: True = bottom(row 24)->top(row 0); then alternates.
FIRST_RUN_UP = True
# Pin order is implied by the firmware's PINS list (quad 0 = GP0, quad 1 = GP2...).

# ---- Show tuning ----
DEFAULT_BRIGHTNESS = 1.0   # extra scale on top of the colors (firmware also dims)
DEFAULT_MIN = 0            # skip cells whose max channel < this (e.g. 25 hides the
                           # dim corridor ambient so only features/players/horde light)


# ============================================================ MAPPING
class MazeMapping:
    """Builds (and caches) the tile -> LED-index lookup for one quadrant, then
    answers cell_to_leds(row, col) for the whole 25x25 grid."""

    def __init__(self):
        self.quad_map = {}   # (local_col, grid_row) -> [led_index, ...]
        self.total = 0
        self._build()

    def _build(self):
        idx = 0
        for run_i, local_col in enumerate(COLUMN_ORDER):
            up = FIRST_RUN_UP if (run_i % 2 == 0) else (not FIRST_RUN_UP)
            for pos in range(GRID):                 # position along the strip in this run
                grid_row = (GRID - 1 - pos) if up else pos
                count = LED_PER_TILE[pos] if pos < len(LED_PER_TILE) else 1
                self.quad_map[(local_col, grid_row)] = [idx + k for k in range(count)]
                idx += count
        self.total = idx

    def cell_to_leds(self, row, col):
        """-> list of (quadrant, led_index)."""
        if not (0 <= row < GRID and 0 <= col < GRID):
            return []
        q = col // QUAD_COLS
        local_col = col % QUAD_COLS
        if q >= NUM_QUADRANTS:
            return []
        out = []
        for idx in self.quad_map.get((local_col, row), []):
            if 0 <= idx < LEDS_PER_QUADRANT:
                out.append((q, idx))
        return out


# ============================================================ PICO LINK
class Pico:
    """Thin wrapper over the serial-listener firmware. Graceful when absent."""

    def __init__(self, port, baud=SERIAL_BAUD, brightness=DEFAULT_BRIGHTNESS, verbose=False):
        self.brightness = brightness
        self.verbose = verbose
        self.ser = None
        self.tx = 0
        if port and serial is not None:
            try:
                self.ser = serial.Serial(port, baud, timeout=0.05)
                time.sleep(2.0)  # let the board reset/boot
                self.drain()
                print(f"[bridge] connected to Pico on {port}")
            except Exception as e:
                print(f"[bridge] could NOT open {port} ({e}); running dry (no LEDs).")
                self.ser = None
        else:
            why = "no --port given" if not port else "pyserial not installed"
            print(f"[bridge] {why}; running dry (no LEDs).")

    def drain(self):
        if self.ser and self.ser.in_waiting:
            try:
                self.ser.read(self.ser.in_waiting)
            except Exception:
                pass

    def read_response(self, wait=0.3):
        """Read whatever the firmware echoed back, to confirm it's alive."""
        if self.ser is None:
            return ""
        time.sleep(wait)
        try:
            n = self.ser.in_waiting
            return self.ser.read(n).decode(errors="replace").strip() if n else ""
        except Exception as e:
            return f"(read error: {e})"

    def _send(self, line):
        self.tx += 1
        if self.ser is None:
            if self.verbose:
                print(f"[dry] {line}")
            return
        try:
            self.ser.write((line + "\n").encode())
        except Exception as e:
            print(f"[bridge] serial write failed ({e})")

    def pace(self):
        """Flush + brief pause so the Pico can drain its receive buffer between
        chunks of a big frame (prevents overflow / wedging on the first frame)."""
        if self.ser is None:
            return
        try:
            self.ser.flush()
        except Exception:
            pass
        time.sleep(0.006)

    def _scale(self, v):
        return max(0, min(255, int(v * self.brightness)))

    def set_led(self, q, idx, r, g, b):
        self._send(f"{q},{idx},{self._scale(r)},{self._scale(g)},{self._scale(b)}")

    def fill(self, q, r, g, b):
        self._send(f"fill,{q},{self._scale(r)},{self._scale(g)},{self._scale(b)}")

    def all(self, r, g, b):
        self._send(f"all,{self._scale(r)},{self._scale(g)},{self._scale(b)}")

    def clear(self):
        self._send("clear")

    def close(self):
        if self.ser:
            try:
                self.clear()
                self.ser.close()
            except Exception:
                pass


# ============================================================ RENDERER
class Renderer:
    """Consumes Foundry frames; sends only the LEDs that changed."""

    def __init__(self, pico, mapping, min_level=DEFAULT_MIN):
        self.pico = pico
        self.map = mapping
        self.min_level = min_level
        self.last = {}   # (q, idx) -> (r, g, b)

    def on_message(self, data):
        t = data.get("type")
        if t == "led_state":
            self._render(data.get("leds", {}))
        elif t == "clear":
            self.pico.clear()
            self.last = {}
        elif t == "test":
            self._test(data.get("pattern", "panels"))

    def _render(self, leds):
        self.pico.drain()  # discard the firmware's "OK" echoes so the buffer stays clear
        new = {}
        for key, rgb in leds.items():
            try:
                r, c = (int(x) for x in key.split(","))
                cr, cg, cb = (int(rgb[0]), int(rgb[1]), int(rgb[2]))
            except (ValueError, IndexError, TypeError):
                continue
            if max(cr, cg, cb) < self.min_level:
                continue  # treat very-dim cells as off (keeps the show sparse)
            for (q, idx) in self.map.cell_to_leds(r, c):
                new[(q, idx)] = (cr, cg, cb)

        changed = 0
        for k in set(new) | set(self.last):
            val = new.get(k, (0, 0, 0))
            if self.last.get(k, (0, 0, 0)) != val:
                q, idx = k
                self.pico.set_led(q, idx, *val)
                changed += 1
                if changed % 48 == 0:
                    self.pico.pace()  # let the Pico drain between chunks
        self.last = new
        if changed:
            print(f"[bridge] frame: {len(new)} lit, {changed} changed")

    def _test(self, pattern):
        colors = [(255, 40, 40), (40, 255, 80), (40, 120, 255), (255, 200, 0), (200, 60, 220)]
        for q in range(NUM_QUADRANTS):
            self.pico.fill(q, *colors[q % len(colors)])
        self.last = {}


# ============================================================ WEBSOCKET SERVER
async def run_server(renderer, host, port):
    if websockets is None:
        print("[bridge] 'websockets' not installed. Run: pip install websockets pyserial")
        return

    async def handler(websocket, *_):
        print("[bridge] Foundry connected")
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue
                renderer.on_message(data)
        except Exception as e:
            print(f"[bridge] connection error: {e}")
        finally:
            print("[bridge] Foundry disconnected")

    print(f"[bridge] listening for Foundry on ws://{host}:{port}")
    async with websockets.serve(handler, host, port):
        await asyncio.Future()  # run forever


# ============================================================ CALIBRATION
def calibrate(pico, mapping):
    """Interactive REPL to verify/adjust the tile->LED mapping on real hardware."""
    paint = [255, 255, 255]
    print("""
 CALIBRATION — type a command, Enter:
   cell R C        light tile (row R, col C) using the current mapping
   raw Q IDX       light raw LED IDX on quadrant Q (ignores the mapping)
   col C           light grid column C (all 25 rows)  [a vertical line]
   row R           light grid row R   (all 25 cols)   [a horizontal line]
   quad Q          fill quadrant Q
   walk Q [sec]    step one LED through quadrant Q's strip 0..192 (maps order)
   color R G B     set the paint color (default white)
   clear           all off
   info            show mapping totals + knobs
   quit
""")
    while True:
        try:
            line = input("calib> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not line:
            continue
        p = line.split()
        cmd = p[0].lower()
        try:
            if cmd in ("quit", "q", "exit"):
                break
            elif cmd == "clear":
                pico.clear()
            elif cmd == "info":
                print(f"  built {mapping.total} LEDs/quadrant (expected {LEDS_PER_QUADRANT})")
                print(f"  COLUMN_ORDER={COLUMN_ORDER}  FIRST_RUN_UP={FIRST_RUN_UP}")
                print(f"  LED_PER_TILE sum={sum(LED_PER_TILE)}")
            elif cmd == "color":
                paint = [int(p[1]), int(p[2]), int(p[3])]
                print(f"  paint = {paint}")
            elif cmd == "cell":
                pico.clear()
                r, c = int(p[1]), int(p[2])
                leds = mapping.cell_to_leds(r, c)
                for (q, idx) in leds:
                    pico.set_led(q, idx, *paint)
                print(f"  cell ({r},{c}) -> {leds}")
            elif cmd == "raw":
                pico.clear()
                pico.set_led(int(p[1]), int(p[2]), *paint)
            elif cmd == "col":
                pico.clear()
                c = int(p[1])
                for r in range(GRID):
                    for (q, idx) in mapping.cell_to_leds(r, c):
                        pico.set_led(q, idx, *paint)
            elif cmd == "row":
                pico.clear()
                r = int(p[1])
                for c in range(GRID):
                    for (q, idx) in mapping.cell_to_leds(r, c):
                        pico.set_led(q, idx, *paint)
            elif cmd == "quad":
                pico.fill(int(p[1]), *paint)
            elif cmd == "walk":
                q = int(p[1])
                delay = float(p[2]) if len(p) > 2 else 0.15
                for idx in range(LEDS_PER_QUADRANT):
                    pico.clear()
                    pico.set_led(q, idx, *paint)
                    print(f"   q{q} led {idx}")
                    time.sleep(delay)
            else:
                print("  ? unknown command")
            # Show what the firmware echoed/replied — only for commands that actually
            # send something to the Pico.
            if cmd in ("clear", "cell", "raw", "col", "row", "quad", "walk"):
                resp = pico.read_response()
                if resp:
                    print("  pico:", resp.replace("\r", " ").replace("\n", " | "))
                else:
                    print("  pico: (no reply — if the LEDs didn't light either, the "
                          "listener firmware isn't running on this port.)")
        except (IndexError, ValueError):
            print("  ? bad arguments")
    pico.clear()
    print("calibration done.")


# ============================================================ MAIN
def main():
    ap = argparse.ArgumentParser(description="La Dolce Notte LED bridge")
    ap.add_argument("--port", help="Pico serial port, e.g. COM5 (omit for dry-run)")
    ap.add_argument("--baud", type=int, default=SERIAL_BAUD)
    ap.add_argument("--host", default=WS_HOST)
    ap.add_argument("--ws-port", type=int, default=WS_PORT)
    ap.add_argument("--brightness", type=float, default=DEFAULT_BRIGHTNESS,
                    help="extra brightness scale 0..1 (default 1.0)")
    ap.add_argument("--min", type=int, default=DEFAULT_MIN,
                    help="skip cells dimmer than this (e.g. 25 to hide ambient)")
    ap.add_argument("--list-ports", action="store_true", help="list serial ports and exit")
    ap.add_argument("--calibrate", action="store_true", help="interactive mapping/calibration")
    ap.add_argument("--verbose", action="store_true", help="log commands in dry-run")
    args = ap.parse_args()

    if args.list_ports:
        if serial is None:
            print("pyserial not installed. Run: pip install pyserial")
            return
        ports = list(serial.tools.list_ports.comports())
        if not ports:
            print("No serial ports found.")
        for p in ports:
            print(f"  {p.device}  -  {p.description}")
        return

    mapping = MazeMapping()
    if mapping.total != LEDS_PER_QUADRANT:
        print(f"[bridge] NOTE: mapping builds {mapping.total} LEDs/quadrant but the "
              f"strips have {LEDS_PER_QUADRANT}. Confirm the LED_PER_TILE pattern with "
              f"--calibrate (the {LEDS_PER_QUADRANT - mapping.total} extra LEDs need placing).")

    pico = Pico(args.port, args.baud, args.brightness, args.verbose)

    try:
        if args.calibrate:
            calibrate(pico, mapping)
        else:
            renderer = Renderer(pico, mapping, args.min)
            asyncio.run(run_server(renderer, args.host, args.ws_port))
    except KeyboardInterrupt:
        print("\n[bridge] shutting down")
    finally:
        pico.close()


if __name__ == "__main__":
    main()
