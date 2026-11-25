"""Run: python scripts/food-inbox/sync_test.py"""
from PIL import Image

from sync import dhash, position, same, taken_at


class Exif(dict):
    def get_ifd(self, tag):
        return self.get(tag, {})


gps = {1: "N", 2: (40.0, 45.0, 0.0), 3: "W", 4: (73.0, 59.0, 24.0)}
assert position(Exif({0x8825: gps})) == (40.75, -73.99)
assert position(Exif({0x8825: {**gps, 3: "E"}})) == (40.75, 73.99)
assert position(Exif()) == (None, None)
assert position(Exif({0x8825: {1: "N", 2: (0, 0, 0), 3: "E", 4: (0, 0, 0)}})) == (None, None)

assert taken_at(Exif({0x8769: {0x9003: "2026:11:01 19:40:00"}})) == "2026-11-01T19:40:00"
assert taken_at(Exif({0x8769: {0x9003: "0000:00:00 00:00:00"}})) is None
assert taken_at(Exif()) is None

grad = Image.linear_gradient("L").rotate(90)
assert same(dhash(grad), dhash(grad.resize((97, 130))))
assert not same(dhash(grad), dhash(grad.rotate(180)))
print("food inbox sync: ok")
