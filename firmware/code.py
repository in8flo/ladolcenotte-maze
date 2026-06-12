# La Dolce Notte — Pico Panel Firmware (CircuitPython)
#
# Flash this to each of the 4 Picos. Set PANEL_ID (0-3) per board.
# Listens on USB serial for LED commands and drives the WS2812B chain.
#
# Hardware: Raspberry Pi Pico 2, WS2812B data on GP1.
# CircuitPython 10.x + neopixel + adafruit_pixelbuf libraries.
#
# Serial protocol (binary frames):
#   0xFF 0xFF <count:uint16 LE> [<idx:uint16 LE> <R> <G> <B>] ... 0xFE
#   count=0 means "show" (latch the buffer to the LEDs)

import board
import neopixel
import supervisor
import sys
import usb_cdc

# ============ PER-PANEL CONFIG ============
# CHANGE THIS for each Pico before flashing!
PANEL_ID = 0  # 0, 1, 2, or 3

# LED counts per panel (from CONFIG.md)
PANEL_LED_COUNTS = {
    0: 266,  # rows 0-6
    1: 228,  # rows 7-12
    2: 228,  # rows 13-18
    3: 228,  # rows 19-24
}

NUM_LEDS = PANEL_LED_COUNTS[PANEL_ID]
DATA_PIN = board.GP1  # GP0 was non-functional in POC

# ============ SETUP ============
pixels = neopixel.NeoPixel(
    DATA_PIN,
    NUM_LEDS,
    brightness=1.0,      # brightness baked into colors by the bridge
    auto_write=False,
    pixel_order=neopixel.GRB,
)

# Use the data serial channel (not the REPL console)
serial = usb_cdc.data if usb_cdc.data else usb_cdc.console

# Frame parser state
STATE_WAIT_H1 = 0
STATE_WAIT_H2 = 1
STATE_COUNT_LO = 2
STATE_COUNT_HI = 3
STATE_DATA = 4

state = STATE_WAIT_H1
count = 0
data_buf = bytearray()
data_needed = 0


def startup_blink():
    """Flash the panel ID so you know which board is which."""
    for _ in range(PANEL_ID + 1):
        pixels.fill((0, 20, 0))
        pixels.show()
        _delay(150)
        pixels.fill((0, 0, 0))
        pixels.show()
        _delay(150)


def _delay(ms):
    import time
    time.sleep(ms / 1000)


def apply_frame(buf):
    """Apply a data frame: series of (idx, r, g, b) updates."""
    i = 0
    n = len(buf)
    while i + 5 <= n:
        idx = buf[i] | (buf[i + 1] << 8)
        r = buf[i + 2]
        g = buf[i + 3]
        b = buf[i + 4]
        if 0 <= idx < NUM_LEDS:
            pixels[idx] = (r, g, b)
        i += 5


startup_blink()

# ============ MAIN LOOP ============
while True:
    if serial.in_waiting > 0:
        byte = serial.read(1)
        if not byte:
            continue
        b = byte[0]

        if state == STATE_WAIT_H1:
            if b == 0xFF:
                state = STATE_WAIT_H2
        elif state == STATE_WAIT_H2:
            if b == 0xFF:
                state = STATE_COUNT_LO
            else:
                state = STATE_WAIT_H1
        elif state == STATE_COUNT_LO:
            count = b
            state = STATE_COUNT_HI
        elif state == STATE_COUNT_HI:
            count |= (b << 8)
            if count == 0:
                # "show" command — latch buffer to LEDs
                pixels.show()
                state = STATE_WAIT_H1
            else:
                data_needed = count * 5
                data_buf = bytearray()
                state = STATE_DATA
        elif state == STATE_DATA:
            data_buf.append(b)
            if len(data_buf) >= data_needed:
                # Next byte should be footer 0xFE, but we apply now
                apply_frame(data_buf)
                state = STATE_WAIT_H1
