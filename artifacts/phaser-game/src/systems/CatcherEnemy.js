// ---------------------------------------------------------------------------
// CatcherEnemy — state-driven chaser enemy.
//
// State machine
// ─────────────
//   catcherState = 'run'   → chasing the cat; normal physics + movement
//   catcherState = 'catch' → final catch animation plays (crash 3 only)
//   catcherState = 'done'  → signals GameScene to restart
//
// Crash system
// ────────────
//   crashCount 0 → 1  :  catcher moves to CATCH_UP_STEPS[1] (closer), gameplay continues
//   crashCount 1 → 2  :  catcher moves to CATCH_UP_STEPS[2] (closer), gameplay continues
//   crashCount 2 → 3  :  _beginFinalCatch() — catcher_catch plays, then game restarts
//
// Movement
// ────────
//   Horizontal X is updated in ONE place only: _updateCatcherMovement().
//   Vertical Y uses real Arcade physics (gravity + platform collider + floor clamp).
//   minCatcherDistance is enforced every frame after movement.
//
// ---------------------------------------------------------------------------

import Phaser from "phaser";

// ── Layout (must match GameScene / ObstacleManager) ─────────────────────────
const CAT_X     = 80;   // Cat's fixed screen X
const SURFACE_Y = 195;  // Ground surface Y (feet / origin bottom)

// ── Render ───────────────────────────────────────────────────────────────────
const CATCHER_SCALE = 0.5;  // 128×128 source → 64×64 display
const CHASE_DEPTH   = 15;
const CATCH_DEPTH   = 25;

// ── Physics (identical to CatPlayer) ────────────────────────────────────────
const GRAVITY_Y = 900;
const JUMP_VEL  = -380;
const COYOTE_MS = 150;

// Hitbox (same geometry as cat)
const BODY_WIDTH    = 28;
const BODY_HEIGHT   = 40;
const BODY_OFFSET_X = 22;
const BODY_OFFSET_Y = 76;

// ── Chase behaviour ──────────────────────────────────────────────────────────
// CATCHUP_SPEED: natural creep toward cat between crashes (px/s)
const CATCHUP_SPEED = 3;

// minCatcherDistance: catcher.x must always be <= cat.x - this value
const MIN_CATCHER_DISTANCE = 20;

// Distance (px behind cat) after each crash:
//   index 0 = start / after crash 0   (no crash yet)
//   index 1 = after crash 1
//   index 2 = after crash 2
//   crash 3 → final catch
const CATCH_UP_STEPS = [85, 50, 20];

// ── Crash system ─────────────────────────────────────────────────────────────
const MAX_CRASHES_BEFORE_CAUGHT = 3;

// ── Catch animation ──────────────────────────────────────────────────────────
const CATCH_ANIM_MS = 900; // ms the catcher_catch animation plays

// ── Bob ──────────────────────────────────────────────────────────────────────
const BOB_AMPLITUDE = 3;      // px
const BOB_SPEED     = 0.0025; // rad/ms

// ── HUD scalebar ─────────────────────────────────────────────────────────────
const BAR_X = 10;
const BAR_Y = 10;
const SEG_W = 18;
const SEG_H = 7;
const SEG_GAP = 3;
const COL_EMPTY   = 0x222233;
const SEG_COLOURS = [0xFF8800, 0xFF3300, 0xFF0000];

// ---------------------------------------------------------------------------

export class CatcherEnemy {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this._scene = scene;

    // ── Core state ──────────────────────────────────────────────────────────
    this.catcherState = 'run'; // 'run' | 'catch' | 'done'
    this.crashCount   = 0;
    this.isCaught     = false;
    this._timer       = 0;
    this._catSprite   = null;

    // ── Physics sub-state ───────────────────────────────────────────────────
    // isGrounded: true from frame 1 so the catcher never falls through the floor
    this.isGrounded  = true;
    this._coyoteMs   = 0;
    this._jumpRequested = false;

    // ── Distance tracking ───────────────────────────────────────────────────
    // _distance = how many px the catcher is behind the cat
    // catcher.x = CAT_X - _distance
    this._distance = CATCH_UP_STEPS[0]; // 85 px at start

    // ── Bob ─────────────────────────────────────────────────────────────────
    this._bobTime = 0;

    // ── Animations (register once per scene) ────────────────────────────────
    if (!scene.anims.exists('catcher-run')) {
      scene.anims.create({
        key:       'catcher-run',
        frames:    scene.anims.generateFrameNumbers('catcher_run', { start: 0, end: 3 }),
        frameRate: 10,
        repeat:    -1,
      });
    }
    if (!scene.anims.exists('catcher-catch')) {
      scene.anims.create({
        key:       'catcher-catch',
        frames:    scene.anims.generateFrameNumbers('catcher_catch', { start: 0, end: 1 }),
        frameRate: 5,
        repeat:    -1,
      });
    }

