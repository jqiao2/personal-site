// Fake subway system (schematic, hand-placed coordinates in a 900x1440 canvas).
// Station entry: ["Name", x, y]. Stations shared across routes (same id) become transfers.
// "Grandview X" is shared by the Red Express and Blue lines -> transfer node.

export const ROUTES = [
  { svc: "R", name: "Red Local", color: "#EE352E", stations: [
    ["Ashwood", 380, 180], ["Belmont", 380, 300], ["Carver", 380, 420], ["Dunmore", 380, 540],
    ["Elmhurst", 380, 660], ["Fairview", 380, 780], ["Grandview", 380, 900], ["Hollis", 380, 1020],
    ["Ironside", 380, 1140], ["Junction", 380, 1260]
  ] },
  { svc: "RX", name: "Red Express", color: "#B01F26", bow: 62, stations: [
    ["Carver", 380, 420], ["Fairview", 380, 780], ["Grandview", 380, 900], ["Junction", 380, 1260]
  ] },
  { svc: "B", name: "Blue", color: "#0039A6", stations: [
    ["Westgate", 170, 900], ["Grandview", 380, 900], ["Eastport", 720, 900]
  ] }
];

export const SERVICE_ORDER = ["R", "RX", "B"];
