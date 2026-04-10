// ---------------------------------------------------------------------------
// CatcherEnemy — physics-correct, terrain-aware chasing enemy.
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
// JUMP DECISIONS (terrain-aware, no player-input mirroring)
// ─────────────────────────────────────────────────────────
// _shouldJump() inspects the live segment list and obstacle list to decide
// whether a jump is needed at the catcher's OWN screen position:
//   • Gap ahead   — no segment covers the lookahead world-X → jump now
//   • In gap now  — no platform under catcher + coyote still active → jump
//   • Obstacle    — ground obstacle within screen-space lookahead → jump
//
// This makes the catcher a real terrain-obeying runner, not a follower.
//
// STATE MACHINE
// ─────────────
//   catcherState = 'run'   → chasing; real physics + terrain
//   catcherState = 'catch' → final catch animation (crash 3 ONLY)
//   catcherState = 'done'  → GameScene should restart
//
// CRASH SYSTEM
// ────────────
//   crash 1 → catcher moves catcherCatchUpStep px closer, cat survives
//   crash 2 → catcher moves catcherCatchUpStep px closer, cat survives
//   crash 3 → _beginFinalCatch() → catcher_catch plays → restart
//
// MINIMUM DISTANCE
// ────────────────
//   Enforced as a hard clamp on _distance BEFORE _updateCatcherMovement(),
//   so no subsequent code can override it in the same frame.
// ---------------------------------------------------------------------------

import Phaser from "phaser";

// ── Layout ────────────────────────────────────────────────────────────────────
const CAT_X     = 80;   // Cat's fixed screen X (must match CatPlayer)
const SURFACE_Y = 195;  // Ground surface Y — feet / origin-bottom

// ── Render ────────────────────────────────────────────────────────────────────
const CATCHER_SCALE = 0.5;  // 128×128 source → 64×64 display
const CHASE_DEPTH   = 15;
const CATCH_DEPTH   = 25;

// ── Physics (same values as CatPlayer) ───────────────────────────────────────
const GRAVITY_Y = 900;   // px / s²
const JUMP_VEL  = -380;  // px / s  (upward)
const COYOTE_MS = 150;   // ms of extra jump window after leaving platform edge

// ── Hitbox (same geometry as cat) ────────────────────────────────────────────
const BODY_WIDTH    = 28;
const BODY_HEIGHT   = 40;
const BODY_OFFSET_X = 22;
const BODY_OFFSET_Y = 76;

// ── Chase behaviour ───────────────────────────────────────────────────────────
// Passive creep: catcher slowly closes the gap between crashes.
const CATCHUP_SPEED = 3; // px / s

// How many px closer the catcher snaps on each of the first two crashes.
const CATCHER_CATCH_UP_STEP = 20; // px per crash

// Hard lower bound for _distance, enforced every frame BEFORE setX.
// cat.displayWidth = 64 px (128 × 0.5), origin centre → half = 32 px.
// At MIN = 40: catcher right edge (catcher.x + 32) = (80-40)+32 = 72,
//              cat left edge (80-32) = 48  → 24 px clear gap. Visible.
const MIN_CATCHER_DISTANCE = 40; // px

// Starting distance — catcher barely peeking in from the left edge.
const START_DISTANCE = 90; // px  →  catcher.x = 80-90 = -10 (just off screen)

// ── Terrain-aware jump lookahead ─────────────────────────────────────────────
// GAP_LOOKAHEAD_WORLD: world-space px ahead to check for missing ground.
// Jump takes ≈ 0.42 s to apex.  At scroll 150 px/s → 63 px of gap travel.
// 80 px gives comfortable safety margin.
const GAP_LOOKAHEAD_WORLD  = 80;  // px (world space)

