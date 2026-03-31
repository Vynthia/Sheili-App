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
// still jump.  Keeps small gaps forgiving without allowing double-jumps.
// ---------------------------------------------------------------------------
const COYOTE_MS = 150;

export class CatPlayer {
  /**
   * @param {Phaser.Scene}  scene
   * @param {Phaser.Physics.Arcade.StaticGroup} platformGroup
   * @param {number} surfaceY  World Y of the walkable surface (cat feet land here).
   */
  constructor(scene, platformGroup, surfaceY) {
    this._scene = scene;

    // ── State ─────────────────────────────────────────────────────────────
    // 'running'  – on the ground (or within coyote window), run anim active.
    // 'airborne' – in the air; frames driven by velocity until landing.
    this._state = 'running';

    // Coyote-time countdown (ms).  Positive while the cat may still jump
    // after walking off a platform edge.
    this._coyoteMs = 0;

    // Whether the cat was on the ground at the start of the previous frame.
    this._wasOnGround = true;

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
    // Spawn 1 px above the surface; gravity snaps the body into contact
    // within the first physics step (imperceptible on screen).
    this._sprite = scene.physics.add.sprite(CAT_X, surfaceY - 1, "cat_run");
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setScale(CAT_SCALE);
    this._sprite.setDepth(15);
    this._sprite.setFlipX(false);
    this._sprite.play("cat-run");

    // ── Physics body ──────────────────────────────────────────────────────
    const body = this._sprite.body;
    body.setGravityY(GRAVITY_Y);
    body.setCollideWorldBounds(true);

    // Hitbox positioned via manual tuning.
    body.setSize(36, 46);
    body.setOffset(19, 70);

    // ── Collider (one-way) ─────────────────────────────────────────────────
    // The processCallback returns true only when the cat is falling
    // (velocity.y >= 0).  This means:
    //   • Platforms block the cat landing on them from above.      ✓
    //   • Platforms do NOT block the cat rising through them.      ✓
    //     (Important for coyote-time jumps where the cat has already
    //      dipped slightly below the next segment's body top.)
    scene.physics.add.collider(
      this._sprite,
      platformGroup,
      null,
      (cat, _platform) => cat.body.velocity.y >= 0,
    );

    // ── Input ─────────────────────────────────────────────────────────────
    // Keyboard: Space and Up arrow.
    // JustDown() detects a single press this frame, so holding the key down
    // does not fire repeatedly.
    this._keys = scene.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.UP,
      space: Phaser.Input.Keyboard.KeyCodes.SPACE,
    });

    // Pointer: mouse click + touch.
    // Set a flag and consume it in update() — avoids multi-fire on held touch.
    scene.input.on('pointerdown', () => {
      this._jumpRequested = true;
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _doJump() {
    this._sprite.body.setVelocityY(JUMP_VEL);
    this._state   = 'airborne';
    this._coyoteMs = 0; // consume the coyote window so it can't fire again

    // Stop the run animation and show the ascent frame immediately.
    this._sprite.anims.stop();
    this._sprite.setFrame(2);
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Call every frame from GameScene.update().
   * @param {number} delta  Phaser delta ms.
   */
  update(delta) {
    const body     = this._sprite.body;
    const onGround = body.blocked.down;

    // Keep the cat pinned horizontally — the world scrolls, not the cat.
    body.setVelocityX(0);

    // ── Coyote time ───────────────────────────────────────────────────────
    // If the cat just walked off an edge (was grounded, now airborne, and
    // didn't jump), open the coyote window.  This lets the player jump a
    // few frames late and still clear a gap.
    if (this._wasOnGround && !onGround && this._state === 'running') {
      this._coyoteMs = COYOTE_MS;
    }

    // Count the coyote timer down while airborne.
    if (!onGround && this._coyoteMs > 0) {
      this._coyoteMs = Math.max(0, this._coyoteMs - delta);
    }

    // Remember grounded state for next frame's coyote check.
    this._wasOnGround = onGround;

    // ── Airborne frame arc ────────────────────────────────────────────────
    // Frame 2 = ascent (velocity going up), frame 3 = descent (going down).
    if (this._state === 'airborne') {
      this._sprite.setFrame(body.velocity.y < 0 ? 2 : 3);

      // Landing detection.
      if (onGround) {
        this._state = 'running';
        this._sprite.play('cat-run');
      }
    }

    // ── Jump input ────────────────────────────────────────────────────────
    // Allowed when: (a) firmly on the ground, or (b) within the coyote window.
    // Prevents double-jumps — coyote time is consumed on take-off (_doJump).
    const canJump = onGround || this._coyoteMs > 0;

    if (canJump) {
      const keyPressed =
        Phaser.Input.Keyboard.JustDown(this._keys.up) ||
        Phaser.Input.Keyboard.JustDown(this._keys.space);

      if (keyPressed || this._jumpRequested) {
        this._doJump();
      }
    }

    // Always consume the pointer flag so it doesn't fire again next frame.
    this._jumpRequested = false;
  }

  get sprite() { return this._sprite; }
}
