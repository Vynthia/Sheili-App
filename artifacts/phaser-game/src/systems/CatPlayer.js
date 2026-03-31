// ---------------------------------------------------------------------------
// CatPlayer — the player character.
//
// The world scrolls left; the cat stays near the left of the screen.
// The cat spawns directly on the platform surface and runs immediately.
// ---------------------------------------------------------------------------

// Horizontal pin position (game px).
const CAT_X = 80;

// Scale: 128 × 128 source → 51 × 51 display (128 × 0.4).
const CAT_SCALE = 0.4;

// Local gravity (world gravity is 0).
const GRAVITY_Y = 900;

// Run animation frame rate.
const RUN_FPS = 8;

export class CatPlayer {
  /**
   * @param {Phaser.Scene}  scene
   * @param {Phaser.Physics.Arcade.StaticGroup} platformGroup
   * @param {number} surfaceY  World Y of the walkable surface (cat feet land here).
   */
  constructor(scene, platformGroup, surfaceY) {
    this._scene = scene;

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

    // Start running immediately — no idle/fall-in transition.
    this._sprite.play("cat-run");

    // ── Physics body ──────────────────────────────────────────────────────
    const body = this._sprite.body;
    body.setGravityY(GRAVITY_Y);
    body.setCollideWorldBounds(true);

    // Phaser 3.90 DynamicBody update formula (Body.js lines 1060-1061):
    //   body.x = sprite.x + scaleX × (offsetX − displayOriginX)
    //   body.y = sprite.y + scaleY × (offsetY − displayOriginY)
    //
    // For CAT_SCALE = 0.4, origin (0.5, 1), frame 128 × 128:
    //   displayOriginX = round(0.5 × 128) = 64   (unscaled frame px)
    //   displayOriginY = round(1.0 × 128) = 128
    //
    // Goal — body.bottom == sprite.y (feet flush to surface):
    //   body.y + bodyH = sprite.y
    //   sprite.y + 0.4 × (offsetY − 128) + bodyH = sprite.y
    //   0.4 × (offsetY − 128) + bodyH = 0
    //   offsetY = 128 − bodyH / 0.4 = 128 − 2.5 × bodyH
    //
    //   bodyH = 46  →  offsetY = 128 − 115 = 13  ✓
    //
    // Goal — body horizontally centred on sprite.x:
    //   body.x = sprite.x − bodyW / 2
    //   sprite.x + 0.4 × (offsetX − 64) = sprite.x − bodyW / 2
    //   offsetX = 64 − bodyW / (2 × 0.4) = 64 − 1.25 × bodyW
    //
    //   bodyW = 36  →  offsetX = 64 − 45 = 19  ✓
    //
    // Verification:
    //   body.y    = sprite.y + 0.4 × (13 − 128) = sprite.y − 46
    //   body.bottom = sprite.y − 46 + 46 = sprite.y  ✓
    //   body.x    = sprite.x + 0.4 × (19 − 64) = sprite.x − 18
    //   body.right  = sprite.x − 18 + 36       = sprite.x + 18  (centred)  ✓
    body.setSize(36, 46);
    body.setOffset(19, 13);

    // ── Collider ──────────────────────────────────────────────────────────
    scene.physics.add.collider(this._sprite, platformGroup);
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /** Call every frame from GameScene.update(). */
  update() {
    // Keep the cat pinned horizontally — the world scrolls, not the cat.
    this._sprite.body.setVelocityX(0);
  }

  get sprite() { return this._sprite; }
}
