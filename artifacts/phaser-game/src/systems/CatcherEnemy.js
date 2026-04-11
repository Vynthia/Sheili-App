// ---------------------------------------------------------------------------
// CatcherEnemy — chasing enemy that mirrors the cat's jumps with a delay.
//
// ARCHITECTURE
// ────────────
// PlatformManager maintains TWO floor bodies in separate static groups:
//   1. The cat's floor  — centred at CAT_SCREEN_X (x = 80), used by CatPlayer.
//   2. The catcher's floor — fixed rectangle covering x = −45 to x = 65,
//      registered here.  Always enabled — catcher never falls through gaps.
//      GameScene calls updateCatcherFloor() (now BEFORE catcher.update())
//      each frame to keep the body active.
//
// Ground detection uses body.blocked.down — the standard Phaser Arcade flag
// set automatically by the collider, identical to how CatPlayer works.  No
// manual Y-snap is needed; the physics collider handles landing resolution.
//
// Horizontal X is still managed manually: _updateCatcherMovement() pins the
// catcher at CAT_X − _distance each frame and zeroes velocityX so Arcade
// does not drift it horizontally.  Only Y physics is fully autonomous.
//
// JUMP RULE — mirror the cat with a fixed delay
// ─────────────────────────────────────────────
// CatPlayer exposes `didJump` — a boolean flag set to true for exactly one
// frame inside _doJump(), then reset to false at the start of each update().
// When CatcherEnemy sees didJump = true it queues a JUMP_DELAY_MS countdown
// instead of firing immediately, giving the catcher a natural lag behind
// the cat rather than frame-perfect mirroring.
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
const CHASE_DEPTH   = 31;   // above obstacles (30) so the catcher is always fully visible
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

// ── Jump delay ────────────────────────────────────────────────────────────────
// The catcher waits this many ms after seeing catSprite.didJump before it
// actually fires its own jump — giving it a natural, slightly-behind feel
// instead of frame-perfect simultaneous mirroring.
const JUMP_DELAY_MS = 120;

// ── Chase behaviour ───────────────────────────────────────────────────────────
const CATCHUP_SPEED         = 3;  // px / s  — passive creep between crashes
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

    // ── Jump delay state ──────────────────────────────────────────────────
    // Queues a jump JUMP_DELAY_MS after catSprite.didJump is seen.
    // Only one pending jump at a time; new signals are ignored while queued.
    this._pendingJump     = false; // true while countdown is running
    this._jumpDelayTimer  = 0;    // ms remaining until deferred jump fires

    // ── Obstacle manager ref ──────────────────────────────────────────────
    // Injected via update() so the catcher can check for nearby obstacles
    // and fire its jump early when needed (before the normal delay expires).
    this._obstacleManager = null;

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
      (catcher, _floor) => catcher.body.velocity.y >= 0, // one-way: only blocks downward
    );

    // NOTE: The catcher-obstacle collider is registered in GameScene.create()
    // AFTER ObstacleManager is constructed, so scene._obstacles.group exists.

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
   * @param {number}                    delta           ms (already clamped by GameScene)
   * @param {Phaser.GameObjects.Sprite} catSprite
   * @param {ObstacleManager}           obstacleManager used for early-jump safety checks
   * @returns {boolean}  true → GameScene should restart
   */
  update(delta, catSprite, obstacleManager) {
    this._catSprite       = catSprite;
    this._obstacleManager = obstacleManager ?? this._obstacleManager;

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
   *   7. Cat-mirror jump with JUMP_DELAY_MS countdown.
   *   8. Body offset lock.
   *   9. Animation update.
   */
  _updateChasing(delta) {
    const body = this._sprite.body;

    // ── 2. Grounded state via real physics (same as CatPlayer) ────────────
    // body.blocked.down is set by the Arcade physics collider against the
    // catcher's dedicated floor body in PlatformManager.  That floor body is
    // always enabled (catcher never falls through gaps).
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

    // ── 7. Cat-mirror jump with delay ─────────────────────────────────────
    // When catSprite.didJump is true (exactly ONE frame per cat jump),
    // queue a deferred jump rather than firing immediately.
    // Only one pending jump is allowed at a time — new signals while
    // a jump is already queued are silently ignored.
    if (this._catSprite?.didJump && !this._pendingJump) {
      // Start the countdown for the delayed jump.
      this._pendingJump    = true;
      this._jumpDelayTimer = JUMP_DELAY_MS;
    }

    if (this._pendingJump) {
      this._jumpDelayTimer -= delta; // count down

      // ── Early-jump safety override ────────────────────────────────────────
      // If any ground obstacle will reach the catcher's body before the
      // remaining delay expires, zero the timer so the jump fires this frame.
      // This prevents the catcher from standing still while an obstacle scrolls
      // into it — which would look broken and cause a stuck collision.
      // The check uses ObstacleManager's live obstacle positions and its own
      // scroll offset (independent of PlatformManager), so no extra sync needed.
      if (
        this._jumpDelayTimer > 0 &&
        this._obstacleManager?.groundObstacleApproachingCatcher(
          this._sprite.x, this._jumpDelayTimer
        )
      ) {
        this._jumpDelayTimer = 0; // force-fire the jump this frame
      }

      if (this._jumpDelayTimer <= 0) {
        // Fire the deferred jump now.
        body.setVelocityY(JUMP_VEL);
        this.isGrounded      = false;
        this._coyoteMs       = 0;
        this._pendingJump    = false; // consume the queued jump
        this._sprite.anims.stop();
        this._sprite.setFrame(2); // ascent frame
      }
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

    // Completely stabilize all physics so the catcher cannot fall or drift
    // during the 900 ms catch animation.  The teleport to x=90 puts the
    // catcher outside the dedicated floor body range (x=−45 to x=65), so
    // the floor collider won't fire — without disabling physics the catcher
    // would fall off-screen before the scene restarts.
    const body = this._sprite.body;
    body.setVelocity(0, 0);  // zero both X and Y velocity
    body.setGravityY(0);     // remove gravity for the animation window
    body.enable = false;     // disable physics entirely — no forces or collisions

    if (this._catSprite) this._catSprite.setVisible(false);
  }

  _activateBarSegment(i) {
    if (i >= 0 && i < this._barSegs.length) {
      this._barSegs[i].setVisible(true);
    }
  }
}
