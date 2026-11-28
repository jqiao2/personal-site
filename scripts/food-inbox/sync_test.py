"""Run: python scripts/food-inbox/sync_test.py"""
from PIL import Image

from sync import box_around, dhash, normalize, osm_place, position, same, taken_at


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

# Must agree with src/lib/gazetteer.ts, or a search never finds what was stored.
assert normalize("Café Crème & Co.") == "CAFE CREME CO"
assert normalize("  Wu's ") == "WU S"

south, north, west, east = box_around(38.93, -74.92, 150)
assert abs((north - south) * 111_320 - 300) < 1 and west < -74.92 < east

hit = {
    "osm_type": "way", "osm_id": 1, "name": "Blue Moon Pizza", "lat": "38.93", "lon": "-74.92", "type": "restaurant",
    "address": {"house_number": "1", "road": "Beach Avenue", "town": "Cape May", "state": "New Jersey", "country_code": "us"},
    "extratags": {"cuisine": "pizza;italian"},
}
place = osm_place(hit)
assert place["source_id"] == "way/1" and place["city"] == "Cape May" and place["country"] == "US"
assert place["address"] == "1 Beach Avenue" and place["cuisines"] == ["Pizza", "Italian"]
assert osm_place({**hit, "extratags": {}})["cuisines"] == ["Restaurant"]
print("food inbox sync: ok")
