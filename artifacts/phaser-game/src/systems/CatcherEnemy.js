// ---------------------------------------------------------------------------
// CatcherEnemy — chasing enemy that mirrors the cat's jumps exactly.
//
// ARCHITECTURE
// ────────────
// PlatformManager uses ONE static physics body at x=80 (the cat's screen X),
// not per-tile bodies.  Registering the catcher against that group caused:
//   1. Fall-through: body is only at x=80, never under the catcher.
//   2. Jitter: when catcher is near x=80, the physics engine resolves the
//      overlap and pushes the catcher horizontally every frame.
//
// Fix: no platform physics collider on the catcher.  Ground detection is
// done via a manual world-space segment check (same data PlatformManager
// uses for the cat).  Gravity / vertical velocity still come from Arcade
// physics so the jump arc is physically correct.
//
// Horizontal X is managed MANUALLY — one authoritative update per frame in
// _updateCatcherMovement(), called after min-distance is clamped.
//
// JUMP RULE — mirror the cat, nothing else
// ─────────────────────────────────────────
// Every frame we read the cat physics body's velocityY.  The instant it
// flips from ≥ 0 to < 0 (the cat just launched a jump), the catcher fires
// an identical JUMP_VEL impulse — no terrain AI, no lookahead, no delay.
//
// Why this is correct:
//   • The catcher is behind the cat (lower screen X), so every gap / obstacle
//     arrives at the catcher's position AFTER it arrives at the cat's position.
//   • The jump arc lasts ≈ 0.84 s; the gap/obstacle reaches the catcher
//     0.07–0.53 s after the cat jumped — always while the catcher is still
//     airborne.  The catcher clears every terrain feature the cat cleared.
//   • No spurious autonomous jumps — the catcher only jumps when the player
//     actually presses jump.
//
// STATE MACHINE
// ─────────────
//   catcherState = 'run'   → chasing; real physics + cat-mirror jump
//   catcherState = 'catch' → final catch animation (crash 3 ONLY)
//   catcherState = 'done'  → GameScene should restart
//
// CRASH SYSTEM
// ────────────
//   crash 1 → catcher moves CATCHER_CATCH_UP_STEP px closer, cat survives
//   crash 2 → same; cat survives
//   crash 3 → _beginFinalCatch() → catcher_catch plays → restart
//
// MINIMUM DISTANCE
// ────────────────
//   Hard clamp on _distance applied BEFORE _updateCatcherMovement() every
//   frame so no later code can override it in the same frame.
// ---------------------------------------------------------------------------

// ── Layout ────────────────────────────────────────────────────────────────────
const CAT_X     = 80;   // Cat's fixed screen X (must match CatPlayer)
const SURFACE_Y = 195;  // Ground surface Y — feet / origin-bottom

// ── Render ────────────────────────────────────────────────────────────────────
const CATCHER_SCALE = 0.5;  // 128×128 source → 64×64 display
const CHASE_DEPTH   = 15;
const CATCH_DEPTH   = 25;

// ── Physics (same values as CatPlayer) ───────────────────────────────────────
const GRAVITY_Y = 900;   // px / s²
const JUMP_VEL  = -380;  // px / s (upward — identical to cat)
const COYOTE_MS = 150;   // ms of extra jump window after leaving platform edge

// ── Hitbox (same geometry as cat) ────────────────────────────────────────────
const BODY_WIDTH    = 28;
const BODY_HEIGHT   = 40;
const BODY_OFFSET_X = 22;
const BODY_OFFSET_Y = 76;

// ── Chase behaviour ───────────────────────────────────────────────────────────
const CATCHUP_SPEED        = 3;  // px / s  — passive creep between crashes
const CATCHER_CATCH_UP_STEP = 20; // px closer on each of crashes 1 & 2

// Hard lower bound for _distance, enforced BEFORE setX every frame.
// At MIN = 40: catcher right-edge (catcher.x + 32) = 72,
//              cat left-edge (80 − 32) = 48  →  24 px clear gap.
const MIN_CATCHER_DISTANCE = 40; // px

// Starting distance — catcher barely peeking in from the left edge.
const START_DISTANCE = 90; // px  →  catcher.x = 80 − 90 = −10

// ── Catch animation ───────────────────────────────────────────────────────────
const CATCH_ANIM_MS = 900; // ms the 2-frame catcher_catch animation plays

// ── Bob (cosmetic, ground only) ───────────────────────────────────────────────
const BOB_AMPLITUDE = 3;      // px
const BOB_SPEED     = 0.0025; // rad / ms

