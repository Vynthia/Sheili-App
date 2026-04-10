// ---------------------------------------------------------------------------
// CatcherEnemy — the cat-catcher who chases the player.
//
// Behaviour
// ─────────
//   • Always visible at the left edge of the 480-px canvas.
//   • Natural creep: closes the gap very slowly between bumps (3 px/s).
//   • Progressive distance stages: each bump snaps the catcher closer after
//     the catch animation finishes.
//       0 hits → 120 px behind  (stage 0, start)
//       1 hit  →  65 px behind  (stage 1, 1st escape)
//       2 hits →  20 px behind  (stage 2, 2nd escape)
//       3 hits → catcher catches the cat → scene restarts
//   • Y bobbing: ±3 px sine wave so the catcher doesn't feel rigidly locked.
//
// Danger scalebar (HUD)
// ─────────────────────
//   Three segments at top-left.  Each segment fills when the cat is hit.
//   Colours: empty=0x222233 | hit-1=0xFF8800 | hit-2=0xFF3300 | hit-3=0xFF0000
//
// State machine
// ─────────────
//   'chasing'  → natural creep + jump ability; waiting for onObstacleHit()
//   'catching' → catcher_catch animation playing (CATCH_ANIM_MS)
//   'done'     → signals GameScene to restart
// ---------------------------------------------------------------------------

import Phaser from "phaser";

// ── Layout constants (must match GameScene / ObstacleManager) ──────────────
const CAT_X       = 80;    // Cat fixed screen X
const SURFACE_Y   = 195;   // Ground surface Y (feet)

// ── Catcher render ──────────────────────────────────────────────────────────
const CATCHER_SCALE = 0.5; // 128 × 128 source → 64 × 64 display

// ── Progressive distance stages (px behind cat) ────────────────────────────
// Index = hitCount at the END of the catch animation (i.e. how many escapes).
//
// Canvas = 480 px, CAT_X = 80, sprite displayWidth = 64 (128 × 0.5).
// Catcher right-edge = (CAT_X − distance) + 32.  Visible when right-edge > 0.
//
//   STAGES[0] = 85  → catcher.x = −5,  right-edge = 27 px on screen  (≈40 % visible — "someone is there")
//   STAGES[1] = 50  → catcher.x = 30,  right-edge = 62 px on screen  (≈95 % visible — "getting close!")
//   STAGES[2] = 18  → catcher.x = 62,  right-edge = 94 px on screen  (overlapping cat — "RIGHT THERE!")
//   3rd hit → final catch.
const DISTANCE_STAGES = [85, 50, 18];

// ── Physics / jump ──────────────────────────────────────────────────────────
const JUMP_VEL    = -380;
const GRAVITY_Y   = 900;
const COYOTE_MS   = 150;

// Hitbox (same geometry as cat for fair collision with platforms).
const BODY_WIDTH    = 28;
const BODY_HEIGHT   = 40;
const BODY_OFFSET_X = 22;
const BODY_OFFSET_Y = 76;

// ── Chase / animation constants ─────────────────────────────────────────────
const CATCHUP_SPEED  = 3;   // px / second natural creep (VERY slow)
const BOB_AMPLITUDE  = 3;   // px  — vertical sine-wave range
const BOB_SPEED      = 0.0025; // radians per ms

const CHASE_DEPTH    = 15;  // behind cat (depth 20) while running
const CATCH_DEPTH    = 25;  // in front of cat while the net swings

const CATCH_ANIM_MS  = 900; // ms the catcher_catch animation plays per lunge
const HITS_TO_CATCH  = 3;   // total hits before the cat is caught

// ── Scalebar HUD ────────────────────────────────────────────────────────────
const BAR_X         = 10;   // left edge of the bar group (canvas px)
const BAR_Y         = 10;   // top edge
const SEG_W         = 18;   // width of each segment
const SEG_H         = 7;    // height of each segment
const SEG_GAP       = 3;    // gap between segments

const COL_EMPTY     = 0x222233;
const SEG_COLOURS   = [0xFF8800, 0xFF3300, 0xFF0000]; // per hit

// ---------------------------------------------------------------------------

export class CatcherEnemy {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this._scene      = scene;
    this._state      = 'chasing';
    this._distance   = DISTANCE_STAGES[0];
    this._timer      = 0;
    this._hitCount   = 0;
    this._catSprite  = null;
    this._bobTime    = 0;

    // Jump sub-state.
    this._jumpState = 'running';
    this._coyoteMs  = 0;
    this._jumpRequested = false;

    // ── Animations ────────────────────────────────────────────────────────
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
    const startX = CAT_X - DISTANCE_STAGES[0];
    this._sprite = scene.physics.add.sprite(startX, SURFACE_Y, 'catcher_run');
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setScale(CATCHER_SCALE);
    this._sprite.setDepth(CHASE_DEPTH);
    this._sprite.play('catcher-run');

    // Physics body.
    const body = this._sprite.body;
    body.setGravityY(GRAVITY_Y);
    body.setCollideWorldBounds(false); // X is managed manually; world bounds cause jitter
    body.setSize(BODY_WIDTH, BODY_HEIGHT, false);
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

    // One-way platform collider (same logic as cat).
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

