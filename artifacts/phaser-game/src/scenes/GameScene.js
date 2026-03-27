import Phaser from "phaser";

export default class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: "GameScene" });
  }

  preload() {
    // Resolve asset paths through Vite's base URL so the loader always
    // finds files whether the game runs at "/" or "/phaser-game/".
    this.load.setBaseURL(import.meta.env.BASE_URL);

    // ── Background layers ──────────────────────────────────────────────
    this.load.image("sky_night",     "assets/bg/sky_night.png");
    this.load.image("sky_day",       "assets/bg/sky_day.png");
    this.load.image("skyline_far",   "assets/bg/skyline_far.png");
    this.load.image("buildings_mid", "assets/bg/buildings_mid.png");
    this.load.image("roofs_back",    "assets/bg/roofs_back.png");
    this.load.image("moon",          "assets/bg/moon.png");
    this.load.image("sun",           "assets/bg/sun.png");

    // ── Platform tiles ─────────────────────────────────────────────────
    this.load.image("roof_left",    "assets/platform/roof_left.png");
    this.load.image("roof_middle",  "assets/platform/roof_middle.png");
    this.load.image("roof_right",   "assets/platform/roof_right.png");
    this.load.image("roof_landing", "assets/platform/roof_landing.png");

    // ── Obstacles ──────────────────────────────────────────────────────
    this.load.image("chimney",  "assets/obstacles/chimney.png");
    this.load.image("antenna",  "assets/obstacles/antenna.png");
    this.load.image("vent",     "assets/obstacles/vent.png");
    this.load.image("skylight", "assets/obstacles/skylight.png");

    // ── Cat ────────────────────────────────────────────────────────────
    // cat_start is a single static image (idle/sitting pose)
    this.load.image("cat_start", "assets/cat/cat_start.png");

    // cat_run is a horizontal strip: 512 × 128 → 4 frames of 128 × 128
    this.load.spritesheet("cat_run", "assets/cat/cat_run.png", {
      frameWidth: 128,
      frameHeight: 128,
    });

    // ── Enemy ──────────────────────────────────────────────────────────
    // catcher_run is a horizontal strip: 512 × 128 → 4 frames of 128 × 128
    this.load.spritesheet("catcher_run", "assets/enemy/catcher_run.png", {
      frameWidth: 128,
      frameHeight: 128,
    });

    // catcher_catch is a horizontal strip: 256 × 128 → 2 frames of 128 × 128
    this.load.spritesheet("catcher_catch", "assets/enemy/catcher_catch.png", {
      frameWidth: 128,
      frameHeight: 128,
    });
  }

  create() {
    const { width, height } = this.scale;

    this.add
      .text(width / 2, height / 2, "Assets loaded.\nReady to build.", {
        fontSize: "18px",
        color: "#ffffff",
        align: "center",
        lineSpacing: 8,
      })
      .setOrigin(0.5);

    // Confirm each key loaded successfully to the console (dev aid).
    const keys = [
      "sky_night", "sky_day", "skyline_far", "buildings_mid",
      "roofs_back", "moon", "sun",
      "roof_left", "roof_middle", "roof_right", "roof_landing",
      "chimney", "antenna", "vent", "skylight",
      "cat_start", "cat_run",
      "catcher_run", "catcher_catch",
    ];
    const missing = keys.filter((k) => !this.textures.exists(k));
    if (missing.length) {
      console.warn("Missing textures:", missing);
    } else {
      console.log("All textures loaded successfully.");
    }
  }

  update(_time, _delta) {
    // Game loop — gameplay will go here.
  }
}