// ── HUD scalebar ──────────────────────────────────────────────────────────────
const BAR_X = 10;
const BAR_Y = 10;
const SEG_W = 18;
const SEG_H = 7;
const SEG_GAP = 3;
const COL_EMPTY   = 0x222233;
const SEG_COLOURS = [0xFF8800, 0xFF3300, 0xFF0000];

// ── Crash system ──────────────────────────────────────────────────────────────
const MAX_CRASHES_BEFORE_CAUGHT = 3;

// ---------------------------------------------------------------------------

export class CatcherEnemy {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this._scene = scene;

    // ── Core state ──────────────────────────────────────────────────────
    this.catcherState = 'run'; // 'run' | 'catch' | 'done'
    this.crashCount   = 0;
    this.isCaught     = false;
    this._timer       = 0;
    this._catSprite   = null;

    // ── Physics sub-state ────────────────────────────────────────────────
    // isGrounded = true from construction so the catcher never falls on frame 1.
    this.isGrounded = true;
    this._coyoteMs  = 0;

    // Previous-frame cat velocityY — used to detect the exact frame the cat
    // launches a jump (transition from ≥ 0 to < 0).
    this._prevCatVelY = 0;

    // ── Distance tracking ────────────────────────────────────────────────
    // _distance: how many px the catcher is behind the cat.
    // catcher.x  = CAT_X − _distance  (written ONLY in _updateCatcherMovement).
    this._distance = START_DISTANCE;

    // ── Bob ──────────────────────────────────────────────────────────────
    this._bobTime = 0;

    // ── Animations ───────────────────────────────────────────────────────
    // Defined once; the `if exists` guard survives scene restarts.
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

    // ── Physics sprite ───────────────────────────────────────────────────
    const startX = CAT_X - this._distance; // −10 px, barely off-screen left
    this._sprite = scene.physics.add.sprite(startX, SURFACE_Y, 'catcher_run');
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setScale(CATCHER_SCALE);
    this._sprite.setDepth(CHASE_DEPTH);
    this._sprite.play('catcher-run');

    const body = this._sprite.body;
    body.setGravityY(GRAVITY_Y);
    body.setCollideWorldBounds(false); // X is managed manually; world bounds cause jitter
    body.setSize(BODY_WIDTH, BODY_HEIGHT, false);
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
    body.setVelocityX(0);
    body.setVelocityY(0); // grounded from frame 1

    // NO platform physics collider — see architecture notes at the top.

    // ── HUD danger scalebar ──────────────────────────────────────────────
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
   * Called by GameScene when the cat hits an obstacle.
   *
   *  crash 1 or 2 → move catcher CATCHER_CATCH_UP_STEP px closer; cat survives
   *  crash 3      → final catch sequence; game restarts after animation
   */
  onObstacleHit() {
    if (this.catcherState !== 'run') return;

    this.crashCount++;
    this._activateBarSegment(this.crashCount - 1);

    if (this.crashCount >= MAX_CRASHES_BEFORE_CAUGHT) {
      this._beginFinalCatch();
    } else {
      // Reduce distance by catch-up step.
      // MIN_CATCHER_DISTANCE is enforced per-frame in _updateChasing() before setX,
      // not here, so the raw catch-up quantity is applied first.
      this._distance -= CATCHER_CATCH_UP_STEP;
    }
  }

  /**
   * @param {number}                    delta     ms (already clamped by GameScene)
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
    this._sprite.destroy();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * World-space ground check.
   * Reads PlatformManager's live segment list and scroll offset to decide
   * whether the catcher's current world-space X falls inside a platform segment.
   *
   * @param {number} scrollPx  current scroll offset (rounded px)
   * @returns {boolean}
   */
  _isOverPlatform(scrollPx) {
    const pm = this._scene._platforms;
    if (!pm) return true; // safety fallback

    const catcherWorldX = scrollPx + this._sprite.x;
    for (const seg of pm._segments) {
      if (catcherWorldX >= seg.worldX && catcherWorldX < seg.worldX + seg.width) {
        return true;
      }
    }
    return false;
  }

