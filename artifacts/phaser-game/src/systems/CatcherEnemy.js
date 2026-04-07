// ---------------------------------------------------------------------------
// CatcherEnemy — the cat-catcher who chases the player.
//
// The catcher is always visible on the left edge of the screen.  It has full
// physics and jump ability (keyboard Space / pointer click), but moves
// slower than the cat naturally.  The cat must hit obstacles 3 times before
// the catcher catches it.
//
// State machine:
//   'chasing'    → waiting for onObstacleHit() calls; can jump
//   'catching'   → catcher_catch animation playing (CATCH_ANIM_MS)
//   'done'       → signals GameScene to restart (only after 3rd hit)
// ---------------------------------------------------------------------------

// Cat's fixed screen X (must match CatPlayer.CAT_X).
const CAT_X          = 80;

// Surface Y for feet-anchor (must match SURFACE_Y in ObstacleManager).
const SURFACE_Y      = 195;

// Catcher display scale (source sprites are 128 × 128 px → 64 × 64 display).
const CATCHER_SCALE  = 0.5;

// Starting gap behind the cat (px).
const INITIAL_DISTANCE = 70;

// Natural catch-up rate (px / second).  Must be slower than scroll speed.
// (The world scrolls at 150 px/s; catcher moves at ~70 px/s relative to world,
//  which is ~80 px/s slower than the cat's pin, keeping it perpetually behind.)
const CATCHUP_SPEED    = 70;

// Jump impulse (negative = upward).  Same peak height as cat for fairness.
const JUMP_VEL = -380;

// Local gravity (same as cat).
const GRAVITY_Y = 900;

// Depth while chasing: behind cat (cat = 20).
const CHASE_DEPTH      = 15;

// Depth during catch animation: in front of cat so the net overlaps it.
const CATCH_DEPTH      = 25;

// How long (ms) the catcher_catch animation plays per lunge.
const CATCH_ANIM_MS    = 900;

// How many obstacle hits before the catcher catches the cat.
const HITS_TO_CATCH    = 3;

// Hitbox dimensions (source 128×128, display 64×64).
const BODY_WIDTH  = 28;
const BODY_HEIGHT = 40;
const BODY_OFFSET_X = 22;
const BODY_OFFSET_Y = 76;

// Coyote time (ms) — same as cat so timing feels fair.
const COYOTE_MS = 150;

// ---------------------------------------------------------------------------

export class CatcherEnemy {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this._scene    = scene;
    this._state    = 'chasing';
    this._distance = INITIAL_DISTANCE;
    this._timer    = 0;
    this._hitCount = 0;      // Incremented on each obstacle hit; at HITS_TO_CATCH triggers restart
    this._catSprite = null;  // Cached each frame from update()

    // ── State machine (jumping) ────────────────────────────────────────────
    this._jumpState = 'running';
    this._coyoteMs = 0;
    this._jumpRequested = false;

    // ── Animations (registered once per scene lifecycle) ──────────────────
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

    // ── Physics sprite ─────────────────────────────────────────────────────
    // Origin (0.5, 1): anchor at bottom-centre, feet on the surface.
    const startX = CAT_X - INITIAL_DISTANCE;
    this._sprite = scene.physics.add.sprite(startX, SURFACE_Y, 'catcher_run');
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setScale(CATCHER_SCALE);
    this._sprite.setDepth(CHASE_DEPTH);
    this._sprite.play('catcher-run');

    // ── Physics body ───────────────────────────────────────────────────────
    const body = this._sprite.body;
    body.setGravityY(GRAVITY_Y);
    body.setCollideWorldBounds(true);

    // Hitbox — same as cat for fairness.
    body.setSize(BODY_WIDTH, BODY_HEIGHT, false);
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

    // ── Collider (one-way — blocks from above only) ────────────────────────
    // Catcher collides with platforms the same way the cat does.
    scene.physics.add.collider(
      this._sprite,
      scene._platforms.group,
      null,
      (catcher, _platform) => catcher.body.velocity.y >= 0,
    );

    // ── Input ──────────────────────────────────────────────────────────────
    this._keys = scene.input.keyboard.addKeys({
      space: Phaser.Input.Keyboard.KeyCodes.SPACE,
    });

    this._onPointerDown = () => { this._jumpRequested = true; };
    scene.input.on('pointerdown', this._onPointerDown);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Current screen-space gap between catcher centre and cat centre (px). */
  get distance() { return Math.max(0, this._distance); }