    // ── Physics sprite ───────────────────────────────────────────────────────
    const startX = CAT_X - this._distance;
    this._sprite = scene.physics.add.sprite(startX, SURFACE_Y, 'catcher_run');
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setScale(CATCHER_SCALE);
    this._sprite.setDepth(CHASE_DEPTH);
    this._sprite.play('catcher-run');

    // Physics body — identical setup to CatPlayer.
    const body = this._sprite.body;
    body.setGravityY(GRAVITY_Y);
    body.setCollideWorldBounds(false); // X is driven manually; world bounds cause jitter
    body.setSize(BODY_WIDTH, BODY_HEIGHT, false);
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
    // Start with zero vertical velocity so the catcher is grounded from frame 1.
    body.setVelocityY(0);
    body.setVelocityX(0);

    // One-way platform collider (same rule as cat: only blocks when falling).
    scene.physics.add.collider(
      this._sprite,
      scene._platforms.group,
      null,
      (catcher, _platform) => catcher.body.velocity.y >= 0,
    );

    // ── Input ────────────────────────────────────────────────────────────────
    this._keys = scene.input.keyboard.addKeys({
      space: Phaser.Input.Keyboard.KeyCodes.SPACE,
    });
    this._onPointerDown = () => { this._jumpRequested = true; };
    scene.input.on('pointerdown', this._onPointerDown);

