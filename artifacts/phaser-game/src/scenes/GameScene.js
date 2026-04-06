import Phaser from "phaser";
import { BackgroundManager } from "../systems/BackgroundManager.js";
import { PlatformManager }   from "../systems/PlatformManager.js";
import { CatPlayer }         from "../systems/CatPlayer.js";
import { ObstacleManager }   from "../systems/ObstacleManager.js";

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

    // ── Rooftop obstacles ──────────────────────────────────────────────
    this.load.image("chimney",  "assets/obstacles/chimney.png");
    this.load.image("antenna",  "assets/obstacles/antenna.png");
    this.load.image("vent",     "assets/obstacles/vent.png");
    this.load.image("bird",     "assets/obstacles/bird.png");

    // ── Airborne obstacles ─────────────────────────────────────────────
    // bird_fly.png is a 256×128 spritesheet with 2 frames (128×128 each).
    this.load.spritesheet("bird_fly", "assets/obstacles/bird_fly.png", {
      frameWidth:  128,
      frameHeight: 128,
    });

    // ── Cat ────────────────────────────────────────────────────────────
    this.load.image("cat_start", "assets/cat/cat_start.png");
    this.load.spritesheet("cat_run", "assets/cat/cat_run.png", {
      frameWidth:  128,
      frameHeight: 128,
    });
  }

  create() {
    this.cameras.main.setBackgroundColor(0x000000);

    // ── Background ────────────────────────────────────────────────────────
    this._bg = new BackgroundManager(this);

    // ── Platforms ─────────────────────────────────────────────────────────
    this._platforms = new PlatformManager(this);

    // ── Obstacles ─────────────────────────────────────────────────────────
    this._obstacles = new ObstacleManager(this);

    // Wire PlatformManager → ObstacleManager so each new segment can spawn
    // obstacles going forward.
    this._platforms.onSegmentSpawned = (seg) => {
      this._obstacles.onSegmentSpawned(seg);
    };

    // The initial seed segments were built inside PlatformManager's constructor
    // before the callback was installed.  Replay them all now so obstacles are
    // seeded immediately — the ObstacleManager already skips the first tile of
    // every segment, giving the cat enough clear runway on each roof.
    const seeded = this._platforms.segments;
    for (let i = 0; i < seeded.length; i++) {
      this._obstacles.onSegmentSpawned(seeded[i]);
    }

    // ── Player ────────────────────────────────────────────────────────────
    this._cat = new CatPlayer(this, this._platforms.group, this._platforms.surfaceY);

    // ── Animations ────────────────────────────────────────────────────────
    // Flying bird: 2-frame loop from the 256×128 spritesheet.
    if (!this.anims.exists("bird_fly")) {
      this.anims.create({
        key:       "bird_fly",
        frames:    this.anims.generateFrameNumbers("bird_fly", { start: 0, end: 1 }),
        frameRate: 6,
        repeat:    -1,
      });
    }

    // ── Day / night cycle ─────────────────────────────────────────────────
    this._CYCLE_DURATION_MS = 80_000;
    this._cycleElapsed = 0;
    this._bg.setCycleProgress(0);

    // ── Collision cooldown ────────────────────────────────────────────────
    // Brief grace period after a scene restart so the cat isn't immediately
    // killed by an obstacle that spawns at its position.
    this._collisionGrace = 1500; // ms — no collision checks for first 1.5 s
  }

  update(_time, delta) {
    // ── Day / night cycle ─────────────────────────────────────────────────
    this._cycleElapsed += delta;
    const cycleProgress =
      (this._cycleElapsed % this._CYCLE_DURATION_MS) / this._CYCLE_DURATION_MS;
    this._bg.setCycleProgress(cycleProgress);
    this._bg.update(delta);

    // ── Platforms ─────────────────────────────────────────────────────────
    this._platforms.update(delta);

    // ── Obstacles ─────────────────────────────────────────────────────────
    this._obstacles.update(delta, this._cat.sprite);

    // ── Player ────────────────────────────────────────────────────────────
    this._cat.update(delta);

    // ── Collision detection ────────────────────────────────────────────────
    // Tick down the grace period; only check collisions once it expires.
    if (this._collisionGrace > 0) {
      this._collisionGrace -= delta;
    } else if (this._obstacles.collision) {
      // Cat hit an obstacle — clean up listeners and restart.
      this._cat.destroy();
      this._obstacles.destroy();
      this.scene.restart();
    }
  }
}
