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
  python bridge.py                      # auto-detects the Pico and runs (normal use)
  python bridge.py --calibrate          # auto-detect + interactive mapping/calibration
  python bridge.py --list-ports         # show serial ports (marks the auto-detected Pico)
  python bridge.py --port COM5          # force a specific port (skips auto-detect)
  python bridge.py --dry                # force dry-run (logs, no LEDs)

The grid->LED mapping below is PARAMETERIZED. The 2-1-2 pattern maths to 190/quad
but the strips measured 193, so the alignment must be confirmed on hardware --
use --calibrate (the `walk` and `cell` commands) to verify and tweak the four
MAPPING knobs near the top of this file.
"""

import argparse
import asyncio
import json
import os
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

# ---- EXPLICIT TILE -> LED MAP (hand-measured on the real strips, June 2026) ----
# Mike walked quadrant 0 LED by LED. All 5 quadrants are wired identically, so this
# one map drives every quadrant. Keyed by local column letter (A = the quadrant's
# leftmost grid column .. E = rightmost) and TILE LABEL (1 = bottom row, 25 = top
# row). Each tile lists the LED index(es) physically inside it. Any LED index NOT
# listed sits between two tiles (a boundary / "dead" LED) and is left dark on purpose.
EXPLICIT_QUAD = {
    "A": {25: [0], 24: [1, 2], 23: [3], 22: [4, 5], 21: [6], 20: [7, 8], 19: [9],
          18: [10, 11], 17: [12], 16: [13, 14], 15: [15], 14: [17], 13: [18], 12: [20],
          11: [21], 10: [23], 9: [24], 8: [26], 7: [27], 6: [29], 5: [30, 31], 4: [32],
          3: [33, 34], 2: [35], 1: [36, 37]},
    "B": {1: [38, 39], 2: [40], 3: [41, 42], 4: [43], 5: [44, 45], 6: [46], 7: [48],
          8: [49], 9: [51], 10: [52], 11: [54], 12: [55], 13: [57], 14: [58], 15: [60],
          16: [61], 17: [63], 18: [64], 19: [66], 20: [67, 68], 21: [69], 22: [70, 71],
          23: [72], 24: [73, 74], 25: [75, 76]},
    "C": {25: [77, 78], 24: [79], 23: [80, 81], 22: [82], 21: [83, 84], 20: [85],
          19: [87], 18: [88], 17: [90], 16: [91], 15: [93], 14: [94], 13: [96], 12: [97],
          11: [99], 10: [100], 9: [102], 8: [103], 7: [105], 6: [106, 107], 5: [108],
          4: [109, 110], 3: [111], 2: [112, 113], 1: [114, 115]},
    "D": {1: [116, 117], 2: [118, 119], 3: [120], 4: [121, 122], 5: [123], 6: [124, 125],
          7: [126], 8: [127, 128], 9: [129], 10: [131], 11: [132], 12: [134], 13: [135],
          14: [137], 15: [138], 16: [140], 17: [141], 18: [143], 19: [144, 145],
          20: [146], 21: [147, 148], 22: [149], 23: [150, 151], 24: [152], 25: [153, 154]},
    "E": {25: [155, 156], 24: [157], 23: [158, 159], 22: [160], 21: [161, 162], 20: [163],
          19: [164, 165], 18: [166], 17: [167, 168], 16: [169], 15: [171], 14: [172],
          13: [174], 12: [175], 11: [177], 10: [178], 9: [180], 8: [181], 7: [183],
          6: [184, 185], 5: [186], 4: [187, 188], 3: [189], 2: [190, 191], 1: [192]},
}
COLUMN_LETTERS = ["A", "B", "C", "D", "E"]

# ---- Show tuning ----
DEFAULT_BRIGHTNESS = 1.0   # extra scale on top of the colors (firmware also dims)
DEFAULT_MIN = 0            # skip cells whose max channel < this (e.g. 25 hides the
                           # dim corridor ambient so only features/players/horde light)

# Static green underlay for the interior hedges (the transparent PET-G walls). Dim
# enough that players/horde still pop on top. Tunable with --hedge-color "r,g,b".
DEFAULT_HEDGE_COLOR = (0, 130, 0)
# maze-export.json lives at the repo root, one level up from this bridge/ folder.
DEFAULT_MAZE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "maze-export.json")


def load_hedge_cells(path):
    """Return the set of (row, col) INTERIOR hedge tiles from maze-export.json — the
    walls to light green. The outer wall ring (row/col 0 or 24) is excluded."""
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception as e:
        print(f"[bridge] could not read maze layout ({e}); hedges will be dark.")
        return set()
    grid = data.get("grid", [])
    n = len(grid)
    cells = set()
    for r in range(n):
        row = grid[r]
        for c in range(len(row)):
            if row[c] == 0 and 0 < r < n - 1 and 0 < c < len(row) - 1:
                cells.add((r, c))
    return cells

# Raspberry Pi USB vendor ID — the Pico / CircuitPython board presents this.
PICO_VID = 0x2E8A

# Timestamped file log next to this script — Vegas lesson: console windows get
# closed during recovery, destroying the evidence. Lifecycle events, errors, and
# heartbeats go to the file; per-frame spam stays console-only.
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge-log.txt")


def log(msg, file_only=False):
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    if not file_only:
        print(msg)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{stamp}] {msg}\n")
    except Exception:
        pass  # logging must never take the bridge down


def autodetect_port():
    """Find the Pico's serial port with no hand-typed COM number (handles a
    different laptop where the port is COM7/COM12/whatever). Returns the device
    string, or None if it can't tell."""
    if serial is None:
        return None
    ports = list(serial.tools.list_ports.comports())
    # 1) Best signal: the Raspberry Pi USB vendor ID. Reliable across machines.
    for p in ports:
        if getattr(p, "vid", None) == PICO_VID:
            return p.device
    # 2) Fall back to recognizable descriptions.
    keys = ("circuitpython", "pico", "board cdc", "usb serial device")
    for p in ports:
        desc = (p.description or "").lower()
        if any(k in desc for k in keys):
            return p.device
    # 3) Last resort: if there's exactly one serial port, it's almost certainly it.
    if len(ports) == 1:
        return ports[0].device
    return None


