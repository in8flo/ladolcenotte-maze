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
import sys
import time

NUM_LEDS = 193
BRIGHTNESS = 0.3

# Quadrant index (0-based) -> data pin. GP1 is dead on this board.
#   quad 0 = Q1 = GP0        quad 3 = Q4 = GP14 (pin 19)
#   quad 1 = Q2 = GP2        quad 4 = Q5 = GP15 (pin 20)
#   quad 2 = Q3 = GP13 (pin 17)
PINS = [board.GP0, board.GP2, board.GP13, board.GP14, board.GP15]

strips = [
    neopixel.NeoPixel(p, NUM_LEDS, brightness=BRIGHTNESS, auto_write=False)
    for p in PINS
]

def clear_all():
    for s in strips:
        s.fill((0, 0, 0))
        s.show()

def apply(line):
    """Apply ONE command to the pixel buffers WITHOUT calling show().
    Returns the quadrant index touched, -1 for every quadrant, or None on no-op.
    (show() is batched in the main loop so a flood of commands stays fast.)"""
    line = line.strip()
    if not line:
        return None
    parts = line.split(",")
    cmd = parts[0]
    try:
        if cmd == "clear":
            for s in strips:
                s.fill((0, 0, 0))
            return -1
        elif cmd == "all":
            r, g, b = int(parts[1]), int(parts[2]), int(parts[3])
            for s in strips:
                s.fill((r, g, b))
            return -1
        elif cmd == "fill":
            q = int(parts[1])
            r, g, b = int(parts[2]), int(parts[3]), int(parts[4])
            strips[q].fill((r, g, b))
            return q
        else:
            # default: "q,idx,r,g,b" single-LED form
            q = int(parts[0])
            idx = int(parts[1])
            r, g, b = int(parts[2]), int(parts[3]), int(parts[4])
            strips[q][idx] = (r, g, b)
            return q
    except (IndexError, ValueError):
        return None
    except Exception:
        return None

# Startup: brief flash so you know the firmware is live, then clear.
for s in strips:
    s.fill((20, 0, 0)); s.show()
time.sleep(0.5)
clear_all()
print("Serial listener ready (batched). q,idx,r,g,b | fill,q,r,g,b | all,r,g,b | clear")

# Main loop: drain ALL buffered commands, apply them, then refresh each touched
# strip ONCE. This keeps up with a full-frame flood from the bridge and stops the
# serial buffer from overflowing.
buf = ""
while True:
    n = supervisor.runtime.serial_bytes_available
    if not n:
        time.sleep(0.002)
        continue
    buf += sys.stdin.read(n)
    dirty = set()
    all_dirty = False
    applied = 0
    while "\n" in buf:
        line, buf = buf.split("\n", 1)
        q = apply(line)
        if q is None:
            continue
        applied += 1
        if q < 0:
            all_dirty = True
        else:
            dirty.add(q)
    if all_dirty:
        for s in strips:
            s.show()
    else:
        for q in dirty:
            if 0 <= q < len(strips):
                strips[q].show()
    if applied:
        print("OK", applied)   # one ack per batch (confirms the firmware is alive)