  /**
   * Per-frame update for the 'run' state.
   *
   * Frame order:
   *   1. Gravity / vertical velocity — handled by Arcade physics before this call
   *   2. Compute scroll offset
   *   3. World-space ground detection → overPlatform
   *   4. Resolve grounded state (land / start falling / coyote)
   *   5. Tick coyote window
   *   6. Natural creep  (_distance decreases slowly)
   *   7. Enforce minCatcherDistance on _distance  ← BEFORE setX
   *   8. _updateCatcherMovement()  — ONLY place that writes sprite.x
   *   9. Vertical snap + bob (grounded only)
   *  10. Cat-mirror jump — fires the frame the cat's velocityY turns negative
   *  11. Body offset lock
   *  12. Animation update
   */
  _updateChasing(delta) {
    const body = this._sprite.body;

    // ── 2. Scroll offset ─────────────────────────────────────────────────
    const pm       = this._scene._platforms;
    const scrollPx = pm ? Math.round(pm._scrollOffset) : 0;

    // ── 3. Ground detection ───────────────────────────────────────────────
    const overPlatform = this._isOverPlatform(scrollPx);

    // ── 4. Grounded state ─────────────────────────────────────────────────
    if (overPlatform && this._sprite.y >= SURFACE_Y) {
      // Reached or passed the surface over a real segment → land.
      this._sprite.setY(SURFACE_Y);
      body.setVelocityY(0);
      if (!this.isGrounded) {
        this.isGrounded = true;
        this._coyoteMs  = 0;
      }
    } else if (!overPlatform && this.isGrounded) {
      // Just moved off a platform edge → open coyote window.
      this.isGrounded = false;
      this._coyoteMs  = COYOTE_MS;
    }

    // ── 5. Coyote window ─────────────────────────────────────────────────
    if (this._coyoteMs > 0) {
      this._coyoteMs = Math.max(0, this._coyoteMs - delta);
    }

    // ── 6. Natural creep ─────────────────────────────────────────────────
    this._distance -= CATCHUP_SPEED * (delta / 1000);

    // ── 7. Enforce minCatcherDistance BEFORE setX ─────────────────────────
    if (this._distance < MIN_CATCHER_DISTANCE) {
      this._distance = MIN_CATCHER_DISTANCE;
    }

    // ── 8. Single authoritative X update ─────────────────────────────────
    this._updateCatcherMovement();

    // ── 9. Vertical snap + bob ────────────────────────────────────────────
    this._bobTime += delta;
    if (this.isGrounded) {
      const bobY = Math.sin(this._bobTime * BOB_SPEED) * BOB_AMPLITUDE;
      this._sprite.setY(SURFACE_Y + bobY);
      body.setVelocityY(0);
    }

    // ── 10. Cat-mirror jump ───────────────────────────────────────────────
    // Read the cat's current velocityY and compare to previous frame.
    // The instant the cat's velocity flips from ≥ 0 to < 0, the cat has
    // just launched a jump.  The catcher fires the same impulse immediately.
    //
    // No terrain AI, no lookahead, no delay — only and exactly when the
    // player presses jump.
    const catVelY     = this._catSprite?.body?.velocity?.y ?? 0;
    const catJustJumped = catVelY < 0 && this._prevCatVelY >= 0;
    this._prevCatVelY = catVelY;

    const canJump = this.isGrounded || this._coyoteMs > 0;
    if (catJustJumped && canJump) {
      body.setVelocityY(JUMP_VEL);
      this.isGrounded = false;
      this._coyoteMs  = 0;
      this._sprite.anims.stop();
      this._sprite.setFrame(2); // ascent frame
    }

    // ── 11. Body offset ───────────────────────────────────────────────────
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

    // ── 12. Animation ─────────────────────────────────────────────────────
    this._updateCatcherAnimation(body);
  }

  /**
   * The ONLY function that writes sprite.x (during 'run' state).
   * Zeroing velocityX prevents Arcade from accumulating horizontal drift.
   */
  _updateCatcherMovement() {
    this._sprite.setX(CAT_X - this._distance);
    this._sprite.body.setVelocityX(0);
  }

  /**
   * catcher_run (4 frames) while grounded.
   * Static ascent (frame 2) / descent (frame 3) frames while airborne.
   * catcher_catch is NEVER played here — only in _beginFinalCatch().
   */
  _updateCatcherAnimation(body) {
    if (this.isGrounded) {
      const cur = this._sprite.anims.currentAnim;
      if (!this._sprite.anims.isPlaying || cur?.key !== 'catcher-run') {
        this._sprite.play('catcher-run');
        body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
      }
    } else {
      if (this._sprite.anims.isPlaying) this._sprite.anims.stop();
      this._sprite.setFrame(body.velocity.y < 0 ? 2 : 3);
      body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
    }
  }

  /**
   * Triggered ONLY on crash 3.
   * Switches to the 2-frame catcher_catch animation and hides the cat.
   * Never called on crash 1 or crash 2.
   */
  _beginFinalCatch() {
    this.catcherState = 'catch';
    this.isCaught     = true;
    this._timer       = 0;

    this._sprite.setX(CAT_X + 10);
    this._sprite.setDepth(CATCH_DEPTH);
    this._sprite.play('catcher-catch'); // 2-frame anim, only here

    if (this._catSprite) this._catSprite.setVisible(false);
  }

  _activateBarSegment(i) {
    if (i >= 0 && i < this._barSegs.length) {
      this._barSegs[i].setVisible(true);
    }
  }
}
