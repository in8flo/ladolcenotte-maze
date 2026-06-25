# La Dolce Notte - LED maze SERIAL LISTENER firmware
# Waits for commands over USB serial and lights LEDs on demand.
# Board: Raspberry Pi Pico 2 (non-W firmware).
#
# Pins: skip GP1 (dead on this board). Q1=GP0, Q2=GP2 for now;
#       add GP3, GP4, GP5 as you wire the remaining quadrants.
#
# COMMAND FORMAT (type in the Thonny Shell, press Enter):
#   q,idx,r,g,b     -> set one LED.  e.g.  0,47,80,0,0   = quad 0, LED 47, red
#   fill,q,r,g,b    -> fill a whole quadrant.  e.g.  fill,1,0,80,0  = quad 1 green
#   clear           -> all LEDs off
#   all,r,g,b       -> fill every quadrant the same color
#
#   q is the quadrant INDEX: 0 = first quadrant, 1 = second, etc.
#   r,g,b are 0-255.

import board
import neopixel
import supervisor
import time

NUM_LEDS = 193
BRIGHTNESS = 0.3

# Quadrant index -> data pin. Add more as you wire them. Skips dead GP1.
PINS = [board.GP0, board.GP2]   # later: board.GP3, board.GP4, board.GP5

strips = [
    neopixel.NeoPixel(p, NUM_LEDS, brightness=BRIGHTNESS, auto_write=False)
    for p in PINS
]

def clear_all():
    for s in strips:
        s.fill((0, 0, 0))
        s.show()

def handle(line):
    line = line.strip()
    if not line:
        return
    parts = line.split(",")
    cmd = parts[0]

    try:
        if cmd == "clear":
            clear_all()
            print("OK clear")

        elif cmd == "all":
            r, g, b = int(parts[1]), int(parts[2]), int(parts[3])
            for s in strips:
                s.fill((r, g, b)); s.show()
            print("OK all", r, g, b)

        elif cmd == "fill":
            q = int(parts[1])
            r, g, b = int(parts[2]), int(parts[3]), int(parts[4])
            strips[q].fill((r, g, b)); strips[q].show()
            print("OK fill q" + str(q), r, g, b)

        else:
            # default: "q,idx,r,g,b" single-LED form
            q = int(parts[0])
            idx = int(parts[1])
            r, g, b = int(parts[2]), int(parts[3]), int(parts[4])
            strips[q][idx] = (r, g, b)
            strips[q].show()
            print("OK q" + str(q), "led", idx, "=", r, g, b)

    except (IndexError, ValueError):
        print("BAD COMMAND:", line)
    except Exception as e:
        print("ERROR:", e)

# Startup: brief flash so you know the firmware is live, then clear.
for s in strips:
    s.fill((20, 0, 0)); s.show()
time.sleep(0.5)
clear_all()
print("Serial listener ready. Type a command and press Enter.")
print("Examples:  0,47,80,0,0   |   fill,1,0,80,0   |   all,30,0,0   |   clear")

# Main loop: read a line whenever one is available.
while True:
    if supervisor.runtime.serial_bytes_available:
        line = input()
        handle(line)
    time.sleep(0.01)
