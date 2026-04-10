// ---------------------------------------------------------------------------
// CatcherEnemy — chasing enemy that mirrors the cat's jumps exactly.
//
// ARCHITECTURE
// ────────────
// PlatformManager now maintains TWO floor bodies in separate static groups:
//   1. The cat's floor  — centred at CAT_SCREEN_X (x = 80), used by CatPlayer.
//   2. The catcher's floor — fixed rectangle covering x = −45 to x = 65,
//      registered here.  Never repositioned; enabled / disabled each frame via
//      PlatformManager.updateCatcherFloor() (called from GameScene.update).
//
// Ground detection uses body.blocked.down — the standard Phaser Arcade flag
// set automatically by the collider, identical to how CatPlayer works.  No
// manual Y-snap is needed; the physics collider handles landing resolution.
//
// Horizontal X is still managed manually: _updateCatcherMovement() pins the
// catcher at CAT_X − _distance each frame and zeroes velocityX so Arcade
// does not drift it horizontally.  Only Y physics is fully autonomous.
//
// JUMP RULE — mirror the cat, nothing else
// ─────────────────────────────────────────
// CatPlayer exposes `didJump` — a boolean flag set to true for exactly one
// frame inside _doJump(), then reset to false at the start of each update().
// CatcherEnemy reads it here (after CatPlayer.update() has already run this
// frame) for a 100 % reliable, zero-ambiguity jump signal.
//
// Why velocity-transition detection was replaced:
//   Phaser's Arcade physics can leave body.velocity.y at a tiny negative
//   value (−0.1 to −2) on some grounded frames due to gravity overshoot
//   before the collider fires.  This caused the velocity "rising edge"
//   detector to fail intermittently, silently skipping catcher jumps.
//
// Why mirroring is geometrically correct:
//   • The catcher is behind the cat, so every gap / obstacle arrives at
//     the catcher's position AFTER it arrives at the cat's position.
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
const CHASE_DEPTH   = 31;  // above obstacles (30) so the catcher is always fully visible
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
    // catcher.x  = CAT_X − _distance  (written ONLY in _updateCatcherMovement).
    this._distance = START_DISTANCE;

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

    // ── Real one-way platform collider ────────────────────────────────────
    // Catcher uses the same one-way processCallback as the cat: the floor
    // body only blocks the catcher when it is falling (velocity.y >= 0),
    // so it can jump upward through the floor without being pushed back down.
    // The floor body is in a SEPARATE static group (scene._platforms.catcherGroup)
    // so the cat's collider never interacts with the catcher's floor and
    // vice-versa.  scene._platforms is initialised before CatcherEnemy in
    // GameScene.create() so the reference is always valid here.
    scene.physics.add.collider(
      this._sprite,
      scene._platforms.catcherGroup,
      null,
      (catcher, _floor) => catcher.body.velocity.y >= 0,
    );

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

  /** The underlying physics sprite — used by GameScene for position queries. */
  get sprite() { return this._sprite; }

  destroy() {
    this._sprite.destroy();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Per-frame update for the 'run' state.
   *
   * Frame order:
   *   1. Gravity / vertical velocity — handled by Arcade physics BEFORE this call.
   *      The one-way collider (registered in the constructor) also resolves
   *      landing: body.blocked.down becomes true the frame the catcher lands.
   *   2. Grounded state — read body.blocked.down (set by the physics collider,
   *      same as CatPlayer).  Transition triggers coyote window on departure.
   *   3. Coyote window tick.
   *   4. Natural creep  (_distance decreases slowly).
   *   5. Enforce minCatcherDistance on _distance  ← BEFORE setX.
   *   6. _updateCatcherMovement()  — ONLY place that writes sprite.x.
   *   7. Cat-mirror jump — fires the ONE frame that CatPlayer.didJump is true.
   *   8. Body offset lock.
   *   9. Animation update.
   */
  _updateChasing(delta) {
    const body = this._sprite.body;

    // ── 2. Grounded state via real physics (same as CatPlayer) ────────────
    // body.blocked.down is set by the Arcade physics collider against the
    // catcher's dedicated floor body in PlatformManager.  That floor body is
    // enabled when the catcher is over a platform segment (updated by
    // GameScene.update after each frame) and disabled over gaps — so
    // blocked.down naturally becomes false when the catcher walks off an edge,
    // which opens the coyote window exactly like the cat.
    const onGround = body.blocked.down;
    if (onGround && !this.isGrounded) {
      this.isGrounded = true;
      this._coyoteMs  = 0;
    } else if (!onGround && this.isGrounded) {
      this.isGrounded = false;
      this._coyoteMs  = COYOTE_MS;
    }

    // ── 3. Coyote window ─────────────────────────────────────────────────
    if (this._coyoteMs > 0) {
      this._coyoteMs = Math.max(0, this._coyoteMs - delta);
    }

    // ── 4. Natural creep ─────────────────────────────────────────────────
    this._distance -= CATCHUP_SPEED * (delta / 1000);

    // ── 5. Enforce minCatcherDistance BEFORE setX ─────────────────────────
    if (this._distance < MIN_CATCHER_DISTANCE) {
      this._distance = MIN_CATCHER_DISTANCE;
    }

    // ── 6. Single authoritative X update ─────────────────────────────────
    this._updateCatcherMovement();

    // ── 7. Cat-mirror jump ───────────────────────────────────────────────
    // CatPlayer sets didJump = true for exactly ONE frame per jump (in
    // _doJump()) and resets it to false at the top of every update() call.
    // Reading it here — after this._cat.update() has already run — gives a
    // 100 % reliable, frame-perfect signal with no velocity-detection quirks.
    //
    // No canJump guard: if the catcher is mid-fall into a gap when the cat
    // jumps, it still needs the corrective impulse.  Since the cat can only
    // jump from the ground (single-jump), there is no risk of double-firing.
    if (this._catSprite?.didJump) {
      body.setVelocityY(JUMP_VEL);
      this.isGrounded = false;
      this._coyoteMs  = 0;
      this._sprite.anims.stop();
      this._sprite.setFrame(2); // ascent frame
    }

    // ── 8. Body offset lock ───────────────────────────────────────────────
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

    // ── 9. Animation ──────────────────────────────────────────────────────
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

    // Stop all vertical physics for the 900 ms catch animation.
    // The catcher teleports to x=90 which is outside its floor body range
    // (x=−45 to x=65), so the collider won't fire.  Without this the catcher
    // falls off-screen before the scene restarts.
    const body = this._sprite.body;
    body.setVelocityY(0);
    body.setGravityY(0);

    if (this._catSprite) this._catSprite.setVisible(false);
  }

  _activateBarSegment(i) {
    if (i >= 0 && i < this._barSegs.length) {
      this._barSegs[i].setVisible(true);
    }
  }
}