    // ── Danger scalebar (HUD) ──────────────────────────────────────────────
    this._barSegs = [];
    for (let i = 0; i < HITS_TO_CATCH; i++) {
      const x = BAR_X + i * (SEG_W + SEG_GAP);

      // Background (always visible).
      scene.add.rectangle(x + SEG_W / 2, BAR_Y + SEG_H / 2, SEG_W, SEG_H, COL_EMPTY)
        .setDepth(100)
        .setScrollFactor(0);

      // Fill (initially hidden, shown on each hit).
      const fill = scene.add.rectangle(x + SEG_W / 2, BAR_Y + SEG_H / 2, SEG_W, SEG_H, SEG_COLOURS[i])
        .setDepth(101)
        .setScrollFactor(0)
        .setVisible(false);

      this._barSegs.push(fill);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** px behind the cat. */
  get distance() { return Math.max(0, this._distance); }

  /**
   * Called when the cat collides with an obstacle.
   * Triggers the catch lunge; the 3rd call causes a final catch → restart.
   */
  onObstacleHit() {
    if (this._state !== 'chasing') return;
    this._hitCount++;
    this._activateBarSegment(this._hitCount - 1);
    this._beginCatch();
  }

  /**
   * @param {number}                    delta
   * @param {Phaser.GameObjects.Sprite} catSprite
   * @returns {boolean}  true → GameScene should restart
   */
  update(delta, catSprite) {
    this._catSprite = catSprite;

    switch (this._state) {

      case 'chasing': {
        const body = this._sprite.body;

        // ── Floor clamp ─────────────────────────────────────────────────
        // The catcher may start off-screen left where no platform tile
        // exists. Without a tile, body.blocked.down is never true and
        // gravity pulls the catcher off the bottom of the canvas.
        // Clamp Y to SURFACE_Y so the catcher always has a visible floor.
        if (this._sprite.y >= SURFACE_Y && this._jumpState === 'airborne') {
          this._sprite.setY(SURFACE_Y);
          body.setVelocityY(0);
          this._jumpState = 'running';
          this._coyoteMs  = 0;
          this._sprite.play('catcher-run');
          body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
        }

        // Count as "on ground" if the physics body is blocked below OR if
        // the sprite has been clamped to the surface already.
        const onGround = body.blocked.down || this._sprite.y >= SURFACE_Y;

        // ── Horizontal position ─────────────────────────────────────────
        // Creep slowly closer; never advance past a safe minimum gap so the
        // catcher can never physically overlap the cat on its own.
        const MIN_DISTANCE = 14;
        this._distance = Math.max(MIN_DISTANCE, this._distance - CATCHUP_SPEED * (delta / 1000));

        // X and horizontal velocity are managed manually.
        this._sprite.setX(CAT_X - this._distance);
        body.setVelocityX(0);

        // ── Vertical bob ────────────────────────────────────────────────
        this._bobTime += delta;
        const bobY = Math.sin(this._bobTime * BOB_SPEED) * BOB_AMPLITUDE;
        if (this._jumpState === 'running') {
          this._sprite.setY(SURFACE_Y + bobY);
        }

        // ── Body offset (keep locked after frame changes) ───────────────
        body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

        // ── Jump state machine ──────────────────────────────────────────
        if (this._jumpState === 'running') {
          if (!onGround) {
            this._jumpState = 'airborne';
            this._coyoteMs  = COYOTE_MS;
            this._sprite.anims.stop();
            this._sprite.setFrame(3);
            body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
          }
        }

        if (this._jumpState === 'airborne') {
          this._sprite.setFrame(body.velocity.y < 0 ? 2 : 3);
          body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

          if (this._coyoteMs > 0) {
            this._coyoteMs = Math.max(0, this._coyoteMs - delta);
          }

          if (onGround) {
            this._jumpState = 'running';
            this._coyoteMs  = 0;
            this._sprite.play('catcher-run');
            body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
          }
        }

        // ── Jump input ──────────────────────────────────────────────────
        const canJump = onGround || this._coyoteMs > 0;
        const keyDown = Phaser.Input.Keyboard.JustDown(this._keys.space);
        if (canJump && (keyDown || this._jumpRequested)) {
          body.setVelocityY(JUMP_VEL);
          this._jumpState = 'airborne';
          this._coyoteMs  = 0;
          this._sprite.anims.stop();
          this._sprite.setFrame(2);
          body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
        }
        this._jumpRequested = false;
        break;
      }

      case 'catching': {
        this._timer += delta;
        if (this._timer >= CATCH_ANIM_MS) {
          this._onCatchComplete();
        }
        break;
      }

      case 'done':
        return true;
    }

    return false;
  }

  destroy() {
    this._scene.input.off('pointerdown', this._onPointerDown);
    this._sprite.destroy();
    // Bar segments are plain GameObjects; they'll be cleaned up by scene.restart().
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Light up bar segment at index i. */
  _activateBarSegment(i) {
    if (i >= 0 && i < this._barSegs.length) {
      this._barSegs[i].setVisible(true);
    }
  }

  _beginCatch() {
    this._state = 'catching';
    this._timer = 0;

    this._sprite.setX(CAT_X + 10);
    this._sprite.setDepth(CATCH_DEPTH);
    this._sprite.play('catcher-catch');

    if (this._catSprite) this._catSprite.setVisible(false);
  }

  _onCatchComplete() {
    if (this._hitCount >= HITS_TO_CATCH) {
      // Final catch — signal restart.
      this._state = 'done';
    } else {
      // Cat escaped again.  Snap catcher to the next closer stage and resume.
      const nextStage = DISTANCE_STAGES[this._hitCount] ?? DISTANCE_STAGES[DISTANCE_STAGES.length - 1];
      this._distance = nextStage;
      this._sprite.setX(CAT_X - nextStage);
      this._sprite.setY(SURFACE_Y);
      this._sprite.setDepth(CHASE_DEPTH);
      this._sprite.play('catcher-run');
      this._state     = 'chasing';
      this._timer     = 0;
      this._jumpState = 'running';
      this._coyoteMs  = 0;
      this._bobTime   = 0;

      if (this._catSprite) this._catSprite.setVisible(true);
    }
  }
}
