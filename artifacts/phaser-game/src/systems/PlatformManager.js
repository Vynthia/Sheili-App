import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Tile display constants
// ---------------------------------------------------------------------------
// Increase TILE_SCALE from 0.75 → 1.25 so the tiles are larger on screen.
// We deliberately avoid setDisplaySize() because it can confuse StaticBody
// position calculations; setScale() is the safe alternative.
const TILE_SCALE = 1.25;
const TILE_W     = Math.round(256 * TILE_SCALE); // 320 px
const TILE_H     = Math.round(128 * TILE_SCALE); // 160 px

// ---------------------------------------------------------------------------
// Uniform crop — forces every tile type to show EXACTLY the same texture rows.
// (See previous comments for the pixel-measurement rationale.)
// ---------------------------------------------------------------------------
const CROP_TOP  = 91;
const CROP_H    = 128 - CROP_TOP; // 37 texture-space rows

// The crop boundary, expressed in display pixels.
// This is how far below the sprite origin the walkable surface sits.
const BODY_OFFSET_Y = Math.round(CROP_TOP * TILE_SCALE); // 114 px

// Platform surface Y in screen space — where the cat's feet land.
// PLATFORM_Y + BODY_OFFSET_Y = TARGET_SURFACE_Y (invariant).
// Tile bottom = PLATFORM_Y + TILE_H = 96 + 160 = 256.
// We intentionally keep the tile bottom well below 270 so the brick fills the
// lower quarter of the canvas, making the platform clearly visible.
const TARGET_SURFACE_Y = 210;
const PLATFORM_Y       = TARGET_SURFACE_Y - BODY_OFFSET_Y; // 96

// Physics strip: thin collision bar at the very top of the visible brick.
const BODY_H = 12;

// ---------------------------------------------------------------------------
// Scroll / generation constants
// ---------------------------------------------------------------------------
const SCROLL_SPEED = 150; // px / s — keep in sync with BackgroundManager

const GAP_CHANCE  = 0.25;
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

    this._group = scene.physics.add.staticGroup();
    this._tiles = [];
    this._scrollOffset = 0;

    const canvasW = scene.scale.width;
    while (this._getRightEdge() < canvasW + SPAWN_AHEAD) {
      this._spawnRun(this._getRightEdge(), false);
    }
  }

  /** The static physics group — attach player collider here. */
  get group() { return this._group; }

  /**
   * The world Y where the walkable brick surface sits.
   * CatPlayer uses this to spawn the cat above the platform.
   */
  get surfaceY() { return TARGET_SURFACE_Y; }

  /**
   * Call every frame from GameScene.update().
   * @param {number} delta  Phaser delta ms.
   */
  update(delta) {
    this._scrollOffset += SCROLL_SPEED * (delta / 1000);
    const px = Math.round(this._scrollOffset);

    for (const tile of this._tiles) {
      tile.x = tile._worldX - px;
      tile.refreshBody();
    }

    // Recycle tiles scrolled off left.
    while (this._tiles.length > 0 && this._tiles[0].x + TILE_W < 0) {
      this._tiles.shift().destroy();
    }

    // Spawn new content ahead.
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
    const tile = this._group.create(screenX, PLATFORM_Y, key);
    tile.setOrigin(0, 0);

    // Use setScale() — NOT setDisplaySize() — to avoid mismatches between
    // the sprite transform and the StaticBody position recalculation inside
    // refreshBody(), which uses displayOriginX/Y derived from displayWidth/H.
    tile.setScale(TILE_SCALE);
    tile.setDepth(10);

    // Crop so every tile shows exactly the same texture rows.
    tile.setCrop(0, CROP_TOP, 256, CROP_H);

    // Physics body: a narrow strip along the top of the visible brick.
    // With origin (0,0) and setScale(), refreshBody() computes:
    //   body.x = tile.x  (displayOriginX = 0)
    //   body.y = tile.y + offset.y
    // So body top = PLATFORM_Y + BODY_OFFSET_Y = TARGET_SURFACE_Y ✓
    tile.body.setSize(TILE_W, BODY_H);
    tile.body.setOffset(0, BODY_OFFSET_Y);
    tile.refreshBody();

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
