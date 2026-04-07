import Phaser from "phaser";
import { BackgroundManager } from "../systems/BackgroundManager.js";
import { PlatformManager }   from "../systems/PlatformManager.js";
import { CatPlayer }         from "../systems/CatPlayer.js";
import { ObstacleManager }   from "../systems/ObstacleManager.js";
import { CatcherEnemy }      from "../systems/CatcherEnemy.js";

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

    // ── Catcher enemy ──────────────────────────────────────────────────
    // catcher_run.png  — 512×128, 4 frames (128×128 each)
    // catcher_catch.png — 256×128, 2 frames (128×128 each)
    this.load.spritesheet("catcher_run", "assets/enemy/catcher_run.png", {
      frameWidth:  128,
      frameHeight: 128,
    });
    this.load.spritesheet("catcher_catch", "assets/enemy/catcher_catch.png", {
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

    // ── Catcher (created before cat so it renders behind) ─────────────────
    this._catcher = new CatcherEnemy(this);

    // ── Obstacles ─────────────────────────────────────────────────────────
    this._obstacles = new ObstacleManager(this);

    // Wire PlatformManager → ObstacleManager so each new segment can spawn
    // obstacles going forward.
    this._platforms.onSegmentSpawned = (seg) => {
      this._obstacles.onSegmentSpawned(seg);
    };

    // Replay seed segments so obstacles appear immediately.
    const seeded = this._platforms.segments;
    for (let i = 0; i < seeded.length; i++) {
      this._obstacles.onSegmentSpawned(seeded[i]);
    }

    // ── Player ────────────────────────────────────────────────────────────
    this._cat = new CatPlayer(this, this._platforms.group, this._platforms.surfaceY);

    // ── Animations ────────────────────────────────────────────────────────
    // Flying bird: 2-frame loop.
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

    // ── Collision / hit state ─────────────────────────────────────────────
    // Grace period after spawn before any collisions register.
    this._collisionGrace = 1500; // ms

    // Per-hit invincibility window so the cat can't be penalised on every
    // frame of the same collision.  Reset when a new hit is accepted.
    this._hitCooldown = 0; // ms
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

    // ── Catcher ───────────────────────────────────────────────────────────
    // update() returns true when the catch sequence is fully complete.
    const catchDone = this._catcher.update(delta, this._cat.sprite);
    if (catchDone) {
      this._cat.destroy();
      this._catcher.destroy();
      this._obstacles.destroy();
      this.scene.restart();
      return;
    }

    // ── Collision detection ────────────────────────────────────────────────
    // Tick timers.
    if (this._collisionGrace > 0) {
      this._collisionGrace -= delta;
    }
    if (this._hitCooldown > 0) {
      this._hitCooldown -= delta;
    }

    // Only process a new hit when both grace periods have expired.
    // The per-hit cooldown prevents the same collision from firing every frame
    // while the cat is still overlapping an obstacle body.
    if (
      this._collisionGrace <= 0 &&
      this._hitCooldown    <= 0 &&
      this._obstacles.collision
    ) {
      // Clear the flag immediately so it doesn't re-fire next frame.
      this._obstacles.collision = false;

      // Trigger the catcher lunge.  The catcher hides/shows the cat sprite
      // itself and manages its own state machine (ignores calls while already
      // in a catching animation, so no additional guard needed here).
      this._catcher.onObstacleHit();

      // Block further hits for 1.5 s — gives the 900 ms catch anim time to
      // complete and the cat to reappear before another collision can register.
      this._hitCooldown = 1500;
    }
  }
}