// OBSTACLE_LOOKAHEAD_SCREEN: screen-space px ahead to check for ground obstacles.
// At scroll 150 px/s, obstacle travels 80 px in ≈ 0.53 s — enough to reach apex.
const OBSTACLE_LOOKAHEAD_SCREEN = 80;  // px (screen space)

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

    // ── Distance tracking ────────────────────────────────────────────────
    // _distance: how many px the catcher is behind the cat.
    // catcher.x  = CAT_X - _distance  (written only in _updateCatcherMovement).
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
    const startX = CAT_X - this._distance; // -10 px, barely off-screen left
    this._sprite = scene.physics.add.sprite(startX, SURFACE_Y, 'catcher_run');
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setScale(CATCHER_SCALE);
    this._sprite.setDepth(CHASE_DEPTH);
    this._sprite.play('catcher-run');

    const body = this._sprite.body;
    body.setGravityY(GRAVITY_Y);
    body.setCollideWorldBounds(false); // X managed manually; world bounds cause jitter
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
   *  crash 3      → final catch sequence; cat is hidden; game restarts after anim
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
      // not here, so the catch-up quantity is applied first (spec requirement).
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
   * This is the same check PlatformManager uses for the cat's own floor body.
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
   * Decide whether the catcher should jump this frame.
   *
   * Three conditions (any one triggers a jump):
   *   1. Catcher is currently in a gap (no platform below) — late jump.
   *   2. A gap is detected within GAP_LOOKAHEAD_WORLD px ahead in world space.
   *   3. A ground-level obstacle is within OBSTACLE_LOOKAHEAD_SCREEN px ahead
   *      in screen space.
   *
   * Player input is NOT mirrored here — the catcher navigates terrain on its
   * own, reacting to the level at its own screen position.
   *
   * @param {number}  scrollPx
   * @param {boolean} overPlatform
   * @returns {boolean}
   */
  _shouldJump(scrollPx, overPlatform) {
    const catcherScreenX = this._sprite.x;

    // 1. Already in a gap — jump while coyote window allows it.
    if (!overPlatform) return true;

    // 2. Gap lookahead (world space).
    const pm = this._scene._platforms;
    if (pm) {
      const catcherWorldX = scrollPx + catcherScreenX;
      const lookWorldX    = catcherWorldX + GAP_LOOKAHEAD_WORLD;
      let hasGroundAhead  = false;
      for (const seg of pm._segments) {
        if (lookWorldX >= seg.worldX && lookWorldX < seg.worldX + seg.width) {
          hasGroundAhead = true;
          break;
        }
      }
      if (!hasGroundAhead) return true;
    }

    // 3. Ground obstacle lookahead (screen space).
    //    Obstacles approach from the right (scrolling left).
    //    We check the obstacle's current screen X against the catcher's position.
    const om = this._scene._obstacles;
    if (om && om._obstacles) {
      for (const obs of om._obstacles) {
        const obsScreenX = obs.worldX - scrollPx;

        // Obstacle must be ahead (to the right) of the catcher and within range.
        if (obsScreenX <= catcherScreenX + 5) continue;
        if (obsScreenX >  catcherScreenX + OBSTACLE_LOOKAHEAD_SCREEN) continue;

        // Only react to ground-level obstacles (not flying birds).
        // obsBottom is SURFACE_Y for all ground obstacles (set in ObstacleManager).
        if (obs.obsBottom >= SURFACE_Y - 5) return true;
      }
    }

    return false;
  }

  /**
   * Per-frame update for the 'run' state.
   *
   * Frame order (per spec):
   *   1. Gravity / vertical velocity — handled by Arcade physics before this call
   *   2. Compute current scroll offset
   *   3. World-space ground detection → overPlatform
   *   4. Resolve grounded state (land / start falling / coyote)
   *   5. Tick coyote window
   *   6. Natural creep  (_distance decreases slowly)
   *   7. Enforce minCatcherDistance on _distance  ← BEFORE setX
   *   8. _updateCatcherMovement()  — ONLY place that writes sprite.x
   *   9. Vertical snap + bob (grounded only)
   *  10. Terrain-aware jump decision → _shouldJump()
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
      // Just moved off a platform edge → begin coyote window.
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
    // Applied after the creep (and after any crash catch-up that happened
    // between frames via onObstacleHit).  This is the FINAL word on _distance.
    // Nothing after this may change _distance or sprite.x.
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

    // ── 10. Terrain-aware jump ────────────────────────────────────────────
    const canJump    = this.isGrounded || this._coyoteMs > 0;
    const needsJump  = this._shouldJump(scrollPx, overPlatform);

    if (needsJump && canJump) {
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
   * Static ascent/descent frames while airborne.
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
