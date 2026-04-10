import Phaser from "phaser";
import { BackgroundManager } from "../systems/BackgroundManager.js";
import { PlatformManager }   from "../systems/PlatformManager.js";
import { CatPlayer }         from "../systems/CatPlayer.js";
import { ObstacleManager }   from "../systems/ObstacleManager.js";
import { CatcherEnemy }      from "../systems/CatcherEnemy.js";

// Maximum physics step size (ms).
// First browser frames often deliver a huge delta (100-500 ms) because the
// JS engine just warmed up or assets finished decoding.  Without this cap
// every physics value (gravity, creep, coyote, bob) takes a giant step on
// frame 1, causing objects to teleport then snap back — appearing as a
// slow-motion freeze at startup.
const MAX_DELTA_MS = 50;

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
    this._collisionGrace = 1500; // ms grace period after spawn
    this._hitCooldown    = 0;    // ms per-hit invincibility window

    // Duration of the invincibility window after each hit.
    // CatPlayer.triggerHit() uses the same value so the flicker ends exactly
    // when the window closes — giving the player a clear "safe again" cue.
    this._HIT_COOLDOWN_MS = 1200;
  }

  update(_time, delta) {
    // ── Delta clamp ───────────────────────────────────────────────────────
    // Prevent first-frame spikes from producing a huge physics step.
    const safeDelta = Math.min(delta, MAX_DELTA_MS);

    // ── Day / night cycle ─────────────────────────────────────────────────
    this._cycleElapsed += safeDelta;
    const cycleProgress =
      (this._cycleElapsed % this._CYCLE_DURATION_MS) / this._CYCLE_DURATION_MS;
    this._bg.setCycleProgress(cycleProgress);
    this._bg.update(safeDelta);

    // ── Platforms ─────────────────────────────────────────────────────────
    this._platforms.update(safeDelta);

    // ── Obstacles ─────────────────────────────────────────────────────────
    this._obstacles.update(safeDelta, this._cat.sprite);

    // ── Player ────────────────────────────────────────────────────────────
    this._cat.update(safeDelta);

    // ── Catcher ───────────────────────────────────────────────────────────
    const catchDone = this._catcher.update(safeDelta, this._cat.sprite);
    if (catchDone) {
      this._cat.destroy();
      this._catcher.destroy();
      this._obstacles.destroy();
      this.scene.restart();
      return;
    }

    // ── Collision detection ───────────────────────────────────────────────
    if (this._collisionGrace > 0) {
      this._collisionGrace -= safeDelta;
    }
    if (this._hitCooldown > 0) {
      this._hitCooldown -= safeDelta;
    }

    if (
      this._collisionGrace <= 0 &&
      this._hitCooldown    <= 0 &&
      this._obstacles.collision
    ) {
      this._obstacles.collision = false;

      // ── Hit feedback ──────────────────────────────────────────────────
      // Camera shake — short, sharp jolt so the player feels the impact.
      this.cameras.main.shake(180, 0.009);

      // Cat squish + alpha flicker for the full invincibility window.
      // Flicker duration matches _HIT_COOLDOWN_MS so it stops the exact
      // moment the cat becomes vulnerable again.
      this._cat.triggerHit(this._HIT_COOLDOWN_MS);

      // ── Pressure system ───────────────────────────────────────────────
      // Move the catcher closer (crash 1 & 2) or trigger the final catch
      // sequence (crash 3).  The catcher manages its own state machine;
      // calling this on crash 3 starts the "catcher_catch" animation and
      // hides the cat sprite, then GameScene.update() receives true next
      // frame and calls scene.restart().
      this._catcher.onObstacleHit();

      // Block further hits for the cooldown window.
      this._hitCooldown = this._HIT_COOLDOWN_MS;
    }
  }
}
