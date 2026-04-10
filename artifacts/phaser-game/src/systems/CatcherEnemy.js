// ---------------------------------------------------------------------------
// CatcherEnemy — physics-correct chasing enemy.
//
// WHY NO PLATFORM PHYSICS COLLIDER
// ─────────────────────────────────
// PlatformManager uses a single static floor body permanently placed at
// CAT_SCREEN_X=80 (not per-tile bodies).  Registering the catcher against
// that group caused two bugs:
//   1. The floor body is only at x=80, never under the catcher → falls through.
//   2. When the catcher is near x=80, its body overlaps the static body and
//      the physics engine pushes it left/right → horizontal jitter.
//
// Instead we do a manual world-space segment check (same data PlatformManager
// uses for the cat) to decide whether the catcher is over solid ground.
// Gravity and vertical velocity still come from Arcade physics (jump works
// correctly); only the grounding snap is done manually.
//
// STATE MACHINE
// ─────────────
//   catcherState = 'run'   → chasing; real physics + terrain check
//   catcherState = 'catch' → final catch animation (crash 3 only)
//   catcherState = 'done'  → GameScene should restart
//
// CRASH SYSTEM
// ────────────
//   crash 1 → catcher moves catcherCatchUpStep px closer, gameplay continues
//   crash 2 → same, slightly closer again
//   crash 3 → _beginFinalCatch() → catcher_catch plays → restart
//
// MINIMUM DISTANCE
// ────────────────
//   minCatcherDistance is enforced in ONE place AFTER all chase / catch-up
//   calculations have been applied (per the spec requirement).
// ---------------------------------------------------------------------------

import Phaser from "phaser";

// ── Layout ───────────────────────────────────────────────────────────────────
const CAT_X     = 80;   // Cat's fixed screen X (must match CatPlayer)
const SURFACE_Y = 195;  // Ground surface Y — feet / origin bottom

// ── Render ───────────────────────────────────────────────────────────────────
const CATCHER_SCALE = 0.5;  // 128×128 source → 64×64 display
const CHASE_DEPTH   = 15;
const CATCH_DEPTH   = 25;

// ── Physics (same values as CatPlayer) ───────────────────────────────────────
const GRAVITY_Y = 900;   // px / s²
const JUMP_VEL  = -380;  // px / s (upward)
const COYOTE_MS = 150;   // ms after leaving ground where jump still works

// ── Hitbox (same geometry as cat — fair platform + obstacle interaction) ─────
const BODY_WIDTH    = 28;
const BODY_HEIGHT   = 40;
const BODY_OFFSET_X = 22;
const BODY_OFFSET_Y = 76;

// ── Chase behaviour ───────────────────────────────────────────────────────────
// Natural creep: catcher closes the gap at CATCHUP_SPEED px/s between crashes.
const CATCHUP_SPEED = 3; // px/s (very slow — only for atmosphere)

// On each crash (1 and 2), move the catcher catcherCatchUpStep px closer.
const CATCHER_CATCH_UP_STEP = 25; // px gained per crash

// Hard minimum gap between catcher and cat, enforced AFTER all calculations.
const MIN_CATCHER_DISTANCE = 20; // px

// ── Crash system ──────────────────────────────────────────────────────────────
const MAX_CRASHES_BEFORE_CAUGHT = 3;

// Starting distance (px behind cat).
const START_DISTANCE = 80;

// ── Catch animation ───────────────────────────────────────────────────────────
const CATCH_ANIM_MS = 900; // ms the catcher_catch animation plays

// ── Bob (ground-only cosmetic) ────────────────────────────────────────────────
const BOB_AMPLITUDE = 3;      // px
const BOB_SPEED     = 0.0025; // rad/ms

// ── HUD scalebar ──────────────────────────────────────────────────────────────
const BAR_X     = 10;
const BAR_Y     = 10;
const SEG_W     = 18;
const SEG_H     = 7;
const SEG_GAP   = 3;
const COL_EMPTY   = 0x222233;
const SEG_COLOURS = [0xFF8800, 0xFF3300, 0xFF0000];

// ---------------------------------------------------------------------------

export class CatcherEnemy {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this._scene = scene;

    // ── Core state ────────────────────────────────────────────────────────
    this.catcherState = 'run'; // 'run' | 'catch' | 'done'
    this.crashCount   = 0;
    this.isCaught     = false;
    this._timer       = 0;
    this._catSprite   = null;