# ============================================================ MAPPING
class MazeMapping:
    """Builds (and caches) the tile -> LED-index lookup for one quadrant, then
    answers cell_to_leds(row, col) for the whole 25x25 grid."""

    def __init__(self):
        self.quad_map = {}   # (local_col, grid_row) -> [led_index, ...]
        self.total = 0
        self._build()

    def _build(self):
        # Build (local_col, grid_row) -> [led] straight from the hand-measured map.
        # grid_row 0 = top (tile label 25); grid_row 24 = bottom (tile label 1).
        for letter, tiles in EXPLICIT_QUAD.items():
            local_col = COLUMN_LETTERS.index(letter)
            for tile_label, leds in tiles.items():
                grid_row = GRID - tile_label   # 25 -> 0 (top), 1 -> 24 (bottom)
                self.quad_map.setdefault((local_col, grid_row), []).extend(leds)
                self.total += len(leds)

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

    def __init__(self, port, baud=SERIAL_BAUD, brightness=DEFAULT_BRIGHTNESS, verbose=False,
                 allow_reopen=True):
        self.brightness = brightness
        self.verbose = verbose
        self.ser = None
        self.tx = 0
        self.port = port
        self.baud = baud
        self.allow_reopen = allow_reopen and serial is not None
        self._reopen_at = 0.0
        if port and serial is not None:
            try:
                self.ser = serial.Serial(port, baud, timeout=0.05)
                time.sleep(2.0)  # let the board reset/boot
                self.drain()
                log(f"[bridge] connected to Pico on {port}")
            except Exception as e:
                log(f"[bridge] could NOT open {port} ({e}); running dry (no LEDs).")
                self.ser = None
        else:
            why = "no --port given" if not port else "pyserial not installed"
            log(f"[bridge] {why}; running dry (no LEDs).")

    def ensure_open(self):
        """Try to (re)open the serial link if it's down — covers USB suspend, a
        replugged Pico (possibly on a NEW COM number), or plugging it in after the
        bridge started. Attempts at most every 5s. Returns True only when a fresh
        connection was just established (caller should force a full repaint)."""
        if self.ser is not None or not self.allow_reopen:
            return False
        now = time.time()
        if now < self._reopen_at:
            return False
        self._reopen_at = now + 5.0
        port = self.port or autodetect_port()
        if not port:
            return False
        try:
            self.ser = serial.Serial(port, self.baud, timeout=0.05)
            time.sleep(2.0)  # board may have rebooted on replug
            self.drain()
            self.port = port
            log(f"[bridge] serial (re)connected on {port}")
            return True
        except Exception:
            self.ser = None
            # The remembered port may be stale (Windows re-enumerates on replug);
            # fall back to auto-detect on the next attempt.
            if self.port == port:
                self.port = None
            return False

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
            # First failure logs once and downs the link; ensure_open() retries
            # every 5s and the renderer forces a full repaint on recovery.
            log(f"[bridge] serial write FAILED ({e}) — link down, retrying every 5s")
            try:
                self.ser.close()
            except Exception:
                pass
            self.ser = None
            self._reopen_at = time.time() + 5.0

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
    """Consumes Foundry frames; sends only the LEDs that changed. A static `base`
    underlay (the green interior hedges) sits beneath every frame and is only
    overwritten where Foundry lights a tile (players, horde, portals...)."""

    def __init__(self, pico, mapping, min_level=DEFAULT_MIN, base=None):
        self.pico = pico
        self.map = mapping
        self.min_level = min_level
        self.base = base or {}   # (q, idx) -> (r, g, b) persistent underlay (hedges)
        self.last = {}           # (q, idx) -> (r, g, b) what's physically lit now
        self._frames = 0         # frames since the last heartbeat log
        self._hb_at = time.time() + 60.0

    def prime(self):
        """Light the static underlay (hedges) once, before any Foundry frame."""
        if self.base:
            self._apply_target(dict(self.base))
            print(f"[bridge] hedge underlay primed: {len(self.base)} LEDs green")

    def _apply_target(self, target):
        """Diff `target` against what's lit and send only the changes. The 'off'
        state for any LED is its base color (green for hedges, black otherwise)."""
        self.pico.drain()  # discard the firmware's "OK" echoes so the buffer stays clear
        changed = 0
        for k in set(target) | set(self.last):
            val = target.get(k, (0, 0, 0))
            if self.last.get(k, (0, 0, 0)) != val:
                q, idx = k
                self.pico.set_led(q, idx, *val)
                changed += 1
                if changed % 48 == 0:
                    self.pico.pace()  # let the Pico drain between chunks
        self.last = target
        return changed

    def on_message(self, data):
        t = data.get("type")
        if t == "led_state":
            self._render(data.get("leds", {}))
        elif t == "clear":
            self._apply_target(dict(self.base))  # revert to the hedge underlay, not black
        elif t == "resync":
            self.resync()
        elif t == "test":
            self._test(data.get("pattern", "panels"))

    def resync(self):
        """Foundry reconnected (or serial came back): wipe the diff cache and
        repaint from scratch so the physical LEDs can't be stale."""
        log("[bridge] resync — full repaint")
        self.pico.clear()
        self.last = {}
        self._apply_target(dict(self.base))

    def _render(self, leds):
        # If the serial link just came back (USB suspend, replug), force a clean
        # slate — the physical strips may show anything from before the outage.
        if self.pico.ensure_open():
            self.pico.clear()
            self.last = {}

        self._frames += 1
        now = time.time()
        if now >= self._hb_at:  # file-only liveness trail for post-session diagnosis
            log(f"[bridge] heartbeat: {self._frames} frames in the last minute, "
                f"serial {'up' if self.pico.ser else 'DOWN'}", file_only=True)
            self._frames = 0
            self._hb_at = now + 60.0

        target = dict(self.base)  # start every frame from the green hedge underlay
        for key, rgb in leds.items():
            try:
                r, c = (int(x) for x in key.split(","))
                cr, cg, cb = (int(rgb[0]), int(rgb[1]), int(rgb[2]))
            except (ValueError, IndexError, TypeError):
                continue
            if max(cr, cg, cb) < self.min_level:
                continue  # treat very-dim cells as off (keeps the show sparse)
            for (q, idx) in self.map.cell_to_leds(r, c):
                target[(q, idx)] = (cr, cg, cb)  # Foundry color overrides the underlay

        changed = self._apply_target(target)
        if changed:
            print(f"[bridge] frame: {len(target)} lit, {changed} changed")

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
        log("[bridge] Foundry connected")
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if data.get("type") == "ping":
                    # Liveness probe from the module's watchdog — answer instantly
                    # so a healthy link is never mistaken for a dead one.
                    await websocket.send('{"type":"pong"}')
                    continue
                renderer.on_message(data)
        except Exception as e:
            log(f"[bridge] connection error: {e}")
        finally:
            log("[bridge] Foundry disconnected")

    log(f"[bridge] listening for Foundry on ws://{host}:{port}")
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
   ruler Q [step]  light markers: RED every 50, BLUE every [step] (default 10)
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
                dead = LEDS_PER_QUADRANT - mapping.total
                print(f"  explicit map: {mapping.total} LEDs lit per quadrant, "
                      f"{dead} dead (between-tile) of {LEDS_PER_QUADRANT}")
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
            elif cmd == "ruler":
                pico.clear()
                q = int(p[1]) if len(p) > 1 else 0
                step = int(p[2]) if len(p) > 2 else 10
                for idx in range(LEDS_PER_QUADRANT):
                    if idx % step != 0:
                        continue
                    if idx % 50 == 0:
                        pico.set_led(q, idx, 255, 0, 0)    # RED every 50
                    else:
                        pico.set_led(q, idx, 0, 80, 255)   # BLUE every `step`
                print(f"  ruler q{q}: RED = every 50, BLUE = every {step}")
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
            if cmd in ("clear", "cell", "raw", "col", "row", "quad", "walk", "ruler"):
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
    ap.add_argument("--dry", action="store_true", help="force dry-run; skip Pico auto-detect")
    ap.add_argument("--no-hedges", action="store_true", help="don't light the interior hedges green")
    ap.add_argument("--hedge-color", default=None,
                    help='green underlay color "r,g,b" (default "0,130,0")')
    ap.add_argument("--maze", default=DEFAULT_MAZE_PATH, help="path to maze-export.json")
    ap.add_argument("--verbose", action="store_true", help="log commands in dry-run")
    args = ap.parse_args()

    if args.list_ports:
        if serial is None:
            print("pyserial not installed. Run: pip install pyserial")
            return
        ports = list(serial.tools.list_ports.comports())
        if not ports:
            print("No serial ports found.")
        detected = autodetect_port()
        for p in ports:
            mark = "  <-- Pico (auto-detected)" if p.device == detected else ""
            print(f"  {p.device}  -  {p.description}{mark}")
        return

    # Resolve the port: explicit --port wins; otherwise auto-detect the Pico so the
    # bridge "just runs" on any machine. --dry forces a no-LED dry-run.
    port = args.port
    if not port and not args.dry:
        port = autodetect_port()
        if port:
            print(f"[bridge] auto-detected Pico on {port}")
        else:
            print("[bridge] no Pico auto-detected — running dry (no LEDs). "
                  "Plug the Pico in (or run --list-ports / pass --port COMx).")

    mapping = MazeMapping()
    dead = LEDS_PER_QUADRANT - mapping.total
    print(f"[bridge] explicit LED map loaded: {mapping.total} lit / {dead} dead "
          f"(between-tile) per quadrant.")

    # Build the static green underlay for the interior hedges.
    base = {}
    if not args.no_hedges:
        if args.hedge_color:
            try:
                hedge_rgb = tuple(int(x) for x in args.hedge_color.split(","))
                assert len(hedge_rgb) == 3
            except (ValueError, AssertionError):
                print(f"[bridge] bad --hedge-color {args.hedge_color!r}; using default.")
                hedge_rgb = DEFAULT_HEDGE_COLOR
        else:
            hedge_rgb = DEFAULT_HEDGE_COLOR
        hedge_cells = load_hedge_cells(args.maze)
        for (r, c) in hedge_cells:
            for (q, idx) in mapping.cell_to_leds(r, c):
                base[(q, idx)] = hedge_rgb
        print(f"[bridge] interior hedges: {len(hedge_cells)} tiles -> {len(base)} "
              f"green LEDs (rgb {hedge_rgb}). Use --no-hedges to disable.")

    log(f"[bridge] starting (port={port or 'none'}, min={args.min}, "
        f"brightness={args.brightness}, hedges={'off' if args.no_hedges else 'on'})",
        file_only=True)
    pico = Pico(port, args.baud, args.brightness, args.verbose,
                allow_reopen=not args.dry)

    try:
        if args.calibrate:
            calibrate(pico, mapping)
        else:
            renderer = Renderer(pico, mapping, args.min, base)
            renderer.prime()  # light the hedges immediately, before Foundry connects
            asyncio.run(run_server(renderer, args.host, args.ws_port))
    except KeyboardInterrupt:
        log("[bridge] shutting down (Ctrl-C)")
    finally:
        pico.close()


if __name__ == "__main__":
    main()
