import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Tile visual constants
// ---------------------------------------------------------------------------
const TILE_SCALE = 1.25;
const TILE_W     = Math.round(256 * TILE_SCALE); // 320 px
const TILE_H     = Math.round(128 * TILE_SCALE); // 160 px

// Crop (texture-space pixels) — show only the brick rows, identical across all tiles.
const CROP_TOP = 91;
const CROP_H   = 128 - CROP_TOP; // 37 rows

// ---------------------------------------------------------------------------
// Platform layout
//
// PLATFORM_Y : sprite origin Y of each tile.
// SURFACE_Y  : world Y of the walkable surface (where the cat's feet land).
//              = PLATFORM_Y + CROP_TOP * TILE_SCALE  (rounded)
//
// PLATFORM_Y: raised 10 px above the canvas-filling position so the cat walks
// on the highest visible ridge of the tile artwork.
// Tile bottom = 100 + 160 = 260 (a small dark sliver shows below — acceptable).
//
// SURFACE_Y = 100 + round(91 × 1.25) = 100 + 114 = 214
// ---------------------------------------------------------------------------
const PLATFORM_Y = 100;
const SURFACE_Y  = PLATFORM_Y + Math.round(CROP_TOP * TILE_SCALE); // 214

// ---------------------------------------------------------------------------
// Physics ground
//
// We intentionally do NOT attach physics bodies to the scrolling tile sprites.
// setCrop + setScale in Phaser 3.90 corrupts the StaticBody offset formula
// inside refreshBody(), making the collision surface end up at the wrong Y.
//
// Instead we create ONE invisible static image that spans the full canvas width
// and sits exactly at SURFACE_Y.  The cat collides with that single body.
// Gaps will be handled here when jumping is introduced.
// ---------------------------------------------------------------------------
const GROUND_DEPTH = 9;   // just below tiles (depth 10) — still rendered last

// ---------------------------------------------------------------------------
// Scroll / generation constants
// ---------------------------------------------------------------------------
const SCROLL_SPEED = 150; // px / s — keep in sync with BackgroundManager

const GAP_CHANCE  = 0;    // no gaps until jumping is introduced
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
    this._tiles         = [];
    this._scrollOffset  = 0;

    const canvasW = scene.scale.width;
    while (this._getRightEdge() < canvasW + SPAWN_AHEAD) {
      this._spawnRun(this._getRightEdge(), false);
    }

    // ── Physics ground ─────────────────────────────────────────────────────
    // A single invisible StaticBody that covers the full canvas width at the
    // exact surface Y.  We create it using a 1×1 white pixel texture generated
    // at runtime so we don't need an extra asset.
    if (!scene.textures.exists("__ground_px")) {
      const gfx = scene.add.graphics();
      gfx.fillStyle(0xffffff, 1);
      gfx.fillRect(0, 0, 1, 1);
      gfx.generateTexture("__ground_px", 1, 1);
      gfx.destroy();
    }

    // origin(0,0): top-left anchor → body.y = sprite.y = SURFACE_Y exactly.
    // No display-origin arithmetic can disturb the position.
    this._ground = scene.physics.add.staticImage(0, SURFACE_Y, "__ground_px");
    this._ground.setOrigin(0, 0);
    this._ground.setDisplaySize(canvasW, 4); // 4 px tall so collisions aren't missed
    this._ground.setAlpha(0);
    this._ground.setDepth(GROUND_DEPTH);
    this._ground.body.setSize(canvasW, 4);
    this._ground.refreshBody();

    // Keep the physics group surface at the same Y even when tiles scroll.
    // We expose the staticImage via a single-item staticGroup so GameScene can
    // register the collider with a single group reference.
    this._group = scene.physics.add.staticGroup();
    this._group.add(this._ground);
  }

  /** The static physics group — attach player collider here. */
  get group() { return this._group; }

  /**
   * The world Y of the walkable brick surface.
   * CatPlayer uses this to spawn the cat just above the platform.
   */
  get surfaceY() { return SURFACE_Y; }

  /**
   * Call every frame from GameScene.update().
   * @param {number} delta  Phaser delta ms.
   */
  update(delta) {
    this._scrollOffset += SCROLL_SPEED * (delta / 1000);
    const px = Math.round(this._scrollOffset);

    // Scroll visual tiles only.
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
    
    // roof_middle needs a different crop offset to align visually with left/right.
    // All tiles are 256×128 texture; we crop the bottom 37 rows (brick/ground layer).
    // roof_middle's structure differs: its roof parapet starts 10 pixels lower in texture space.
    const cropY = (key === "roof_middle") ? (CROP_TOP + 10) : CROP_TOP;
    tile.setCrop(0, cropY, 256, CROP_H);
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
