"""Send new food photos from the iCloud Photos folder to /restaurants/inbox.

Runs every 15 minutes as a Windows scheduled task (see install.ps1). Each run
looks only at files it has not seen, scores them on this PC (detect.py), and
uploads the ones that look like food. Nothing else leaves the machine. Safe to
rerun: the seen list is local, and `sha256` is unique in the database.

    python sync.py [--since 2026-01-01] [--dry-run] [--limit N]
"""
import argparse
import hashlib
import io
import json
import math
import msvcrt
import os
import re
import sys
import time
import traceback
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

PHOTOS = Path.home() / "Pictures" / "iCloud Photos" / "Photos"
HOME = Path(os.environ["LOCALAPPDATA"]) / "food-inbox"
REPO = Path(__file__).resolve().parents[2]
BUCKET = "food-inbox"

# PNGs are screenshots; everything else here is a camera.
EXTENSIONS = {".heic", ".heif", ".jpg", ".jpeg"}
# Tuned on 450 photos: below this it is mostly people sitting at tables.
THRESHOLD = 0.75
MAX_EDGE = 1600
QUALITY = 82
# About 300 KB each, against Supabase's 1 GB of free storage.
MAX_PENDING = 2500
# Two photos with hashes this close are the same picture re-encoded.
SAME_HASH = 6
# iCloud writes a file before it has finished downloading it.
SETTLE_SECONDS = 60
MAX_ATTEMPTS = 5
# Same as RADIUS_M in src/lib/food-inbox.ts: how far a suggestion may be.
RADIUS_M = 150
# What OpenStreetMap is asked for near a photo the gazetteer does not cover.
KINDS = ("restaurant", "cafe", "bar", "pub", "fast food", "ice cream", "bakery")
NOMINATIM = "https://nominatim.openstreetmap.org/search"
# Nominatim's usage policy: name the app, and one request a second.
AGENT = "jqiao.vercel.app food photo inbox"


def load_env(path):
    env = {}
    for line in path.read_text(encoding="utf8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip("\"'")
    return env


class Supabase:
    def __init__(self, env):
        self.url = env["SUPABASE_URL"].rstrip("/")
        self.key = env["SUPABASE_SERVICE_ROLE_KEY"]

    def call(self, method, path, body=None, headers=None):
        req = urllib.request.Request(self.url + path, method=method, data=body)
        for k, v in {"apikey": self.key, "Authorization": f"Bearer {self.key}", **(headers or {})}.items():
            req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.read(), res.headers

    def pending(self):
        path = "/rest/v1/food_inbox?select=id&status=eq.pending"
        _, headers = self.call("HEAD", path, headers={"Prefer": "count=exact"})
        return int(headers["Content-Range"].split("/")[1])

    def known(self, sha):
        body, _ = self.call("GET", f"/rest/v1/food_inbox?select=id&sha256=eq.{sha}")
        return bool(json.loads(body))

    def photos(self):
        body, _ = self.call("GET", "/rest/v1/restaurant_photos?select=id,storage_path&limit=1000&order=id.desc")
        return json.loads(body)

    def pending_points(self):
        body, _ = self.call("GET", "/rest/v1/food_inbox?select=lat,lng&status=eq.pending&lat=not.is.null")
        return json.loads(body)

    def places_near(self, box):
        south, north, west, east = box
        path = f"/rest/v1/place_sources?select=id&lat=gte.{south}&lat=lte.{north}&lng=gte.{west}&lng=lte.{east}&limit=1"
        body, _ = self.call("GET", path)
        return bool(json.loads(body))

    def add_places(self, rows):
        self.call(
            "POST",
            "/rest/v1/place_sources?on_conflict=source,source_id",
            json.dumps(rows).encode(),
            {"Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"},
        )

    def add(self, row, webp):
        path = f"{uuid.uuid4()}.webp"
        self.call("POST", f"/storage/v1/object/{BUCKET}/{path}", webp, {"Content-Type": "image/webp"})
        try:
            self.call(
                "POST",
                "/rest/v1/food_inbox",
                json.dumps({**row, "storage_path": path}).encode(),
                {"Content-Type": "application/json", "Prefer": "return=minimal"},
            )
        except Exception:
            # No row points at it, so nothing would ever delete it.
            self.call("DELETE", f"/storage/v1/object/{BUCKET}/{path}")
            raise


def taken_at(exif):
    """The camera's own clock as ISO text, or None. Saved and forwarded images have none."""
    raw = str(exif.get_ifd(0x8769).get(0x9003) or "").strip("\0 ")
    try:
        return datetime.strptime(raw, "%Y:%m:%d %H:%M:%S").isoformat()
    except ValueError:
        return None


