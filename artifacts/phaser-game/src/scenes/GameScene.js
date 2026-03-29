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

    // ── Day / night cycle ─────────────────────────────────────────────────
    // Full cycle = one moon traversal + one sun traversal.
    // Increase to slow everything down; decrease to speed it up.
    this._CYCLE_DURATION_MS = 80_000; // 80 s total (40 s night + 40 s day)

    // Accumulated scene time in ms.
    this._cycleElapsed = 0;

    // Initialise at the very start of night.
    this._bg.setCycleProgress(0);
  }

  update(_time, delta) {
    // Advance the cycle clock and wrap it within one full cycle.
    this._cycleElapsed += delta;
    const cycleProgress =
      (this._cycleElapsed % this._CYCLE_DURATION_MS) / this._CYCLE_DURATION_MS;

    this._bg.setCycleProgress(cycleProgress);

    // Pass delta to the background manager for parallax scrolling.
    // worldDelta is left undefined so BackgroundManager auto-scrolls at a
    // steady pace for preview; pass the real world-scroll once gameplay exists.
    this._bg.update(delta);
  }
}
