#!/usr/bin/env python3
"""Write an invisible Xcursor theme (1x1 fully transparent) so a touch-only kiosk shows no mouse pointer."""
import os, struct, sys
root = sys.argv[1] if len(sys.argv) > 1 else "/usr/local/share/icons/jarvis-blank"
cur = os.path.join(root, "cursors"); os.makedirs(cur, exist_ok=True)
IMG = 0xFFFD0002
def xcursor():
    out = b"Xcur" + struct.pack("<III", 16, 0x10000, 1)
    out += struct.pack("<III", IMG, 24, 16 + 12)                       # TOC: image, nominal size 24, offset
    out += struct.pack("<IIIIIIIII", 36, IMG, 24, 1, 1, 1, 0, 0, 0)    # chunk header, 1x1, hotspot 0,0
    out += struct.pack("<I", 0)                                        # one transparent ARGB pixel
    return out
names = """default left_ptr arrow top_left_arrow pointer hand hand1 hand2 pointing_hand text xterm ibeam wait watch
progress left_ptr_watch half-busy crosshair cross tcross move fleur grab grabbing openhand closedhand not-allowed
crossed_circle forbidden no-drop help question_arrow whats_this all-scroll col-resize row-resize split_h split_v
n-resize s-resize e-resize w-resize ne-resize nw-resize se-resize sw-resize ew-resize ns-resize nesw-resize nwse-resize
sb_h_double_arrow sb_v_double_arrow h_double_arrow v_double_arrow size_hor size_ver size_bdiag size_fdiag size_all
top_side bottom_side left_side right_side top_left_corner top_right_corner bottom_left_corner bottom_right_corner
context-menu cell copy alias link dnd-move dnd-copy dnd-link dnd-none dnd-ask vertical-text zoom-in zoom-out
X_cursor pirate draft color-picker plus""".split()
data = xcursor()
for n in names:
    with open(os.path.join(cur, n), "wb") as f: f.write(data)
with open(os.path.join(root, "index.theme"), "w") as f:
    f.write("[Icon Theme]\nName=jarvis-blank\nComment=Invisible cursor for the Jarvis touch-screen kiosk\n")
print(f"wrote {len(names)} invisible cursors to {cur}")