  /**
   * Call this whenever the cat collides with an obstacle.
   * Triggers the catch lunge; the Nth call (where N = HITS_TO_CATCH) causes restart.
   */
  onObstacleHit() {
    if (this._state !== 'chasing') return; // Ignore while animation is playing
    this._hitCount++;
    this._beginCatch();
  }

  /**
   * Update every frame.
   *
   * @param {number}                    delta      ms since last frame
   * @param {Phaser.GameObjects.Sprite} catSprite  cat sprite reference
   * @returns {boolean}  true when the scene should restart
   */
  update(delta, catSprite) {
    // Cache the sprite so onObstacleHit() can access it.
    this._catSprite = catSprite;

    switch (this._state) {

      // ── Chasing ───────────────────────────────────────────────────────────
      case 'chasing': {
        const body = this._sprite.body;
        const onGround = body.blocked.down;

        // Pin catcher horizontally — close the gap at a fixed rate.
        // The world scrolls left at 150 px/s; catcher moves at 70 px/s,
        // making its screen X advance at 80 px/s (slower than cat's static 80).
        this._distance = Math.max(0, this._distance - CATCHUP_SPEED * (delta / 1000));
        this._sprite.setX(CAT_X - this._distance);

        // Re-apply hitbox every frame (animation may reset it).
        body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

        // ── Jump logic ────────────────────────────────────────────────────
        if (this._jumpState === 'running') {
          if (!onGround) {
            this._jumpState = 'airborne';
            this._coyoteMs = COYOTE_MS;
            this._sprite.anims.stop();
            this._sprite.setFrame(3); // descent frame
            body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
          }
        }

        if (this._jumpState === 'airborne') {
          // Drive frame from velocity.
          this._sprite.setFrame(body.velocity.y < 0 ? 2 : 3);
          body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

          // Tick coyote countdown.
          if (this._coyoteMs > 0) {
            this._coyoteMs = Math.max(0, this._coyoteMs - delta);
          }

          // Landing: return to run animation.
          if (onGround) {
            this._jumpState = 'running';
            this._coyoteMs = 0;
            this._sprite.play('catcher-run');
            body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
          }
        }

        // ── Jump input ────────────────────────────────────────────────────
        const canJump = onGround || this._coyoteMs > 0;
        const keyPressed = Phaser.Input.Keyboard.JustDown(this._keys.space);

        if (canJump && (keyPressed || this._jumpRequested)) {
          body.setVelocityY(JUMP_VEL);
          this._jumpState = 'airborne';
          this._coyoteMs = 0;
          this._sprite.anims.stop();
          this._sprite.setFrame(2); // ascent frame
          body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
        }

        this._jumpRequested = false;
        break;
      }

      // ── Catch animation playing ────────────────────────────────────────────
      case 'catching': {
        this._timer += delta;
        if (this._timer >= CATCH_ANIM_MS) {
          this._onCatchComplete();
        }
        break;
      }

      // ── Done ──────────────────────────────────────────────────────────────
      case 'done':
        return true;
    }

    return false;
  }

  /** Clean up scene objects and listeners. */
  destroy() {
    this._scene.input.off('pointerdown', this._onPointerDown);
    this._sprite.destroy();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _beginCatch() {
    this._state = 'catching';
    this._timer = 0;

    // Lunge to the cat's position and flip to front depth.
    this._sprite.setX(CAT_X + 10);
    this._sprite.setDepth(CATCH_DEPTH);
    this._sprite.play('catcher-catch');

    // Hide the running cat during the lunge.
    if (this._catSprite) this._catSprite.setVisible(false);
  }

  _onCatchComplete() {
    if (this._hitCount >= HITS_TO_CATCH) {
      // Reached hit threshold — the cat is fully caught.  Signal restart.
      this._state = 'done';
    } else {
      // Still escaping — catcher backs off to initial distance and resumes.
      this._distance = INITIAL_DISTANCE;
      this._sprite.setX(CAT_X - INITIAL_DISTANCE);
      this._sprite.setDepth(CHASE_DEPTH);
      this._sprite.play('catcher-run');
      this._state = 'chasing';
      this._timer = 0;
      this._jumpState = 'running';
      this._coyoteMs = 0;

      // Restore the cat.
      if (this._catSprite) this._catSprite.setVisible(true);
    }
  }
}