    // ── Physics sub-state ─────────────────────────────────────────────────
    // isGrounded starts true so catcher is grounded from frame 1.
    this.isGrounded = true;
    this._coyoteMs  = 0;
    this._jumpRequested = false;

    // ── Distance / horizontal state ───────────────────────────────────────
    // _distance = how many px the catcher is behind the cat.
    // catcher.x = CAT_X - _distance  (set in one place: _updateCatcherMovement)
    this._distance = START_DISTANCE;

    // ── Bob ───────────────────────────────────────────────────────────────
    this._bobTime = 0;

    // ── Animations (register once per scene) ─────────────────────────────
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

    // ── Physics sprite ────────────────────────────────────────────────────
    const startX = CAT_X - this._distance;
    this._sprite = scene.physics.add.sprite(startX, SURFACE_Y, 'catcher_run');
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setScale(CATCHER_SCALE);
    this._sprite.setDepth(CHASE_DEPTH);
    this._sprite.play('catcher-run');

    // Physics body — gravity only.
    // NO platform collider: PlatformManager's single static body is at x=80
    // and causes horizontal jitter when the catcher overlaps it.
    // Ground detection is handled manually via world-space segment checks.
    const body = this._sprite.body;
    body.setGravityY(GRAVITY_Y);
    body.setCollideWorldBounds(false);
    body.setSize(BODY_WIDTH, BODY_HEIGHT, false);
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
    body.setVelocityX(0);
    body.setVelocityY(0); // start with zero velocity — catcher is grounded from frame 1

    // ── Input ─────────────────────────────────────────────────────────────
    this._keys = scene.input.keyboard.addKeys({
      space: Phaser.Input.Keyboard.KeyCodes.SPACE,
    });
    this._onPointerDown = () => { this._jumpRequested = true; };
    scene.input.on('pointerdown', this._onPointerDown);

    // ── HUD danger scalebar ───────────────────────────────────────────────
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

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Called by GameScene when the cat collides with an obstacle.
   *
   *  crash 1 or 2 → move catcher catcherCatchUpStep px closer, continue play
   *  crash 3      → _beginFinalCatch()
   */
  onObstacleHit() {
    if (this.catcherState !== 'run') return;

    this.crashCount++;
    this._activateBarSegment(this.crashCount - 1);

    if (this.crashCount >= MAX_CRASHES_BEFORE_CAUGHT) {
      this._beginFinalCatch();
    } else {
      // Move closer by catcherCatchUpStep.
      // minCatcherDistance is enforced AFTER this in _updateChasing(),
      // not here, so the catch-up step is applied first (per spec).
      this._distance = Math.max(0, this._distance - CATCHER_CATCH_UP_STEP);
    }
  }

  /**
   * Main update — called every frame by GameScene.
   * @param {number}                    delta
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

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * World-space ground check.
   *
   * PlatformManager stores segments as { worldX, width } and tracks how many
   * px have scrolled as _scrollOffset.  The catcher's world X =
   *   _scrollOffset + sprite.x
   *
   * We check whether that world position overlaps any live segment.
   * This mirrors exactly how PlatformManager enables/disables the cat's
   * static floor body — same data, same logic, different screen position.
   *
   * @returns {boolean}  true if a platform segment is under the catcher
   */
  _isOverPlatform() {
    const pm = this._scene._platforms;
    if (!pm) return true; // fallback: treat as grounded if manager missing

    const scrollPx       = Math.round(pm._scrollOffset);
    const catcherWorldX  = scrollPx + this._sprite.x;
    const segments       = pm._segments;

    for (const seg of segments) {
      if (catcherWorldX >= seg.worldX && catcherWorldX < seg.worldX + seg.width) {
        return true;
      }
    }
    return false;
  }

