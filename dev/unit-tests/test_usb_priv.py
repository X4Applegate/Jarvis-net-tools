"""Unit tests for the root helper's USB operations (jarvis-priv usb-list / usb-save) on fake lsblk output.

Plain Python, no real disks, nothing is mounted (mount/umount are faked):
    python3 -m unittest -v dev/unit-tests/test_usb_priv.py        (from the repo root)
"""
import importlib.machinery
import importlib.util
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("jarvis_priv_usb", os.path.join(HERE, "..", "..", "scripts", "jarvis-priv"))
spec = importlib.util.spec_from_loader("jarvis_priv_usb", loader)
priv = importlib.util.module_from_spec(spec)
loader.exec_module(priv)

NAME = "2026-10-09_1716_Demo-Coffee-downtown.html"   # (a made-up site, like the real file names)
DISKS = [
    {"name": "nvme0n1", "path": "/dev/nvme0n1", "tran": "nvme", "type": "disk", "size": 500107862016, "children": [
        {"name": "nvme0n1p1", "path": "/dev/nvme0n1p1", "type": "part", "fstype": "vfat", "label": "bootfs", "mountpoints": ["/boot/firmware"]},
        {"name": "nvme0n1p2", "path": "/dev/nvme0n1p2", "type": "part", "fstype": "ext4", "mountpoints": ["/"]}]},
    {"name": "mmcblk0", "path": "/dev/mmcblk0", "tran": "mmc", "type": "disk", "children": [
        {"name": "mmcblk0p1", "path": "/dev/mmcblk0p1", "type": "part", "fstype": "vfat", "mountpoints": [None]}]},
    {"name": "sda", "path": "/dev/sda", "tran": "usb", "type": "disk", "size": 32017047552, "vendor": "SanDisk ", "model": "Ultra Fit",
     "children": [{"name": "sda1", "path": "/dev/sda1", "type": "part", "size": 32015998976, "fstype": "exfat", "label": "STICK", "mountpoints": [None]}]},
    {"name": "sdb", "path": "/dev/sdb", "tran": "usb", "type": "disk", "size": 2000398934016, "model": "USB SSD", "children": [
        {"name": "sdb1", "path": "/dev/sdb1", "type": "part", "fstype": "ext4", "mountpoints": [None]},
        {"name": "sdb2", "path": "/dev/sdb2", "type": "part", "fstype": "vfat", "mountpoints": ["/media/x"]}]},
    {"name": "sdc", "path": "/dev/sdc", "tran": "usb", "type": "disk", "size": 8000000000, "fstype": "vfat", "label": "OLD", "mountpoints": [None]},
]


class Fake:
    def __init__(self, fail_mount=False):
        self.calls, self.fail_mount = [], fail_mount

    def __call__(self, argv, **kw):
        self.calls.append(argv)

        class R:
            returncode = 32 if (self.fail_mount and argv[0].endswith("/mount")) else 0
            stderr = "mount: wrong fs type" if returncode else ""
        return R()


class Usb(unittest.TestCase):
    def test_only_unmounted_fat_or_exfat_on_usb(self):
        t = priv.usb_targets(DISKS)
        self.assertEqual([x["dev"] for x in t], ["/dev/sda1", "/dev/sdc"])     # not the SD card, NVMe, ext4 or a mounted one
        self.assertEqual(t[0], {"dev": "/dev/sda1", "label": "STICK", "size": 32015998976, "fstype": "exfat", "model": "SanDisk Ultra Fit"})

    def setUp(self):
        self.reports = tempfile.mkdtemp(prefix="nt-rep-")
        self.mnt = os.path.join(tempfile.mkdtemp(prefix="nt-mnt-"), "m")
        for n in (NAME, NAME[:-5] + ".pdf"):
            with open(os.path.join(self.reports, n), "w") as f:
                f.write("report " + n)

    def save(self, dev, names, fake=None):
        return priv.usb_save(dev, names, devices=DISKS, run=fake or Fake(), reports_dir=self.reports, mnt=self.mnt)

    def test_save_mounts_safely_copies_and_unmounts(self):
        f = Fake()
        r = self.save("/dev/sda1", [NAME, NAME[:-5] + ".pdf"], f)
        self.assertEqual((r["ok"], r["label"], r["folder"], r["unmounted"]), (True, "STICK", "JarvisReports", True))
        self.assertEqual(f.calls[0], ["/usr/bin/mount", "-t", "exfat", "-o", "nosuid,nodev,noexec,noatime", "/dev/sda1", self.mnt])
        self.assertEqual(f.calls[-1], ["/usr/bin/umount", self.mnt])
        self.assertEqual(sorted(os.listdir(os.path.join(self.mnt, "JarvisReports"))), sorted([NAME, NAME[:-5] + ".pdf"]))
        self.save("/dev/sdc", [NAME], f)                                        # a whole-disk FAT32 stick
        self.assertEqual([f.calls[-2][2], f.calls[-2][4]], ["vfat", "nosuid,nodev,noexec,noatime,utf8"])

    def test_refusals(self):
        for dev in ("/dev/nvme0n1p1", "/dev/mmcblk0p1", "/dev/sdb1", "/dev/sdb2", "/dev/sda", "/dev/sdz1", "/etc/passwd"):
            with self.assertRaises(priv.Refused, msg=dev):
                self.save(dev, [NAME])
        for names in ([], ["../netmon.db"], ["history.log"], [NAME, "x.sh"], [NAME[:-5] + ".exe"], [NAME] * 21):
            with self.assertRaises(priv.Refused, msg=names):
                self.save("/dev/sda1", names)
        os.symlink("/etc/shadow", os.path.join(self.reports, "2026-10-09_1717_x.html"))
        with self.assertRaises(priv.Refused):
            self.save("/dev/sda1", ["2026-10-09_1717_x.html"])                  # a symlink is never followed
        with self.assertRaises(priv.Refused):
            self.save("/dev/sda1", ["2026-10-09_1718_missing.html"])

    def test_failed_mount_copies_nothing(self):
        with self.assertRaises(priv.Refused):
            self.save("/dev/sda1", [NAME], Fake(fail_mount=True))
        self.assertFalse(os.path.exists(os.path.join(self.mnt, "JarvisReports")))


if __name__ == "__main__":
    unittest.main()