def position(exif):
    gps = exif.get_ifd(0x8825)

    def degrees(value, ref, negative):
        d, m, s = (float(x) for x in value)
        sign = -1 if str(ref).strip("\0 ").upper() == negative else 1
        return round((d + m / 60 + s / 3600) * sign, 6)

    try:
        lat, lng = degrees(gps[2], gps[1], "S"), degrees(gps[4], gps[3], "W")
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return None, None
    # 0,0 is a camera with no fix, not a meal in the Gulf of Guinea.
    if not (abs(lat) <= 90 and abs(lng) <= 180) or (lat == 0 and lng == 0):
        return None, None
    return lat, lng


def dhash(img):
    px = img.convert("L").resize((9, 8), 3).tobytes()
    bits = 0
    for y in range(8):
        for x in range(8):
            bits = bits << 1 | (px[y * 9 + x] < px[y * 9 + x + 1])
    return bits


def same(a, b):
    return (a ^ b).bit_count() <= SAME_HASH


class State:
    """What this PC has already looked at. Lives outside the repo."""

    KEYS = ("seen", "tries", "logged", "sent", "looked")

    def __init__(self):
        self.path = HOME / "state.json"
        self.seen, self.tries, self.logged, self.sent, self.looked = {}, {}, {}, {}, {}
        if self.path.exists():
            self.__dict__.update(json.loads(self.path.read_text(encoding="utf8")))

    def save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({k: self.__dict__[k] for k in self.KEYS}), encoding="utf8")
        os.replace(tmp, self.path)


def learn_logged(db, env, state):
    """Hashes of photos already on a visit, so they are not offered again."""
    from PIL import Image

    base = env["R2_PUBLIC_URL"].rstrip("/")
    for p in db.photos():
        key = str(p["id"])
        if key in state.logged:
            continue
        try:
            # Cloudflare turns away urllib's own user agent.
            req = urllib.request.Request(f"{base}/{p['storage_path']}", headers={"User-Agent": "food-inbox"})
            with urllib.request.urlopen(req, timeout=60) as res:
                state.logged[key] = dhash(Image.open(io.BytesIO(res.read())))
        except Exception as e:
            print(f"logged photo {key}: {e}")


def normalize(raw):
    """The gazetteer's search key. Must match normalize() in src/lib/gazetteer.ts."""
    folded = "".join(c for c in unicodedata.normalize("NFD", raw) if not 0x300 <= ord(c) <= 0x36F)
    return re.sub(r"[^A-Z0-9]+", " ", folded.upper()).strip()


def box_around(lat, lng, radius):
    """south, north, west, east. Same arithmetic as boxAround() in food-inbox-group.ts."""
    d_lat = radius / 111_320
    d_lng = radius / (111_320 * max(0.01, math.cos(math.radians(lat))))
    return lat - d_lat, lat + d_lat, lng - d_lng, lng + d_lng


def osm_place(hit):
    a = hit.get("address") or {}
    tags = hit.get("extratags") or {}
    street = " ".join(x for x in (a.get("house_number"), a.get("road")) if x)
    cuisines = [c.strip().replace("_", " ").capitalize() for c in tags.get("cuisine", "").split(";") if c.strip()]
    return {
        "source": "osm",
        "source_id": f"{hit['osm_type']}/{hit['osm_id']}",
        "name": hit["name"],
        "name_norm": normalize(hit["name"]),
        "lat": float(hit["lat"]),
        "lng": float(hit["lon"]),
        "address": street or None,
        "locality": a.get("suburb") or a.get("neighbourhood"),
        "city": a.get("city") or a.get("town") or a.get("village") or a.get("hamlet"),
        "region": a.get("state"),
        "country": (a.get("country_code") or "").upper() or None,
        "cuisines": cuisines or [hit.get("type", "").replace("_", " ").capitalize()],
        "phone": tags.get("phone"),
        "website": tags.get("website"),
    }


def find_places(db, state):
    """Where a waiting photo has no gazetteer place nearby (outside New York and
    the other imported areas), ask OpenStreetMap and add what it knows to the
    gazetteer, so the inbox has suggestions there too."""
    for p in db.pending_points():
        cell = f"{p['lat']:.3f},{p['lng']:.3f}"
        if cell in state.looked:
            continue
        if db.places_near(box_around(p["lat"], p["lng"], RADIUS_M)):
            state.looked[cell] = "covered"
            continue
        south, north, west, east = box_around(p["lat"], p["lng"], RADIUS_M + 100)
        found = {}
        for kind in KINDS:
            query = urllib.parse.urlencode({
                "format": "jsonv2", "q": kind, "viewbox": f"{west},{north},{east},{south}",
                "bounded": 1, "limit": 50, "addressdetails": 1, "extratags": 1,
            })
            req = urllib.request.Request(f"{NOMINATIM}?{query}", headers={"User-Agent": AGENT})
            with urllib.request.urlopen(req, timeout=60) as res:
                for hit in json.loads(res.read()):
                    if hit.get("name"):
                        found[f"{hit['osm_type']}/{hit['osm_id']}"] = osm_place(hit)
            time.sleep(1.1)
        if found:
            db.add_places(list(found.values()))
        state.looked[cell] = len(found)
        print(f"places near {cell}: {len(found)} from OpenStreetMap", flush=True)


