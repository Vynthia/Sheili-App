// ---------------------------------------------------------------------------
// CatcherEnemy — chasing enemy that mirrors the cat's jumps with a delay.
//
// ARCHITECTURE
// ────────────
// PlatformManager maintains TWO floor bodies in separate static groups:
//   1. The cat's floor  — centred at CAT_SCREEN_X (x = 80), used by CatPlayer.
//   2. The catcher's floor — rectangle centred on the catcher each frame,
//      registered here.  GameScene calls updateCatcherFloor() BEFORE
//      catcher.update() each frame to keep the body positioned and active.
//
// Ground detection uses body.blocked.down — the standard Phaser Arcade flag
// set automatically by the collider, identical to how CatPlayer works.  No
// manual Y-snap is needed; the physics collider handles landing resolution.
//
// Horizontal X is still managed manually: _updateCatcherMovement() pins the
// catcher at CAT_X − _distance each frame and zeroes velocityX so Arcade
// does not drift it horizontally.  Only Y physics is fully autonomous.
//
// JUMP RULE — mirror the cat with a safety-aware delay
// ─────────────────────────────────────────────────────
// CatPlayer exposes `didJump` — a boolean flag set to true for exactly one
// frame inside _doJump(), then reset to false at the start of each update().
// When CatcherEnemy sees didJump = true it queues a JUMP_DELAY_MS countdown
// instead of firing immediately, giving the catcher a natural lag behind
// the cat rather than frame-perfect mirroring.
//
// OBSTACLE SAFETY — three-layer guarantee
// ────────────────────────────────────────
//   Layer 1 — Early override:  if a pending jump's remaining timer would not
//             give the catcher enough lead time to clear the next obstacle,
//             the timer is collapsed to zero and the jump fires this frame.
//   Layer 2 — Autonomous jump: even with no pending jump queued (cat was
//             already airborne so no didJump signal), if an obstacle is about
//             to enter the "no longer safe to wait" zone, jump anyway.
//   Layer 3 — Overlap fallback: if the catcher is somehow already overlapping
//             the obstacle's hx in X, fire a jump immediately as a last resort.
//             Should never trigger if layers 1 & 2 work correctly, but prevents
//             Arcade-pushback fighting the manual X pin from causing jitter.
//
// DISTANCE PROGRESSION (crash 0 → crash 3)
// ─────────────────────────────────────────
//   crash 0: distance = START_DISTANCE (150) → catcher fully off-screen left
//   crash 1: distance −= 35 → noticeably closer, still clearly behind
//   crash 2: distance −= 35 → tense, but body gap ≥ MIN_CATCHER_DISTANCE (70)
//   crash 3: _beginFinalCatch() teleports to CAT_X + 10 → overlap animation
//
// The MIN_CATCHER_DISTANCE clamp (70 px) guarantees the catcher's right edge
// (sprite.x + 32) stays < cat's left edge (80 − 32 = 48) during run state:
//   bodyGap = catLeft − catcherRight = 48 − (80 − 70 + 32) = 6 px minimum.
//   The catcher can ONLY visually overlap the cat inside _beginFinalCatch().
//
// STATE MACHINE
// ─────────────
//   catcherState = 'run'   → chasing; real physics + cat-mirror jump
//   catcherState = 'catch' → final catch animation (crash 3 ONLY)
//   catcherState = 'done'  → GameScene should restart
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

// ── Catcher body edge offsets relative to sprite.x ────────────────────────────
// Derived from: displayOriginX = 64/2 = 32; bodyLeft = x − 32 + 22 = x − 10.
const CATCHER_BODY_LEFT_OFFSET  = -10; // body left  = sprite.x − 10
const CATCHER_BODY_RIGHT_OFFSET =  18; // body right = sprite.x + 18

// ── Jump delay ────────────────────────────────────────────────────────────────
// The catcher waits this many ms after seeing catSprite.didJump before it
// actually fires its own jump — giving it a natural, slightly-behind feel
// instead of frame-perfect simultaneous mirroring.
const JUMP_DELAY_MS = 120;

// ── Obstacle-jump safety ──────────────────────────────────────────────────────
// OBSTACLE_JUMP_BUFFER_PX — extra px lead before the obstacle's hx left edge
// at which we decide "too late to wait any longer".
// At SCROLL_SPEED = 150 px/s: 24 px = 160 ms of additional warning window.
const OBSTACLE_JUMP_BUFFER_PX = 24;

