// ---------------------------------------------------------------------------
// CatcherEnemy — the cat-catcher who chases the player.
//
// The catcher appears behind the cat and slowly closes the gap.
// Each obstacle the cat hits gives the catcher a significant boost.
// When the catcher reaches the cat a catch animation plays, then the
// sitting_cat sprite appears under the landing net, and the scene restarts.
//
// State machine:
//   'chasing'  → natural catch-up + collision penalties
//   'catching' → catch animation playing (CATCH_ANIM_MS)
//   'sitting'  → sitting_cat visible, waiting (SITTING_MS)
//   'done'     → signals GameScene to restart
// ---------------------------------------------------------------------------

// Cat's fixed screen X position (must match CatPlayer.CAT_X).
const CAT_X        = 80;

// Surface Y (cat feet / catcher feet, must match SURFACE_Y in ObstacleManager).
const SURFACE_Y    = 195;

// Catcher display scale (source sprites are 128 × 128 px).
const CATCHER_SCALE = 0.5;

// How far behind the cat (px) the catcher starts.
// At CATCHUP_SPEED px/s this gives ~45 s of clean runway with no mistakes.
const INITIAL_DISTANCE   = 360;

// Natural catch-up rate (px per second, always active).
const CATCHUP_SPEED      = 8;

// Additional distance gained each time the cat collides with an obstacle.
// Four clean jumps worth of debt — keeps the threat escalating.
const COLLISION_PENALTY  = 80;

// Depth while chasing: behind the cat (cat = 20).
const CHASE_DEPTH   = 15;

// Depth during catch: in front of the cat so the net overlaps it.
const CATCH_DEPTH   = 25;

// Depth of the sitting-cat image.
const SITTING_DEPTH = 22;

// How long (ms) the catch animation plays before the sitting_cat appears.
const CATCH_ANIM_MS = 900;

// How long (ms) the sitting_cat is shown before the scene restarts.
const SITTING_MS    = 1300;

// ---------------------------------------------------------------------------

export class CatcherEnemy {
  /**
   * @param {Phaser.Scene} scene
   */
  constructor(scene) {
    this._scene    = scene;
    this._state    = 'chasing';
    this._distance = INITIAL_DISTANCE;
    this._timer    = 0;

    // ── Animations (register once per scene lifecycle) ─────────────────────
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
    // Origin (0.5, 1): anchor at bottom-centre, same as cat.
    const startX     = CAT_X - INITIAL_DISTANCE;
    this._sprite     = scene.add.sprite(startX, SURFACE_Y, 'catcher_run');
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setScale(CATCHER_SCALE);
    this._sprite.setDepth(CHASE_DEPTH);
    this._sprite.play('catcher-run');

    // ── Sitting-cat image (hidden until catch completes) ──────────────────
    this._sittingCat = scene.add.image(CAT_X, SURFACE_Y, 'sitting_cat');
    this._sittingCat.setOrigin(0.5, 1);
    this._sittingCat.setScale(CATCHER_SCALE);
    this._sittingCat.setDepth(SITTING_DEPTH);
    this._sittingCat.setVisible(false);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * The current gap between the catcher and the cat (px).
   * Zero or below triggers the catch sequence.
   */
  get distance() { return Math.max(0, this._distance); }

  /**
   * Call this whenever the cat collides with an obstacle.
   * Boosts the catcher forward by COLLISION_PENALTY px.
   */
  onObstacleHit() {
    if (this._state !== 'chasing') return;
    this._distance = Math.max(0, this._distance - COLLISION_PENALTY);
  }

  /**
   * Update every frame.
   *
   * @param {number}                   delta      ms since last frame
   * @param {Phaser.GameObjects.Sprite} catSprite  used to hide the cat on catch
   * @returns {boolean}  true when the scene should restart
   */
  update(delta, catSprite) {
    switch (this._state) {

      // ── Chasing ──────────────────────────────────────────────────────────
      case 'chasing': {
        // Close the distance naturally.
        this._distance -= CATCHUP_SPEED * (delta / 1000);

        // Clamp at zero so sprite doesn't overshoot.
        if (this._distance < 0) this._distance = 0;

        // Reposition the catcher sprite.
        this._sprite.setX(CAT_X - this._distance);

        // Check catch condition.
        if (this._distance <= 0) {
          this._beginCatch(catSprite);
        }
        break;
      }

      // ── Catch animation playing ───────────────────────────────────────────
      case 'catching': {
        this._timer += delta;
        if (this._timer >= CATCH_ANIM_MS) {
          // Net has landed — reveal the sitting cat.
          this._sittingCat.setVisible(true);
          this._state = 'sitting';
          this._timer = 0;
        }
        break;
      }

      // ── Sitting cat visible ───────────────────────────────────────────────
      case 'sitting': {
        this._timer += delta;
        if (this._timer >= SITTING_MS) {
          this._state = 'done';
          return true; // signal GameScene to restart
        }
        break;
      }

      // ── Done ─────────────────────────────────────────────────────────────
      case 'done':
        return true;
    }

    return false;
  }

  /** Clean up when the scene shuts down. */
  destroy() {
    this._sprite.destroy();
    this._sittingCat.destroy();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _beginCatch(catSprite) {
    this._state = 'catching';
    this._timer = 0;

    // Move catcher to the cat's exact position and bring it to front.
    this._sprite.setX(CAT_X + 10);
    this._sprite.setDepth(CATCH_DEPTH);
    this._sprite.play('catcher-catch');

    // Hide the running cat.
    catSprite.setVisible(false);
  }
}
