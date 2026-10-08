"""Unit tests for the Wi-Fi adapter "USB Link" check (usb_link / usb_superspeed_capable) on a fake /sys tree.

Needs Flask (apt: python3-flask), like the security tests. Never touches real hardware.
    python3 -m unittest -v dev/unit-tests/test_usb_link.py        (from the repo root)
"""
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "security-tests"))
from test_security import load_app  # noqa: E402  (throw-away config, same loader as the security tests)

# Raw BOS descriptors. BOS_USB3 is the ALFA AWUS036AXML (MT7921AU): USB 2.0 Extension + SuperSpeed USB Device Capability.
BOS_USB3 = bytes.fromhex("050f1600020710021ef100000a1003000e00010ab400")
BOS_USB2 = bytes.fromhex("050f0c00010710020e000000")                     # USB 2.0 Extension (LPM) only
BOS_SSP = bytes.fromhex("050f1100010c100a00000000000000000000")[:17]     # SuperSpeedPlus capability only


def fake_sys(speed="480", version=" 2.10", bos=BOS_USB3, port=True, peer=True, usb=True):
    """A minimal /sys: class/net/wlan1/device -> a USB interface of device 1-1 on root hub usb1 (or an SDIO radio)."""
    root = tempfile.mkdtemp(prefix="nt-sys-")
    if usb:
        hub = os.path.join(root, "devices/platform/xhci-hcd.0/usb1")
        dev = os.path.join(hub, "1-1")
        intf = os.path.join(dev, "1-1:1.3")
        os.makedirs(intf)
        for name, val in {"speed": "480", "idVendor": "1d6b"}.items():          # the root hub has these too
            open(os.path.join(hub, name), "w").write(val + "\n")
        for name, val in {"speed": speed, "version": version, "idVendor": "0e8d", "idProduct": "7961",
                          "product": "Wireless_Device"}.items():
            open(os.path.join(dev, name), "w").write(val + "\n")
        if bos is not None:
            open(os.path.join(dev, "bos_descriptors"), "wb").write(bos)
        if port:
            pdir = os.path.join(hub, "1-0:1.0", "usb1-port1")
            os.makedirs(pdir)
            os.symlink(os.path.relpath(pdir, dev), os.path.join(dev, "port"))
            if peer:                                                               # USB 2 half of a blue USB 3 port
                other = os.path.join(root, "devices/platform/xhci-hcd.0/usb2/2-0:1.0/usb2-port1")
                os.makedirs(other)
                os.symlink(os.path.relpath(other, pdir), os.path.join(pdir, "peer"))
    else:
        intf = os.path.join(root, "devices/platform/mmc1/mmc1:0001/mmc1:0001:1")  # built-in SDIO radio
        os.makedirs(intf)
    net = os.path.join(root, "class/net/wlan1")
    os.makedirs(net)
    os.symlink(intf, os.path.join(net, "device"))
    return root


class UsbLink(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_app()[0]

    def link(self, **kw):
        root = fake_sys(**kw)
        self.addCleanup(shutil.rmtree, root, True)
        return self.mod.usb_link("wlan1", sys_root=root)

    def test_usb3_is_ok(self):
        u = self.link(speed="5000", version=" 3.20")
        self.assertEqual((u["status"], u["mbps"], u["label"], u["gen"]), ("ok", 5000, "5 Gbps", "USB 3"))
        self.assertEqual((u["usb3_capable"], u["port_usb3"], u["hint"]), (True, True, ""))
        self.assertEqual((u["id"], u["product"], u["usb_path"], u["iface"]), ("0e8d:7961", "Wireless_Device", "1-1", "wlan1"))

    def test_usb3_adapter_fell_back_to_usb2_in_a_usb3_port(self):
        u = self.link()
        self.assertEqual((u["status"], u["mbps"], u["label"], u["gen"]), ("warn", 480, "480 Mbps", "USB 2.0"))
        self.assertEqual((u["usb3_capable"], u["port_usb3"]), (True, True))
        self.assertIn("flip the USB-C plug", u["hint"])

    def test_usb3_adapter_in_a_usb2_port(self):
        u = self.link(peer=False)
        self.assertEqual((u["status"], u["port_usb3"]), ("warn", False))
        self.assertIn("blue USB 3 port", u["hint"])

    def test_port_unknown_still_warns(self):
        u = self.link(port=False)
        self.assertEqual((u["status"], u["port_usb3"]), ("warn", None))
        self.assertIn("flip the USB-C plug", u["hint"])

    def test_usb2_only_adapter_is_not_a_problem(self):
        u = self.link(bos=BOS_USB2)
        self.assertEqual((u["status"], u["usb3_capable"]), ("info", False))
        self.assertNotIn("flip", u["hint"])

    def test_no_bos(self):
        u = self.link(bos=None)
        self.assertEqual((u["status"], u["usb3_capable"]), ("unknown", None))
        u = self.link(bos=None, speed="5000", version=" 3.20")
        self.assertEqual((u["status"], u["usb3_capable"]), ("ok", True))

    def test_other_speeds(self):
        self.assertEqual((self.link(speed="10000", version=" 3.20")["label"]), "10 Gbps")
        u = self.link(speed="12", bos=BOS_USB2)
        self.assertEqual((u["label"], u["gen"]), ("12 Mbps", "USB 1.1"))
        self.assertEqual(self.link(speed="1.5", bos=BOS_USB2)["label"], "1.5 Mbps")

    def test_not_usb(self):
        self.assertIsNone(self.link(usb=False))                                 # built-in SDIO radio
        root = tempfile.mkdtemp(prefix="nt-sys-")
        self.addCleanup(shutil.rmtree, root, True)
        self.assertIsNone(self.mod.usb_link("wlan1", sys_root=root))            # adapter unplugged
        self.assertIsNone(self.link(speed="garbage"))                           # never raises

    def test_bos_parser(self):
        cap = self.mod.usb_superspeed_capable
        self.assertIs(cap(BOS_USB3), True)
        self.assertIs(cap(BOS_SSP), True)
        self.assertIs(cap(BOS_USB2), False)
        for junk in (b"", b"\x05\x0f", b"\x07\x10\x02\x00\x00\x00\x00", b"\x00\x0f\x05\x00\x00"):
            self.assertIsNone(cap(junk), junk)
        self.assertIs(cap(bytes.fromhex("050f4000010000000000")), False)        # zero-length capability: stops
        self.assertIs(cap(BOS_USB3[:12]), False)                                # truncated before the SS capability

    def test_status_endpoint_carries_it(self):
        mod = self.mod
        saved = mod.usb_link, mod.run
        self.addCleanup(lambda: (setattr(mod, "usb_link", saved[0]), setattr(mod, "run", saved[1])))
        mod.run = lambda *a, **k: ""
        mod.usb_link = lambda *a, **k: {"status": "warn", "mbps": 480}
        r = mod.app.test_client().get("/api/status", environ_base={"REMOTE_ADDR": "127.0.0.1"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["usb"], {"status": "warn", "mbps": 480})


if __name__ == "__main__":
    unittest.main()
