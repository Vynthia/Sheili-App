import Phaser from "phaser";
import { BackgroundManager } from "../systems/BackgroundManager.js";
import { PlatformManager }   from "../systems/PlatformManager.js";
import { CatPlayer }         from "../systems/CatPlayer.js";

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

    // ── Cat ────────────────────────────────────────────────────────────
    // cat_start is a single 128 × 128 idle pose.
    this.load.image("cat_start", "assets/cat/cat_start.png");
    // cat_run is a 512 × 128 horizontal spritesheet — 4 frames of 128 × 128.
    this.load.spritesheet("cat_run", "assets/cat/cat_run.png", {
      frameWidth:  128,
      frameHeight: 128,
    });
  }

  create() {
    // Disable the default black camera background so the gradient layer
    // is the only sky colour source.
    this.cameras.main.setBackgroundColor(0x000000);

    // ── Background ────────────────────────────────────────────────────────
    this._bg = new BackgroundManager(this);

    // ── Platforms ─────────────────────────────────────────────────────────
    this._platforms = new PlatformManager(this);

    // ── Player ────────────────────────────────────────────────────────────
    // CatPlayer adds itself to the scene and attaches its own collider with
    // the platform StaticGroup; no further wiring needed here.
    this._cat = new CatPlayer(this, this._platforms.group, this._platforms.surfaceY);

    // ── Day / night cycle ─────────────────────────────────────────────────
    this._CYCLE_DURATION_MS = 80_000; // 80 s total (40 s night + 40 s day)
    this._cycleElapsed = 0;
    this._bg.setCycleProgress(0);
  }

  update(_time, delta) {
    // Advance the cycle clock.
    this._cycleElapsed += delta;
    const cycleProgress =
      (this._cycleElapsed % this._CYCLE_DURATION_MS) / this._CYCLE_DURATION_MS;

    this._bg.setCycleProgress(cycleProgress);
    this._bg.update(delta);

    // Scroll platforms and manage tile recycling.
    this._platforms.update(delta);

    // Update the player (pin x, watch for landing, drive state machine).
    this._cat.update(delta);
  }
}
