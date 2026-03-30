// ---------------------------------------------------------------------------
// CatPlayer — the player character.
//
// The world scrolls left; the cat stays near the left of the screen.
// Arcade physics + gravity settle the cat onto the platform group.
// State machine:  IDLE (cat_start image) → RUNNING (cat_run spritesheet)
// ---------------------------------------------------------------------------

// Horizontal pin position — where the cat sits on screen (in game px).
const CAT_X = 80;

// Scale applied to both the 128 × 128 source frames.
const CAT_SCALE = 0.5; // → 64 × 64 display

// How strongly the cat is pulled down (world gravity is 0).
const GRAVITY_Y = 900;

// Delay between landing and starting the run animation (ms).
const RUN_DELAY_MS = 600;

// Run animation frame rate (fps).
const RUN_FPS = 8;

export class CatPlayer {
  /**
   * @param {Phaser.Scene}  scene
   * @param {Phaser.Physics.Arcade.StaticGroup} platformGroup
   */
  constructor(scene, platformGroup) {
    this._scene = scene;

    // ── Animation (only register once) ────────────────────────────────────
    if (!scene.anims.exists("cat-run")) {
      scene.anims.create({
        key: "cat-run",
        frames: scene.anims.generateFrameNumbers("cat_run", {
          start: 0,
          end: 3,
        }),
        frameRate: RUN_FPS,
        repeat: -1,
      });
    }

    // ── Sprite ────────────────────────────────────────────────────────────
    // Spawn above the platform; gravity pulls it down to land naturally.
    // Origin (0.5, 1): anchor at bottom-centre so sprite.y = feet position.
    // When landed, sprite.y will equal the platform surface Y (≈ 244).
    this._sprite = scene.physics.add.sprite(CAT_X, 160, "cat_start");
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setScale(CAT_SCALE);
    this._sprite.setDepth(15); // above all background and platform layers
    this._sprite.setFlipX(false); // cat faces right

    // ── Physics body ──────────────────────────────────────────────────────
    const body = this._sprite.body;
    body.setGravityY(GRAVITY_Y);     // local gravity (global is 0)
    body.setCollideWorldBounds(false); // world bounds don't clip the cat

    // Narrow the body to the cat's torso so it sits flush on the platform.
    // At scale 0.5 the full display frame is 64 × 64.  We use 40 × 58 so
    // the cat doesn't hover and its head doesn't collide above it.
    // With origin (0.5, 1): top-left of frame = (sprite.x - 32, sprite.y - 64).
    // Offset: centre the 40-wide body → offsetX = (64-40)/2 = 12
    //         push body down by 6 px → offsetY = 64-58 = 6
    body.setSize(40, 58);
    body.setOffset(12, 6);

    // ── Collider ──────────────────────────────────────────────────────────
    scene.physics.add.collider(this._sprite, platformGroup);

    // ── State machine ─────────────────────────────────────────────────────
    this._state          = "idle"; // "idle" | "running"
    this._landedOnce     = false;
    this._runTimerFired  = false;
  }

  // ── Public ──────────────────────────────────────────────────────────────

  /** Call every frame from GameScene.update(). */
  update() {
    const body = this._sprite.body;

    // Keep the cat pinned horizontally — the world scrolls, not the cat.
    body.setVelocityX(0);

    // Once the cat lands for the first time, queue the run animation.
    if (!this._runTimerFired && body.blocked.down) {
      this._runTimerFired = true;
      this._scene.time.delayedCall(RUN_DELAY_MS, () => {
        this._sprite.play("cat-run");
        this._state = "running";
      });
    }
  }

  get sprite() { return this._sprite; }
  get state()  { return this._state;  }
}
