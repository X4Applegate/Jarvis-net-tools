"""Password hashing and login throttling for Jarvis Net Tools (standard library only).

* hash_password / verify_password: scrypt with a random per-password salt. The config file stores only the hash.
* LoginThrottle: per-client lock-out after repeated wrong passwords (exponential back-off), so the login form cannot
  be brute-forced. State is in memory; a restart clears it.
"""
import hashlib
import hmac
import os
import time

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1          # ~16 MiB, tens of milliseconds on a Raspberry Pi 4


def hash_password(pw):
    salt = os.urandom(16)
    dk = hashlib.scrypt(pw.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return "scrypt$%d$%d$%d$%s$%s" % (SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.hex(), dk.hex())


def verify_password(pw, stored):
    try:
        kind, n, r, p, salt, want = str(stored).split("$")
        if kind != "scrypt":
            return False
        dk = hashlib.scrypt(pw.encode("utf-8"), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=len(want) // 2)
        return hmac.compare_digest(dk.hex(), want)
    except Exception:
        return False


class LoginThrottle:
    """`free` wrong passwords are allowed, then the client is locked out for base, 2*base, 4*base ... seconds (max `cap`)."""

    def __init__(self, free=5, base=30, cap=900, clock=time.time):
        self.free, self.base, self.cap, self.clock = free, base, cap, clock
        self._s = {}                                   # key -> [consecutive_failures, locked_until, last_seen]

    def _gc(self):
        now = self.clock()
        for k in [k for k, v in self._s.items() if now - v[2] > 3600 and v[1] < now]:
            del self._s[k]

    def wait(self, key):
        """Seconds the client must still wait (0 = may try)."""
        v = self._s.get(key)
        return max(0, int(round(v[1] - self.clock()))) if v else 0

    def fail(self, key):
        self._gc()
        now = self.clock()
        v = self._s.setdefault(key, [0, 0, now])
        v[0] += 1
        v[2] = now
        if v[0] >= self.free:
            v[1] = now + min(self.cap, self.base * 2 ** (v[0] - self.free))

    def ok(self, key):
        self._s.pop(key, None)
