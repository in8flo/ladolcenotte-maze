#!/usr/bin/env python3
"""
La Dolce Notte — LED Bridge

Runs on the DM laptop. Bridges Foundry VTT (WebSocket) to the 4 Pico
panel controllers (USB serial). Translates 25x25 grid cell colors into
per-LED serial commands using the serpentine LED map.

Usage:
    pip install websockets pyserial
    python bridge.py

Then start your Foundry session. The module connects automatically.

Config: edit SERIAL_PORTS below to match your system.
  Windows: "COM3", "COM4", ...
  Mac/Linux: "/dev/ttyACM0", "/dev/ttyACM1", ...
Find them: `python -m serial.tools.list_ports`
"""

import asyncio
import json
import sys

try:
    import websockets
except ImportError:
    print("ERROR: pip install websockets")
    sys.exit(1)

try:
    import serial
except ImportError:
    print("ERROR: pip install pyserial")
    sys.exit(1)

# ============ CONFIG ============
WS_HOST = "localhost"
WS_PORT = 8765

# Serial ports for each Pico (panel 0-3). Edit to match your system.
SERIAL_PORTS = {
    0: "COM3",   # rows 0-6
    1: "COM4",   # rows 7-12
    2: "COM5",   # rows 13-18
    3: "COM6",   # rows 19-24
}
SERIAL_BAUD = 115200

GRID_SIZE = 25
TILE_MM = 50.8
LED_SPACING_MM = 33.3

# LED-per-tile pattern (from CONFIG.md)
LED_PATTERN = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]
LEDS_PER_ROW = sum(LED_PATTERN)  # 38

# Which rows each panel owns
PANEL_ROWS = {
    0: list(range(0, 7)),
    1: list(range(7, 13)),
    2: list(range(13, 19)),
    3: list(range(19, 25)),
}


# ============ LED MAP ============
def build_led_map():
    """
    Build (row, col) -> (panel_id, [local_led_indices]).

    Within each panel the strip snakes through rows: even rows L->R,
    odd rows R->L. Indices are LOCAL to each panel (each Pico's strip
    starts at 0).
    """
    led_map = {}

    for panel_id, rows in PANEL_ROWS.items():
        local_idx = 0
        for row in rows:
            if row % 2 == 0:
                col_order = range(GRID_SIZE)        # left to right
            else:
                col_order = range(GRID_SIZE - 1, -1, -1)  # right to left

            for col in col_order:
                n_leds = LED_PATTERN[col]
                indices = list(range(local_idx, local_idx + n_leds))
                led_map[(row, col)] = (panel_id, indices)
                local_idx += n_leds

    return led_map


LED_MAP = build_led_map()


def cell_to_leds(row, col):
    """Return (panel_id, [local indices]) for a grid cell, or None."""
    return LED_MAP.get((row, col))


# ============ SERIAL ============
class PanelSerial:
    """Manages a serial connection to one Pico, with a frame buffer."""

    def __init__(self, panel_id, port):
        self.panel_id = panel_id
        self.port = port
        self.ser = None
        self.updates = []  # list of (local_idx, r, g, b)

    def connect(self):
        try:
            self.ser = serial.Serial(self.port, SERIAL_BAUD, timeout=0.1)
            print(f"  Panel {self.panel_id}: connected on {self.port}")
            return True
        except Exception as e:
            print(f"  Panel {self.panel_id}: FAILED on {self.port} — {e}")
            self.ser = None
            return False

    def queue(self, local_idx, r, g, b):
        self.updates.append((local_idx, r, g, b))

    def flush(self):
        """Send all queued updates as one frame, then a show command."""
        if not self.ser:
            self.updates = []
            return

        if self.updates:
            count = len(self.updates)
            frame = bytearray([0xFF, 0xFF, count & 0xFF, (count >> 8) & 0xFF])
            for idx, r, g, b in self.updates:
                frame += bytes([idx & 0xFF, (idx >> 8) & 0xFF, r, g, b])
            frame.append(0xFE)
            try:
                self.ser.write(frame)
            except Exception as e:
                print(f"  Panel {self.panel_id} write error: {e}")
            self.updates = []

        # Show command
        try:
            self.ser.write(bytes([0xFF, 0xFF, 0x00, 0x00, 0xFE]))
        except Exception:
            pass

    def clear(self):
        """Turn all LEDs off."""
        if not self.ser:
            return
        n = {0: 266, 1: 228, 2: 228, 3: 228}[self.panel_id]
        for i in range(n):
            self.queue(i, 0, 0, 0)
        self.flush()