    // ── HUD danger scalebar ──────────────────────────────────────────────────
    this._barSegs = [];
    for (let i = 0; i < MAX_CRASHES_BEFORE_CAUGHT; i++) {
      const x = BAR_X + i * (SEG_W + SEG_GAP);
      scene.add.rectangle(x + SEG_W / 2, BAR_Y + SEG_H / 2, SEG_W, SEG_H, COL_EMPTY)
        .setDepth(100).setScrollFactor(0);
      const fill = scene.add.rectangle(x + SEG_W / 2, BAR_Y + SEG_H / 2, SEG_W, SEG_H, SEG_COLOURS[i])
        .setDepth(101).setScrollFactor(0).setVisible(false);
      this._barSegs.push(fill);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Called by GameScene when the cat collides with an obstacle.
   *
   *  crash 1 → catcher jumps to CATCH_UP_STEPS[1], gameplay continues
   *  crash 2 → catcher jumps to CATCH_UP_STEPS[2], gameplay continues
   *  crash 3 → final catch sequence → game restarts
   */
  onObstacleHit() {
    if (this.catcherState !== 'run') return;

    this.crashCount++;
    this._activateBarSegment(this.crashCount - 1);

    if (this.crashCount >= MAX_CRASHES_BEFORE_CAUGHT) {
      // ── Third crash: final catch ─────────────────────────────────────
      this._beginFinalCatch();
    } else {
      // ── First / second crash: catch-up only ──────────────────────────
      // Snap the catcher to the next closer stage (but never past minCatcherDistance).
      const targetDistance = CATCH_UP_STEPS[this.crashCount];
      this._distance = Math.max(MIN_CATCHER_DISTANCE, Math.min(this._distance, targetDistance));
      // X will be applied on the next _updateCatcherMovement() call.
    }
  }

  /**
   * Main update — called every frame by GameScene.
   * @param {number}                    delta      Phaser delta ms
   * @param {Phaser.GameObjects.Sprite} catSprite
   * @returns {boolean}  true → GameScene should restart
   */
  update(delta, catSprite) {
    this._catSprite = catSprite;

    switch (this.catcherState) {

      case 'run':
        this._updateChasing(delta);
        break;

      case 'catch':
        this._timer += delta;
        if (this._timer >= CATCH_ANIM_MS) {
          this.catcherState = 'done';
        }
        break;

      case 'done':
        return true;
    }

    return false;
  }

  destroy() {
    this._scene.input.off('pointerdown', this._onPointerDown);
    this._sprite.destroy();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Full per-frame update for the 'run' (chasing) state.
   *
   * Frame order (per spec section 9):
   *   1. Gravity / vertical velocity  — handled by Arcade physics before this call
   *   2. Floor clamp                  — enforce SURFACE_Y as a hard ground floor
   *   3. Resolve grounded state       — body.blocked.down OR at SURFACE_Y
   *   4. Coyote window tick
   *   5. Natural creep (horizontal)
   *   6. _updateCatcherMovement()     — single authoritative X update
   *   7. Enforce minCatcherDistance   — safety clamp after movement
   *   8. Vertical bob (grounded only)
   *   9. Jump input
   *  10. _updateCatcherAnimation()
   */
  _updateChasing(delta) {
    const body = this._sprite.body;

    // ── 2. Floor clamp ───────────────────────────────────────────────────────
    // The catcher starts off-screen left (no platform tile exists at x ≈ −5).
    // Without a tile, body.blocked.down is never true and gravity would drag
    // the catcher off the canvas. Treat SURFACE_Y as an unconditional ground floor.
    if (this._sprite.y >= SURFACE_Y) {
      this._sprite.setY(SURFACE_Y);
      body.setVelocityY(0);
      this.isGrounded = true;
      this._coyoteMs  = 0;
    }

    // ── 3. Grounded state ────────────────────────────────────────────────────
    const blockedBelow = body.blocked.down;
    const atFloor      = this._sprite.y >= SURFACE_Y;

    if (blockedBelow || atFloor) {
      if (!this.isGrounded) {
        // Just landed.
        this.isGrounded = true;
        this._coyoteMs  = 0;
      }
    } else {
      if (this.isGrounded) {
        // Just left the ground — open coyote window.
        this._coyoteMs  = COYOTE_MS;
        this.isGrounded = false;
      }
    }

    // ── 4. Coyote window ────────────────────────────────────────────────────
    if (this._coyoteMs > 0) {
      this._coyoteMs = Math.max(0, this._coyoteMs - delta);
    }

    // ── 5. Natural creep ─────────────────────────────────────────────────────
    this._distance = Math.max(
      MIN_CATCHER_DISTANCE,
      this._distance - CATCHUP_SPEED * (delta / 1000),
    );

    // ── 6. Single X update ───────────────────────────────────────────────────
    this._updateCatcherMovement();

    // ── 7. Enforce minCatcherDistance (safety clamp) ─────────────────────────
    const maxAllowedX = CAT_X - MIN_CATCHER_DISTANCE;
    if (this._sprite.x > maxAllowedX) {
      this._sprite.setX(maxAllowedX);
      this._distance = MIN_CATCHER_DISTANCE;
    }

    // ── 8. Vertical bob (grounded only) ──────────────────────────────────────
    this._bobTime += delta;
    if (this.isGrounded) {
      const bobY = Math.sin(this._bobTime * BOB_SPEED) * BOB_AMPLITUDE;
      this._sprite.setY(SURFACE_Y + bobY);
      body.setVelocityY(0);
    }

    // ── Body offset (re-apply each frame — Phaser anims may reset it) ────────
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

    // ── 9. Jump input ────────────────────────────────────────────────────────
    const canJump = this.isGrounded || this._coyoteMs > 0;
    const keyDown = Phaser.Input.Keyboard.JustDown(this._keys.space);
    if (canJump && (keyDown || this._jumpRequested)) {
      body.setVelocityY(JUMP_VEL);
      this.isGrounded = false;
      this._coyoteMs  = 0;
      this._sprite.anims.stop();
      this._sprite.setFrame(2); // ascent frame
      body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
    }
    this._jumpRequested = false;

    // ── 10. Animation ────────────────────────────────────────────────────────
    this._updateCatcherAnimation(body);
  }

  /**
   * Single authoritative horizontal position update.
   * No other code path may modify this._sprite.x during the 'run' state.
   */
  _updateCatcherMovement() {
    this._sprite.setX(CAT_X - this._distance);
    this._sprite.body.setVelocityX(0);
  }

  /**
   * Drive catcher_run or airborne frame based on isGrounded / velocity.
   * catcher_catch is never triggered here — only in _beginFinalCatch().
   */
  _updateCatcherAnimation(body) {
    if (this.isGrounded) {
      // Grounded: ensure the 4-frame run loop is playing.
      const current = this._sprite.anims.currentAnim;
      if (!this._sprite.anims.isPlaying || current?.key !== 'catcher-run') {
        this._sprite.play('catcher-run');
        body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
      }
    } else {
      // Airborne: static frame (ascending = 2, descending = 3).
      this._sprite.anims.stop();
      this._sprite.setFrame(body.velocity.y < 0 ? 2 : 3);
      body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
    }
  }

  /**
   * Triggered ONLY on the third crash (crashCount >= MAX_CRASHES_BEFORE_CAUGHT).
   * Switches to catcher_catch (2-frame) animation and hides the cat.
   */
  _beginFinalCatch() {
    this.catcherState = 'catch';
    this.isCaught     = true;
    this._timer       = 0;

    // Move catcher to cat position for the catch sequence.
    this._sprite.setX(CAT_X + 10);
    this._sprite.setDepth(CATCH_DEPTH);

    // Play the 2-frame catch animation (NOT used during crashes 1 or 2).
    this._sprite.play('catcher-catch');

    // Hide the cat — it has been caught.
    if (this._catSprite) this._catSprite.setVisible(false);
  }

  _activateBarSegment(i) {
    if (i >= 0 && i < this._barSegs.length) {
      this._barSegs[i].setVisible(true);
    }
  }
}
