import Phaser from "phaser";
import { BackgroundManager } from "../systems/BackgroundManager.js";

export default class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: "GameScene" });
  }

  preload() {
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
    this.load.image("cat_start", "assets/cat/cat_start.png");
    this.load.spritesheet("cat_run", "assets/cat/cat_run.png", {
      frameWidth: 128,
      frameHeight: 128,
    });

    // ── Enemy ──────────────────────────────────────────────────────────
    // catcher_run: 512 × 128 → 4 frames of 128 × 128
    this.load.spritesheet("catcher_run", "assets/enemy/catcher_run.png", {
      frameWidth: 128,
      frameHeight: 128,
    });
    // catcher_catch: 256 × 128 → 2 frames of 128 × 128
    this.load.spritesheet("catcher_catch", "assets/enemy/catcher_catch.png", {
      frameWidth: 128,
      frameHeight: 128,
    });
  }

  create() {
    // Disable the default black camera background so the gradient layer
    // is the only sky colour source.
    this.cameras.main.setBackgroundColor(0x000000);

    // Build the parallax background system.
    this._bg = new BackgroundManager(this);

    // Start at night (progress 0 = fully night).
    this._bg.setDayNightProgress(0);
  }

  update(_time, delta) {
    // Pass delta to the background manager.
    // worldDelta is left undefined here so BackgroundManager auto-scrolls
    // at a steady pace for preview.  Once gameplay is added, pass the
    // real world-scroll amount instead.
    this._bg.update(delta);
  }
}
