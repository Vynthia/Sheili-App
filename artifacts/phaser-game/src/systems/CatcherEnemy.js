// ---------------------------------------------------------------------------
// CatcherEnemy — the cat-catcher who chases the player.
//
// The catcher is always visible on the left edge of the screen.  It slowly
// closes the gap on its own, but bump events are what drive the drama:
//   • 1st obstacle hit  → catcher lunges to the cat, plays catcher_catch,
//                          then backs off to the initial distance and resumes
//                          chasing (cat escaped the net this time).
//   • 2nd obstacle hit  → catcher lunges again, plays catcher_catch,
//                          then the scene restarts.
//
// State machine:
//   'chasing'    → natural slow catch-up; waiting for onObstacleHit()
//   'catching'   → catcher_catch animation playing (CATCH_ANIM_MS)
//   'done'       → signals GameScene to restart (only after 2nd hit)
// ---------------------------------------------------------------------------

// Cat's fixed screen X (must match CatPlayer.CAT_X).
const CAT_X          = 80;

// Surface Y for feet-anchor (must match SURFACE_Y in ObstacleManager).
const SURFACE_Y      = 195;

// Catcher display scale (source sprites are 128 × 128 px → 64 × 64 display).
const CATCHER_SCALE  = 0.5;

// Starting gap behind the cat (px).
// At x = CAT_X − INITIAL_DISTANCE the sprite is partially visible at the
// left edge of the 480-px canvas, giving a clear "chasing" read.
const INITIAL_DISTANCE = 70;

// Natural catch-up rate (px / second).  Very slow — the bumps are what matter.
const CATCHUP_SPEED    = 3;

// Depth while chasing: behind cat (cat = 20).
const CHASE_DEPTH      = 15;

// Depth during catch animation: in front of cat so the net overlaps it.
const CATCH_DEPTH      = 25;

// How long (ms) the catcher_catch animation plays per lunge.
const CATCH_ANIM_MS    = 900;

// ---------------------------------------------------------------------------

export class CatcherEnemy {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this._scene    = scene;
    this._state    = 'chasing';
    this._distance = INITIAL_DISTANCE;
    this._timer    = 0;
    this._hitCount = 0;      // 0 → 1 → 2; at 2 the scene restarts
    this._catSprite = null;  // cached each frame from update()

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

    // ── Catcher sprite ─────────────────────────────────────────────────────
    // Origin (0.5, 1): anchor at bottom-centre, feet on the surface.
    // At INITIAL_DISTANCE = 70 the centre is at x = 10; right half of the
    // sprite shows on screen, giving a clear "chaser at the edge" read.
    this._sprite = scene.add.sprite(CAT_X - INITIAL_DISTANCE, SURFACE_Y, 'catcher_run');
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setScale(CATCHER_SCALE);
    this._sprite.setDepth(CHASE_DEPTH);
    this._sprite.play('catcher-run');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Current screen-space gap between catcher centre and cat centre (px). */
  get distance() { return Math.max(0, this._distance); }

  /**
   * Call this whenever the cat collides with an obstacle.
   * Triggers the catch lunge on every bump.
   * The 2nd call causes the scene to restart after the animation.
   */
  onObstacleHit() {
    if (this._state !== 'chasing') return; // ignore while animation is playing
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
    // Cache the sprite so onObstacleHit() can access it without an argument.
    this._catSprite = catSprite;

    switch (this._state) {

      // ── Chasing ───────────────────────────────────────────────────────────
      case 'chasing': {
        // Slowly close the gap.
        this._distance = Math.max(0, this._distance - CATCHUP_SPEED * (delta / 1000));
        this._sprite.setX(CAT_X - this._distance);
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

  /** Clean up scene objects. */
  destroy() {
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
    if (this._hitCount >= 2) {
      // Second hit — the cat is fully caught.  Signal restart.
      this._state = 'done';
    } else {
      // First hit — cat escapes; catcher backs off to initial distance.
      this._distance = INITIAL_DISTANCE;
      this._sprite.setX(CAT_X - INITIAL_DISTANCE);
      this._sprite.setDepth(CHASE_DEPTH);
      this._sprite.play('catcher-run');
      this._state = 'chasing';
      this._timer = 0;

      // Restore the cat.
      if (this._catSprite) this._catSprite.setVisible(true);
    }
  }
}
