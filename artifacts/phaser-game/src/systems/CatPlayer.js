// ---------------------------------------------------------------------------
// CatPlayer — the player character.
//
// The world scrolls left; the cat stays near the left of the screen.
// The cat spawns directly on the platform surface and runs immediately.
// ---------------------------------------------------------------------------

// Horizontal pin position (game px).
const CAT_X = 80;

// Scale: 128 × 128 source → 64 × 64 display (128 × 0.5).
const CAT_SCALE = 0.5;

// Local gravity (world gravity is 0).
const GRAVITY_Y = 900;

// Jump impulse applied on take-off (negative = upward).
// Peak height = JUMP_VEL² / (2 × GRAVITY_Y) ≈ 310² / 1800 ≈ 53 game-px.
const JUMP_VEL = -310;

// Run animation frame rate.
const RUN_FPS = 8;

// ---------------------------------------------------------------------------
// Coyote time: how long (ms) after walking off a platform edge the cat can
// still jump.  Keeps gaps forgiving without allowing double-jumps.
// ---------------------------------------------------------------------------
const COYOTE_MS = 150;

// ---------------------------------------------------------------------------
// Body offset — kept as named constants so they can be re-applied each frame.
//
// WHY re-apply every frame: Phaser 3's animation system may call
// body.setSize() internally on frame changes, which resets offset to (0,0)
// if body.customSize is not reliably preserved across hot-reload or certain
// Phaser version quirks.  Calling setOffset() each frame is cheap (two
// number writes + a center recalc) and guarantees correctness.
// ---------------------------------------------------------------------------
const BODY_OFFSET_X = 19;
const BODY_OFFSET_Y = 70;

export class CatPlayer {
  /**
   * @param {Phaser.Scene}  scene
   * @param {Phaser.Physics.Arcade.StaticGroup} platformGroup
   * @param {number} surfaceY  World Y of the walkable surface (cat feet land here).
   */
  constructor(scene, platformGroup, surfaceY) {
    this._scene = scene;

    // ── State machine ──────────────────────────────────────────────────────
    // 'running'  – firmly on the ground; run animation active.
    // 'airborne' – in the air for any reason (jumped OR walked off edge).
    //              Frame 2 = ascent, frame 3 = descent.
    //
    // Start as 'airborne': the cat spawns 1 px above the surface and
    // physics resolves it to the ground in the first step (imperceptible).
    this._state    = 'airborne';

    // Coyote-time countdown (ms).  > 0 for a short window after the cat
    // walks off an edge, allowing a jump even though onGround is false.
    this._coyoteMs = 0;

    // Consumed once per update() — set by the pointerdown listener below.
    this._jumpRequested = false;

    // ── Animation (register once) ──────────────────────────────────────────
    if (!scene.anims.exists("cat-run")) {
      scene.anims.create({
        key: "cat-run",
        frames: scene.anims.generateFrameNumbers("cat_run", { start: 0, end: 3 }),
        frameRate: RUN_FPS,
        repeat: -1,
      });
    }

    // ── Sprite ────────────────────────────────────────────────────────────
    // Origin (0.5, 1): anchor at bottom-centre → sprite.y is the feet Y.
    this._sprite = scene.physics.add.sprite(CAT_X, surfaceY - 1, "cat_run");
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setScale(CAT_SCALE);
    this._sprite.setDepth(15);
    this._sprite.setFlipX(false);
    this._sprite.setFrame(3); // descent frame while dropping to the surface

    // ── Physics body ──────────────────────────────────────────────────────
    const body = this._sprite.body;
    body.setGravityY(GRAVITY_Y);
    body.setCollideWorldBounds(true);

    // Hitbox — setSize with center:false so Phaser doesn't auto-center
    // the body (which would overwrite the manual offset below).
    body.setSize(36, 46, false);
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

    // ── Collider (one-way — blocks from above only) ────────────────────────
    // processCallback returns true only when the cat is falling (velocity.y ≥ 0).
    //   • Platforms stop the cat landing on them from above.             ✓
    //   • Platforms do NOT block the cat rising through them.             ✓
    //     Needed so a coyote-time jump can carry the cat upward through
    //     the edge of a segment body it has already dipped into slightly.
    scene.physics.add.collider(
      this._sprite,
      platformGroup,
      null,
      (cat, _platform) => cat.body.velocity.y >= 0,
    );

    // ── Input ─────────────────────────────────────────────────────────────
    this._keys = scene.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.UP,
      space: Phaser.Input.Keyboard.KeyCodes.SPACE,
    });

    scene.input.on('pointerdown', () => {
      this._jumpRequested = true;
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _doJump() {
    const body = this._sprite.body;
    body.setVelocityY(JUMP_VEL);
    this._state    = 'airborne';
    this._coyoteMs = 0; // consume any remaining coyote window

    this._sprite.anims.stop();
    this._sprite.setFrame(2); // ascent frame
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y); // re-apply after setFrame
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Call every frame from GameScene.update().
   * @param {number} delta  Phaser delta ms.
   */
  update(delta) {
    const body     = this._sprite.body;
    const onGround = body.blocked.down;

    // Pin cat horizontally — the world scrolls, not the cat.
    body.setVelocityX(0);

    // Defensive: keep the body offset locked regardless of what Phaser's
    // animation internals may have done since last frame.
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);

    // ── State: RUNNING ────────────────────────────────────────────────────
    if (this._state === 'running') {
      if (!onGround) {
        // Cat has walked off a platform edge — enter airborne state and open
        // the coyote window so a slightly-late jump still works.
        this._state    = 'airborne';
        this._coyoteMs = COYOTE_MS;
        this._sprite.anims.stop();
        this._sprite.setFrame(3); // show descent frame
        body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y); // re-apply after setFrame
      }
    }

    // ── State: AIRBORNE ───────────────────────────────────────────────────
    if (this._state === 'airborne') {
      // Drive frame from velocity: 2 = ascending, 3 = descending / falling.
      this._sprite.setFrame(body.velocity.y < 0 ? 2 : 3);
      body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y); // re-apply after setFrame

      // Tick coyote countdown.
      if (this._coyoteMs > 0) {
        this._coyoteMs = Math.max(0, this._coyoteMs - delta);
      }

      // Landing: return to run animation.
      if (onGround) {
        this._state    = 'running';
        this._coyoteMs = 0;
        this._sprite.play('cat-run');
        body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y); // re-apply after play()
      }
    }

    // ── Jump input ────────────────────────────────────────────────────────
    // Allowed when: (a) on the ground, or (b) within the coyote window.
    const canJump = onGround || this._coyoteMs > 0;

    if (canJump) {
      const keyPressed =
        Phaser.Input.Keyboard.JustDown(this._keys.up) ||
        Phaser.Input.Keyboard.JustDown(this._keys.space);

      if (keyPressed || this._jumpRequested) {
        this._doJump();
      }
    }

    // Consume the pointer flag so it doesn't repeat next frame.
    this._jumpRequested = false;
  }

  get sprite() { return this._sprite; }
}
