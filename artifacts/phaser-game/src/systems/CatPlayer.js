// ---------------------------------------------------------------------------
// CatPlayer — the player character.
//
// The world scrolls left; the cat stays near the left of the screen.
// Arcade physics + gravity settle the cat onto the platform group.
// State machine:  IDLE (cat_start image) → RUNNING (cat_run spritesheet)
//
// The constructor receives surfaceY from PlatformManager so the cat spawns
// exactly on the platform surface and never appears to float in mid-air.
// ---------------------------------------------------------------------------

// Horizontal pin position — where the cat sits on screen (in game px).
const CAT_X = 80;

// Scale applied to both the 128 × 128 source frames → 64 × 64 display.
const CAT_SCALE = 0.5;

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
   * @param {number} surfaceY  World Y of the walkable platform surface.
   */
  constructor(scene, platformGroup, surfaceY) {
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
    // Origin (0.5, 1): anchor at bottom-centre so sprite.y = feet position.
    // Spawn above the surface and let gravity pull the cat down onto it.
    // 60 px above gives a visible "landing" without a long wait.
    const spawnY = surfaceY - 60;

    this._sprite = scene.physics.add.sprite(CAT_X, spawnY, "cat_start");
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setScale(CAT_SCALE);
    this._sprite.setDepth(15); // above all background and platform layers
    this._sprite.setFlipX(false); // cat faces right

    // ── Physics body ──────────────────────────────────────────────────────
    const body = this._sprite.body;
    body.setGravityY(GRAVITY_Y);      // local gravity (global is 0)
    body.setCollideWorldBounds(true); // keep cat on screen even over a gap

    // With origin (0.5, 1) and displaySize 64×64:
    //   body.bottom  = sprite.y  (feet)
    //   body.top     = sprite.y - bodyH
    //
    // Narrow the body to the cat's torso (40 × 58) centered horizontally
    // and flush to the bottom of the display frame.
    //
    // In Phaser 3 arcade physics:
    //   body.x = sprite.x - displayOriginX + offset.x
    //   body.y = sprite.y - displayOriginY + offset.y
    //
    // displayOriginX = 0.5 × 64 = 32   displayOriginY = 1.0 × 64 = 64
    // body.bottom    = body.y + 58   = sprite.y - 64 + 6 + 58 = sprite.y ✓
    body.setSize(40, 58);
    body.setOffset(12, 6);

    // ── Collider ──────────────────────────────────────────────────────────
    scene.physics.add.collider(this._sprite, platformGroup);

    // ── State machine ─────────────────────────────────────────────────────
    this._state         = "idle";
    this._runTimerFired = false;
  }

  // ── Public ──────────────────────────────────────────────────────────────

  /** Call every frame from GameScene.update(). */
  update() {
    const body = this._sprite.body;

    // Keep the cat pinned horizontally — the world scrolls, not the cat.
    body.setVelocityX(0);

    // Once the cat touches down, queue the run animation exactly once.
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