  /**
   * Full per-frame update for the 'run' state.
   *
   * Frame order (per spec):
   *   1. Gravity / vertical velocity  — Arcade physics (runs before update())
   *   2. World-space ground detection — _isOverPlatform()
   *   3. Resolve grounded state
   *   4. Coyote window tick
   *   5. Natural creep (horizontal, _distance decreases slowly)
   *   6. _updateCatcherMovement() — SINGLE authoritative X + velocityX=0
   *   7. Enforce minCatcherDistance — AFTER all chase / catch-up calculations
   *   8. Vertical snap / bob (grounded only)
   *   9. Jump input
   *  10. Body offset lock
   *  11. _updateCatcherAnimation()
   */
  _updateChasing(delta) {
    const body = this._sprite.body;

    // ── 2. World-space ground detection ──────────────────────────────────
    const overPlatform = this._isOverPlatform();

    // ── 3. Resolve grounded state ────────────────────────────────────────
    if (overPlatform && this._sprite.y >= SURFACE_Y) {
      // Catcher has reached/passed the surface over a real platform → land.
      this._sprite.setY(SURFACE_Y);
      body.setVelocityY(0);

      if (!this.isGrounded) {
        this.isGrounded = true;
        this._coyoteMs  = 0;
      }
    } else if (!overPlatform && this.isGrounded) {
      // Just walked off a platform edge → open coyote window, begin falling.
      this.isGrounded = false;
      this._coyoteMs  = COYOTE_MS;
    }

    // ── 4. Coyote window ─────────────────────────────────────────────────
    if (this._coyoteMs > 0) {
      this._coyoteMs = Math.max(0, this._coyoteMs - delta);
    }

    // ── 5. Natural creep ─────────────────────────────────────────────────
    // Slow passive approach — minCatcherDistance enforced in step 7.
    this._distance -= CATCHUP_SPEED * (delta / 1000);

    // ── 6. Single authoritative X update ────────────────────────────────
    this._updateCatcherMovement();

    // ── 7. Enforce minCatcherDistance AFTER all chase calculations ───────
    // Applied here — never before — so catch-up steps are fully computed first.
    if (this._distance < MIN_CATCHER_DISTANCE) {
      this._distance = MIN_CATCHER_DISTANCE;
      this._sprite.setX(CAT_X - MIN_CATCHER_DISTANCE);
    }

    // ── 8. Vertical snap / bob ───────────────────────────────────────────
    this._bobTime += delta;
    if (this.isGrounded) {
      const bobY = Math.sin(this._bobTime * BOB_SPEED) * BOB_AMPLITUDE;
      this._sprite.setY(SURFACE_Y + bobY);
      body.setVelocityY(0);
    }

    // ── 9. Jump input ────────────────────────────────────────────────────
    const canJump = this.isGrounded || this._coyoteMs > 0;
    const keyDown = Phaser.Input.Keyboard.JustDown(this._keys.space);
    if (canJump && (keyDown || this._jumpRequested)) {
      body.setVelocityY(JUMP_VEL);
      this.isGrounded = false;
      this._coyoteMs  = 0;
      this._sprite.anims.stop();
      this._sprite.setFrame(2); // ascent frame
    }
    this._jumpRequested = false;

    // ── 10. Body offset ───────────────────────────────────────────────────
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

    // ── 11. Animation ────────────────────────────────────────────────────
    this._updateCatcherAnimation(body);
  }

  /**
   * The ONLY place that sets this._sprite.x during the 'run' state.
   * Zeroing velocityX prevents Arcade physics from accumulating any
   * horizontal drift between frames.
   */
  _updateCatcherMovement() {
    this._sprite.setX(CAT_X - this._distance);
    this._sprite.body.setVelocityX(0);
  }

  /**
   * Drive catcher_run (4-frame loop) or static airborne frames.
   * catcher_catch is NEVER triggered here — only in _beginFinalCatch().
   */
  _updateCatcherAnimation(body) {
    if (this.isGrounded) {
      const cur = this._sprite.anims.currentAnim;
      if (!this._sprite.anims.isPlaying || cur?.key !== 'catcher-run') {
        this._sprite.play('catcher-run');
        body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
      }
    } else {
      // Airborne: show ascending (frame 2) or descending (frame 3) frame.
      if (this._sprite.anims.isPlaying) {
        this._sprite.anims.stop();
      }
      this._sprite.setFrame(body.velocity.y < 0 ? 2 : 3);
      body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
    }
  }

  /**
   * Triggered ONLY on crash 3 (crashCount >= MAX_CRASHES_BEFORE_CAUGHT).
   * Switches to the 2-frame catcher_catch animation and hides the cat.
   * catcher_catch is NEVER played during crashes 1 or 2.
   */
  _beginFinalCatch() {
    this.catcherState = 'catch';
    this.isCaught     = true;
    this._timer       = 0;

    this._sprite.setX(CAT_X + 10);
    this._sprite.setDepth(CATCH_DEPTH);
    this._sprite.play('catcher-catch'); // 2 frames, only here

    if (this._catSprite) this._catSprite.setVisible(false);
  }

  _activateBarSegment(i) {
    if (i >= 0 && i < this._barSegs.length) {
      this._barSegs[i].setVisible(true);
    }
  }
}
