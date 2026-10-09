"""Unit tests for scripts/jarvis-ups (Argon PWR UPS battery reader + low-battery shutdown decision).

Plain Python, no hardware:
    python3 -m unittest -v dev/unit-tests/test_ups.py        (from the repo root)
"""
import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("jarvis_ups", os.path.join(HERE, "..", "..", "scripts", "jarvis-ups"))
spec = importlib.util.spec_from_loader("jarvis_ups", loader)
ups = importlib.util.module_from_spec(spec)
loader.exec_module(ups)

BATT_9_MAINS = bytes.fromhex("fe0200090009")       # a real reply from a PWR UPS 10000 (firmware 113), 2026-10-09
FW_113 = bytes.fromhex("fe01047174")


class Frames(unittest.TestCase):
    def test_real_replies(self):
        self.assertEqual(ups.frames(BATT_9_MAINS), [(0, b"\x09\x00")])
        self.assertEqual(ups.frames(FW_113), [(4, b"\x71")])
        self.assertEqual(ups.decode_battery(b"\x09\x00"), {"percent": 9, "source": "mains"})
        self.assertEqual(ups.decode_battery(b"\x57\x01"), {"percent": 87, "source": "battery"})

    def test_junk_bad_checksum_and_split_reads(self):
        self.assertEqual(ups.frames(b"\x00\x13" + BATT_9_MAINS + b"\xff"), [(0, b"\x09\x00")])   # noise around it
        self.assertEqual(ups.frames(BATT_9_MAINS[:-1] + b"\x0a"), [])                           # wrong checksum
        self.assertEqual(ups.frames(BATT_9_MAINS[:4]), [])                                      # not complete yet
        self.assertEqual(ups.frames(b"\xfe" + BATT_9_MAINS), [(0, b"\x09\x00")])               # stray start byte
        self.assertEqual(ups.frames(BATT_9_MAINS + FW_113), [(0, b"\x09\x00"), (4, b"\x71")])

    def test_odd_values(self):
        self.assertEqual(ups.decode_battery(b"\xc8\x00")["percent"], 100)    # >100 seen in the wild: clamp
        self.assertIsNone(ups.decode_battery(b"\x09"))
        self.assertIsNone(ups.decode_battery(b""))

    def test_only_read_commands_can_be_sent(self):
        p = ups.Port.__new__(ups.Port)
        p.fd = -1
        for cmd in (1, 2, 3, 5, 6, 7, 8, 9, 10, 255):
            with self.assertRaises(ValueError):
                p.read(cmd)


class Policy(unittest.TestCase):
    def r(self, pct, src="battery"):
        return {"percent": pct, "source": src}

    def test_levels(self):
        self.assertEqual(ups.level(self.r(9, "mains")), "mains")           # plugged in: fine at any %
        self.assertEqual(ups.level(self.r(80)), "battery")
        self.assertEqual(ups.level(self.r(25)), "low")
        self.assertEqual(ups.level(self.r(10)), "critical")
        self.assertEqual(ups.level(None), "unknown")

    def test_shutdown_needs_three_critical_readings_after_boot_grace(self):
        w = ups.Watch()
        self.assertEqual([w.step(self.r(8), 600)[1] for _ in range(3)], [False, False, True])
        w = ups.Watch()
        self.assertFalse(any(w.step(self.r(8), 60)[1] for _ in range(10)))    # just booted: never
        self.assertTrue(w.step(self.r(8), 200)[1])                             # grace over, streak kept

    def test_a_good_reading_resets_the_streak(self):
        w = ups.Watch()
        w.step(self.r(8), 600), w.step(self.r(8), 600)
        self.assertFalse(w.step(self.r(8, "mains"), 600)[1])                   # mains back
        self.assertFalse(w.step(self.r(8), 600)[1])
        self.assertFalse(w.step(self.r(8), 600)[1])
        self.assertTrue(w.step(self.r(8), 600)[1])
        w.done = True
        self.assertFalse(w.step(self.r(8), 600)[1])                            # never twice


class Port(unittest.TestCase):
    def test_found_by_name_not_number(self):
        root = tempfile.mkdtemp(prefix="nt-ups-")
        for n, (man, prod) in enumerate((("Silicon Labs", "CP2102N"), ("Argon", "Argon_USB"))):
            usb = os.path.join(root, "devices", f"1-{n}")
            intf = os.path.join(usb, f"1-{n}:1.0")
            os.makedirs(intf)
            for k, v in (("manufacturer", man), ("product", prod)):
                with open(os.path.join(usb, k), "w") as f:
                    f.write(v + "\n")
            tty = os.path.join(root, "class", f"ttyACM{n}")
            os.makedirs(tty)
            os.symlink(intf, os.path.join(tty, "device"))
        self.assertEqual(ups.find_port(os.path.join(root, "class")), "/dev/ttyACM1")
        self.assertIsNone(ups.find_port(os.path.join(root, "nothing")))

    def test_state_file(self):
        d = tempfile.mkdtemp(prefix="nt-ups-")
        ups.write_state({"percent": 9, "source": "mains"}, d)
        with open(os.path.join(d, "state.json")) as f:
            self.assertEqual(json.load(f)["percent"], 9)
        self.assertEqual(os.stat(os.path.join(d, "state.json")).st_mode & 0o777, 0o644)


if __name__ == "__main__":
    unittest.main()