def candidates(state, since):
    now = time.time()
    found = []
    for f in os.scandir(PHOTOS):
        if not f.is_file() or Path(f.name).suffix.lower() not in EXTENSIONS:
            continue
        st = f.stat()
        key = f"{f.name}|{st.st_size}"
        if key in state.seen or state.tries.get(key, 0) >= MAX_ATTEMPTS:
            continue
        # iCloud's mtime is when the photo was taken or later, so this skips old
        # years without opening (and downloading) them.
        if st.st_mtime < since.timestamp() or now - max(st.st_mtime, st.st_birthtime) < SETTLE_SECONDS:
            continue
        found.append((st.st_mtime, key, Path(f.path)))
    return [(key, path) for _, key, path in sorted(found, reverse=True)]


def process(path, detector, db, state, since, dry_run):
    from PIL import Image, ImageOps

    data = path.read_bytes()
    with Image.open(io.BytesIO(data)) as img:
        exif = img.getexif()
        when = taken_at(exif)
        if when is None:
            return "no camera date"
        if datetime.fromisoformat(when) < since:
            return "too old"
        lat, lng = position(exif)
        full = ImageOps.exif_transpose(img).convert("RGB")

    score = detector.score(full)
    if score < THRESHOLD:
        return f"not food {score:.2f}"
    h = dhash(full)
    if any(same(h, other) for other in state.logged.values()):
        return "already logged"
    if any(same(h, other) for other in state.sent.get(when, [])):
        return "duplicate"
    if dry_run:
        return f"FOOD {score:.2f}"

    sha = hashlib.sha256(data).hexdigest()
    if not db.known(sha):
        full.thumbnail((MAX_EDGE, MAX_EDGE), 1)
        # A bare copy of the pixels: the one on the site carries no location.
        bare = Image.new("RGB", full.size)
        bare.paste(full)
        out = io.BytesIO()
        bare.save(out, "WEBP", quality=QUALITY)
        row = {
            "sha256": sha,
            "filename": path.name,
            "width": bare.width,
            "height": bare.height,
            "taken_at": when,
            "lat": lat,
            "lng": lng,
            "score": score,
        }
        db.add(row, out.getvalue())
    state.sent.setdefault(when, []).append(h)
    return f"FOOD {score:.2f}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default=datetime(2026, 1, 1), type=datetime.fromisoformat)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    HOME.mkdir(parents=True, exist_ok=True)
    lock = open(HOME / "lock", "w")
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        return print("already running")

    state = State()
    todo = candidates(state, args.since)[: args.limit]
    if not todo:
        if not args.dry_run:
            find_places(Supabase(load_env(REPO / ".env")), state)
            state.save()
        return

    # Imported late so the usual run, with nothing new, costs nothing.
    import pillow_heif
    from detect import Detector

    pillow_heif.register_heif_opener()
    env = load_env(REPO / ".env")
    db = Supabase(env)
    learn_logged(db, env, state)
    room = len(todo) if args.dry_run else MAX_PENDING - db.pending()
    detector = Detector()

    for i, (key, path) in enumerate(todo, 1):
        if room <= 0:
            print(f"inbox is full ({MAX_PENDING}); clear some photos")
            break
        try:
            result = process(path, detector, db, state, args.since, args.dry_run)
        except urllib.error.URLError as e:
            # The network or the database, not this photo: stop, and let the next
            # run pick up here without spending one of its attempts.
            detail = e.read().decode(errors="replace")[:300] if isinstance(e, urllib.error.HTTPError) else ""
            print(f"{path.name}: {e} {detail}")
            break
        except Exception as e:
            # Often a file iCloud has not finished fetching. Tried again next run.
            state.tries[key] = state.tries.get(key, 0) + 1
            print(f"{path.name}: {type(e).__name__}: {e}")
            continue
        print(f"{path.name}: {result}", flush=True)
        if result.startswith("FOOD"):
            room -= 1
        if not args.dry_run:
            state.seen[key] = 1
            if i % 25 == 0:
                state.save()

    if not args.dry_run:
        find_places(db, state)
        state.save()


def log_to_file():
    """pythonw has no console, so a scheduled run keeps its own log."""
    HOME.mkdir(parents=True, exist_ok=True)
    path = HOME / "sync.log"
    if path.exists() and path.stat().st_size > 2_000_000:
        os.replace(path, HOME / "sync.log.1")
    sys.stdout = sys.stderr = open(path, "a", encoding="utf8", buffering=1)


if __name__ == "__main__":
    if sys.stdout is None:
        log_to_file()
    try:
        main()
    except Exception:
        print(datetime.now().isoformat(timespec="seconds"))
        traceback.print_exc()
        sys.exit(1)
