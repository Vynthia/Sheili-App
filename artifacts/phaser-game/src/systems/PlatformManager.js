import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Tile visual constants
// ---------------------------------------------------------------------------
const TILE_SCALE = 2.00;
const TILE_W     = Math.round(256 * TILE_SCALE); // 512 px
const TILE_H     = Math.round(128 * TILE_SCALE); // 256 px

// Crop (texture-space pixels) — show only the brick rows, identical across all tiles.
const CROP_TOP = 91;
const CROP_H   = 128 - CROP_TOP; // 37 rows

// ---------------------------------------------------------------------------
// Platform layout
//
// PLATFORM_Y : sprite origin Y (top-left, origin 0,0) of each tile.
// SURFACE_Y  : world Y of the walkable surface (where the cat's feet land).
//              = PLATFORM_Y + CROP_TOP × TILE_SCALE  (rounded)
//
// We choose PLATFORM_Y so the tile bottom fills to the canvas edge (270 px):
//   PLATFORM_Y + TILE_H ≈ 270  →  PLATFORM_Y = 13  (13 + 256 = 269)
//
// SURFACE_Y = 13 + round(91 × 2) = 13 + 182 = 195
// ---------------------------------------------------------------------------
const PLATFORM_Y = 13;
const SURFACE_Y  = PLATFORM_Y + Math.round(CROP_TOP * TILE_SCALE); // 195

// ---------------------------------------------------------------------------
// Physics ground
//
// We intentionally do NOT attach physics bodies to the scrolling tile sprites.
// setCrop + setScale in Phaser 3.90 corrupts the StaticBody offset formula
// inside refreshBody(), making the collision surface end up at the wrong Y.
//
// Instead we create ONE invisible static image whose body is pinned explicitly
// at SURFACE_Y via body.reset().  The cat collides with that single body.
// ---------------------------------------------------------------------------
const GROUND_DEPTH = 9; // just below visual tiles (depth 10)

// ---------------------------------------------------------------------------
// Scroll / generation constants
// ---------------------------------------------------------------------------
const SCROLL_SPEED = 150; // px / s — keep in sync with BackgroundManager

const GAP_CHANCE  = 0;  // no gaps until jumping is introduced
const GAP_MIN     = 60;
const GAP_MAX     = 120;
const MID_MIN     = 1;
const MID_MAX     = 3;
const SPAWN_AHEAD = 500;

// ---------------------------------------------------------------------------

export class PlatformManager {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this.scene = scene;

    // ── Visual tiles (no physics) ──────────────────────────────────────────
    this._tiles        = [];
    this._scrollOffset = 0;

    const canvasW = scene.scale.width;
    while (this._getRightEdge() < canvasW + SPAWN_AHEAD) {
      this._spawnRun(this._getRightEdge(), false);
    }

    // ── Physics ground ─────────────────────────────────────────────────────
    // A single invisible StaticBody spanning the full canvas width, positioned
    // exactly at SURFACE_Y.  We use body.reset() to pin the position explicitly
    // so no scale / displayOrigin arithmetic can disturb it.
    if (!scene.textures.exists("__ground_px")) {
      const gfx = scene.add.graphics();
      gfx.fillStyle(0xffffff, 1);
      gfx.fillRect(0, 0, 1, 1);
      gfx.generateTexture("__ground_px", 1, 1);
      gfx.destroy();
    }

    // Create as a standalone static image (origin 0,0 → displayOriginX/Y = 0).
    // We set the body size directly and pin it with body.reset() rather than
    // relying on setDisplaySize + refreshBody(), which can misbehave when scale
    // is very large (e.g. 480×1 → scaleX = 480).
    this._ground = scene.physics.add.staticImage(0, SURFACE_Y, "__ground_px");
    this._ground.setOrigin(0, 0);
    this._ground.setAlpha(0);
    this._ground.setDepth(GROUND_DEPTH);

    // Set body to cover the full canvas width at SURFACE_Y.
    // body.reset(x, y) directly writes position into the broadphase tree —
    // this is the only safe way to move a StaticBody without refreshBody().
    this._ground.body.setSize(canvasW, 8); // 8 px tall — tolerant of 1-frame gaps
    this._ground.body.reset(0, SURFACE_Y);

    // Wrap in a static group so CatPlayer can register a single collider.
    this._group = scene.physics.add.staticGroup();
    // Use group.add() — the StaticGroup createCallback only calls body.reset()
    // (position only, not size), so the setSize above is preserved.
    this._group.add(this._ground);

    // Re-pin after the group's createCallback may have called body.reset():
    this._ground.body.reset(0, SURFACE_Y);
  }

  /** The static physics group — attach player collider here. */
  get group() { return this._group; }

  /**
   * World Y of the walkable brick surface.
   * CatPlayer uses this to place the cat exactly on the platform at spawn.
   */
  get surfaceY() { return SURFACE_Y; }

  /**
   * Call every frame from GameScene.update().
   * @param {number} delta  Phaser delta ms.
   */
  update(delta) {
    this._scrollOffset += SCROLL_SPEED * (delta / 1000);
    const px = Math.round(this._scrollOffset);

    // Scroll visual tiles only (physics ground is fixed).
    for (const tile of this._tiles) {
      tile.x = tile._worldX - px;
    }

    // Recycle tiles scrolled off left.
    while (this._tiles.length > 0 && this._tiles[0].x + TILE_W < 0) {
      this._tiles.shift().destroy();
    }

    // Spawn new visual tiles ahead.
    const canvasW = this.scene.scale.width;
    while (this._getRightEdge() < canvasW + SPAWN_AHEAD) {
      const edge   = this._getRightEdge();
      const addGap = Math.random() < GAP_CHANCE;
      if (addGap) {
        const gapW = Math.round(GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN));
        this._spawnRun(edge + gapW, true);
      } else {
        this._spawnRun(edge, false);
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _spawnRun(screenStartX, withLanding) {
    const px = Math.round(this._scrollOffset);
    let   sx = Math.round(screenStartX);

    if (withLanding) {
      this._addTile("roof_landing", sx, px);
      sx += TILE_W;
    }

    const midCount = MID_MIN + Math.floor(Math.random() * (MID_MAX - MID_MIN + 1));
    this._addTile("roof_left",   sx, px); sx += TILE_W;
    for (let i = 0; i < midCount; i++) {
      this._addTile("roof_middle", sx, px); sx += TILE_W;
    }
    this._addTile("roof_right",  sx, px); sx += TILE_W;
  }

  _addTile(key, screenX, px) {
    // Pure visual sprite — no physics body.
    const tile = this.scene.add.image(screenX, PLATFORM_Y, key);
    tile.setOrigin(0, 0);
    tile.setScale(TILE_SCALE);
    tile.setCrop(0, CROP_TOP, 256, CROP_H);
    tile.setDepth(10);

    tile._worldX = screenX + px;
    this._tiles.push(tile);
    return tile;
  }

  _getRightEdge() {
    if (this._tiles.length === 0) return 0;
    const last = this._tiles[this._tiles.length - 1];
    return last.x + TILE_W;
  }
}