panels = {pid: PanelSerial(pid, port) for pid, port in SERIAL_PORTS.items()}


def connect_all():
    print("Connecting to panels...")
    ok = 0
    for p in panels.values():
        if p.connect():
            ok += 1
    print(f"{ok}/4 panels connected.")
    if ok == 0:
        print("WARNING: no panels connected. Running in dry-run mode (state logged only).")
    return ok


# ============ STATE HANDLERS ============
def apply_led_state(leds_dict):
    """
    leds_dict: { "row,col": [r,g,b], ... }
    Routes each cell's color to the right panel + local LED indices.
    """
    # Reset queues
    for p in panels.values():
        p.updates = []

    for key, rgb in leds_dict.items():
        try:
            row_s, col_s = key.split(",")
            row, col = int(row_s), int(col_s)
        except ValueError:
            continue
        r, g, b = rgb
        mapping = cell_to_leds(row, col)
        if mapping is None:
            continue
        panel_id, indices = mapping
        for idx in indices:
            panels[panel_id].queue(idx, r, g, b)

    for p in panels.values():
        p.flush()


def clear_all():
    for p in panels.values():
        p.clear()


# ============ WEBSOCKET SERVER ============
async def handler(websocket):
    print("Foundry connected.")
    try:
        async for message in websocket:
            try:
                msg = json.loads(message)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            if mtype == "led_state":
                apply_led_state(msg.get("leds", {}))
            elif mtype == "clear":
                clear_all()
            elif mtype == "test":
                run_test(msg.get("pattern", "rainbow"))
            elif mtype == "ping":
                await websocket.send(json.dumps({"type": "pong"}))

    except websockets.ConnectionClosed:
        print("Foundry disconnected.")


def run_test(pattern):
    """Diagnostic patterns to verify wiring."""
    if pattern == "rainbow":
        # Light every cell with a hue based on position
        leds = {}
        for row in range(GRID_SIZE):
            for col in range(GRID_SIZE):
                hue = (row + col) / (GRID_SIZE * 2)
                r, g, b = hsv_to_rgb(hue, 1.0, 0.5)
                leds[f"{row},{col}"] = [r, g, b]
        apply_led_state(leds)
    elif pattern == "panels":
        # Each panel a different color to verify row bands
        colors = {0: (255, 0, 0), 1: (0, 255, 0), 2: (0, 0, 255), 3: (255, 255, 0)}
        leds = {}
        for panel_id, rows in PANEL_ROWS.items():
            r, g, b = colors[panel_id]
            for row in rows:
                for col in range(GRID_SIZE):
                    leds[f"{row},{col}"] = [r, g, b]
        apply_led_state(leds)
    elif pattern == "off":
        clear_all()


def hsv_to_rgb(h, s, v):
    import colorsys
    r, g, b = colorsys.hsv_to_rgb(h, s, v)
    return int(r * 255), int(g * 255), int(b * 255)


async def main():
    connect_all()
    print(f"\nLED Bridge running on ws://{WS_HOST}:{WS_PORT}")
    print("Waiting for Foundry to connect...\n")
    async with websockets.serve(handler, WS_HOST, WS_PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nShutting down, clearing LEDs...")
        clear_all()