// JUMP_CLEARANCE_MS — minimum ms needed after jump initiation for the catcher's
// body bottom to rise above the tallest obstacle hitbox (hitH = 22 px, bird).
// Derivation: solving 380t − 450t² ≥ 22 → t_min ≈ 62 ms; rounded up for margin.
const JUMP_CLEARANCE_MS = 80;

// Convenience: scroll speed in px/ms (matches PlatformManager / ObstacleManager).
const SCROLL_SPEED_PX_PER_MS = 150 / 1000;

// ── Chase behaviour ───────────────────────────────────────────────────────────
const CATCHUP_SPEED         = 3;  // px / s  — passive creep between crashes

// ── Distance progression ──────────────────────────────────────────────────────
// START_DISTANCE → catcher.x = 80 − 150 = −70 (fully off-screen left at start).
// CATCHER_CATCH_UP_STEP applied on crash 1 and crash 2 (not crash 3).
//   crash 1: 150 → 115  catcher.x = −35  right edge = −3   gap ≈ 51 px
//   crash 2: 115 → 80   catcher.x =   0  right edge = 32   gap ≈ 16 px  (tense)
//   crash 2 (late, near MIN): clamped at 70 → catcher.x = 10, gap ≈ 6 px
// MIN_CATCHER_DISTANCE (70) guarantees catcherRight < catLeft during run state.
const START_DISTANCE        = 150; // px   catcher starts off-screen left
const CATCHER_CATCH_UP_STEP = 35;  // px closer per crash (crashes 1 & 2 only)
const MIN_CATCHER_DISTANCE  = 70;  // px   hard floor during run state (no overlap)

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
    this._pendingJump     = false;
    this._jumpDelayTimer  = 0;

    // ── Obstacle manager ref ──────────────────────────────────────────────
    // Injected via update() so the catcher can query live obstacle geometry
    // for all three safety layers (early override, autonomous, overlap fallback).
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
    const startX = CAT_X - this._distance; // −70 px, fully off-screen left
    // Spawn 1 px ABOVE the visible surface — identical to CatPlayer's surfaceY−1
    // pattern.  Phaser Arcade uses a 4-px OVERLAP_BIAS in the Y check, so:
    //   body.top = sprite.y + 12 = (SURFACE_Y−1) + 12 = 206
    //   floor.bottom = SURFACE_Y + FLOOR_H = 195 + 8 = 203
    //   pass condition: body.top < floor.bottom + BIAS → 206 < 207 ✓
    // Spawning at SURFACE_Y (body.top=207) fails (207 < 207 is FALSE).
    this._sprite = scene.physics.add.sprite(startX, SURFACE_Y - 1, 'catcher_run');
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
    body.setVelocityY(0);

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
   * @param {number}          delta           ms (already clamped by GameScene)
   * @param {Phaser.GameObjects.Sprite} catSprite
   * @param {ObstacleManager} obstacleManager used for all three safety layers
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
   *   1. Arcade physics resolves gravity + one-way floor collider (before this).
   *   2. Grounded state — read body.blocked.down.
   *   3. Coyote window tick.
   *   4. Natural creep  (_distance decreases slowly).
   *   5. Enforce MIN_CATCHER_DISTANCE on _distance  ← BEFORE setX.
   *   6. _updateCatcherMovement()  — ONLY place that writes sprite.x.
   *   7. Obstacle-safe jump with three safety layers (see class header).
   *   8. Body offset lock.
   *   9. Animation update.
   */
  _updateChasing(delta) {
    const body = this._sprite.body;

    // ── 2. Grounded state via real physics ────────────────────────────────
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

    // ── 5. Enforce MIN_CATCHER_DISTANCE BEFORE setX ─────────────────────
    // Hard clamp ensures catcherRight < catLeft in run state (no visual overlap).
    // Only _beginFinalCatch() can place the catcher inside the cat.
    if (this._distance < MIN_CATCHER_DISTANCE) {
      this._distance = MIN_CATCHER_DISTANCE;
    }

    // ── 6. Single authoritative X update ─────────────────────────────────
    this._updateCatcherMovement();

    // ── 7. Obstacle-safe jump ─────────────────────────────────────────────

    // A. Queue jump on cat's didJump signal (one at a time).
    if (this._catSprite?.didJump && !this._pendingJump) {
      this._pendingJump    = true;
      this._jumpDelayTimer = JUMP_DELAY_MS;
    }

    // B. Tick the pending countdown.
    if (this._pendingJump) {
      this._jumpDelayTimer -= delta;
    }

    // C. Evaluate the next approaching obstacle every frame.
    //    Covers three cases:
    //      — early override  (pending jump, delay must be shortened)
    //      — autonomous jump (no pending jump, but obstacle is imminent)
    //      — overlap fallback (already inside the hitbox X range)
    const canJump = this.isGrounded || this._coyoteMs > 0;
    const nextObs = canJump
      ? this._obstacleManager?.getNextGroundObstacleForCatcher(this._sprite.x)
      : null;

    if (nextObs) {
      // Pending jump: check if we must fire early (layer 1).
      if (this._pendingJump) {
        const remainingMs = Math.max(0, this._jumpDelayTimer);
        if (this._mustJumpNowForObstacle(nextObs, remainingMs)) {
          // Collapse the remaining delay — jump fires in the block below.
          this._jumpDelayTimer = 0;
        }
      }

      // No pending jump: autonomous obstacle safety (layer 2).
      if (!this._pendingJump && this._mustJumpNowForObstacle(nextObs, 0)) {
        this._triggerJumpNow(body);
      }

      // Defensive overlap fallback: catcher body is already inside the hx X range
      // (layer 3 — last resort to prevent Arcade push-back fighting manual X pin).
      if (canJump && !this._pendingJump && body.velocity.y >= 0) {
        const cbLeft  = this._sprite.x + CATCHER_BODY_LEFT_OFFSET;
        const cbRight = this._sprite.x + CATCHER_BODY_RIGHT_OFFSET;
        const hxLeft  = nextObs.screenX - nextObs.hitW / 2;
        const hxRight = nextObs.screenX + nextObs.hitW / 2;
        if (cbLeft < hxRight && cbRight > hxLeft) {
          // Already overlapping — jump immediately.
          this._triggerJumpNow(body);
        }
      }
    }

    // D. Fire pending jump when countdown reaches zero.
    if (this._pendingJump && this._jumpDelayTimer <= 0) {
      this._triggerJumpNow(body);
    }

    // ── 8. Body offset lock ───────────────────────────────────────────────
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

    // ── 9. Animation ──────────────────────────────────────────────────────
    this._updateCatcherAnimation(body);
  }

  /**
   * Returns true if the catcher must jump RIGHT NOW to safely clear `obs`.
   *
   * Decision: obstacle hx left edge will reach catcher body right within
   *   pendingMs (remaining delay) + JUMP_CLEARANCE_MS (rise time to clear)
   *   + OBSTACLE_JUMP_BUFFER_PX / SCROLL_SPEED (extra horizontal safety margin).
   *
   * A negative msTillHit means the obstacle is already overlapping the catcher
   * body right — this also returns true, ensuring the fallback always fires.
   *
   * @param {{ screenX: number, hitW: number }} obs  next approaching obstacle
   * @param {number} pendingMs  remaining ms of jump delay (0 for autonomous path)
   */
  _mustJumpNowForObstacle(obs, pendingMs) {
    const catcherBodyRight = this._sprite.x + CATCHER_BODY_RIGHT_OFFSET; // +18
    const obsHxLeft        = obs.screenX - obs.hitW / 2;

    // Time (ms) for the obstacle's hx left edge to reach the catcher body right.
    // Negative → obstacle already past/inside → must jump.
    const msTillHit = (obsHxLeft - catcherBodyRight) / SCROLL_SPEED_PX_PER_MS;

    // Total lead time required: delay remainder + rise time + horizontal buffer.
    const msNeeded = pendingMs + JUMP_CLEARANCE_MS
                   + OBSTACLE_JUMP_BUFFER_PX / SCROLL_SPEED_PX_PER_MS;

    return msTillHit <= msNeeded;
  }

  /**
   * Fires the jump immediately and clears all pending-jump state.
   * Called by all three safety layers.
   * @param {Phaser.Physics.Arcade.Body} body
   */
  _triggerJumpNow(body) {
    body.setVelocityY(JUMP_VEL);
    this.isGrounded      = false;
    this._coyoteMs       = 0;
    this._pendingJump    = false;
    this._jumpDelayTimer = 0;
    this._sprite.anims.stop();
    this._sprite.setFrame(2); // ascent frame
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
    // during the 900 ms catch animation.  The teleport to x = 90 puts the
    // catcher outside the dedicated floor body range, so the floor collider
    // won't fire — without disabling physics the catcher would fall off-screen
    // before the scene restarts.
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
