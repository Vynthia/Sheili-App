import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Tile constants
// ---------------------------------------------------------------------------
const TILE_SCALE = 0.75;
const TILE_W     = Math.round(256 * TILE_SCALE); // 192 px — exact integer, no gaps
const TILE_H     = Math.round(128 * TILE_SCALE); //  96 px

// ---------------------------------------------------------------------------
// Per-tile calibration — the pixel row (in the 128-tall source texture) where
// the actual brick surface begins.  Measured from the raw PNG pixel data:
//   roof_left    firstRow=86   roof_right   firstRow=88
//   roof_middle  firstRow=89   roof_landing firstRow=93
//
// Each tile's sprite Y is calculated so that its brick surface lands exactly
// at TARGET_SURFACE_Y, making every tile appear at the same visual height.
// ---------------------------------------------------------------------------
const TARGET_SURFACE_Y = 240; // screen Y where the brick floor appears

const TILE_SURFACE_ROW = {
  roof_left:    86,
  roof_middle:  86,
  roof_right:   86,
  roof_landing: 85,
};

// Physics collision body: thin strip right at the brick surface.
const BODY_H = 10;

// ---------------------------------------------------------------------------
// Scroll speed — keep in sync with BackgroundManager.
// ---------------------------------------------------------------------------
const SCROLL_SPEED = 150; // px / s

// ---------------------------------------------------------------------------
// Generation parameters
// ---------------------------------------------------------------------------
const GAP_CHANCE = 0.25;   // probability of a gap between runs
const GAP_MIN    = 60;     // min gap width in px (always integer-rounded)
const GAP_MAX    = 140;    // max gap width in px
const MID_MIN    = 1;      // minimum middle tiles per run
const MID_MAX    = 4;      // maximum middle tiles per run
const SPAWN_AHEAD = 450;   // px ahead of right canvas edge to keep filled

// ---------------------------------------------------------------------------

export class PlatformManager {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this.scene = scene;

    // Static physics group — attach player collider to this in GameScene.
    this._group = scene.physics.add.staticGroup();

    // Flat ordered list of live tile objects (leftmost at index 0).
    this._tiles = [];

    // Float accumulator for sub-pixel scroll precision.
    this._scrollOffset = 0;

    // Seed with seamless runs (no gaps) until the canvas + lookahead is filled.
    const canvasW = scene.scale.width;
    while (this._getRightEdge() < canvasW + SPAWN_AHEAD) {
      this._spawnRun(this._getRightEdge(), false);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** The static physics group. Attach player collider to this. */
  get group() { return this._group; }

  /**
   * Call every frame from GameScene.update().
   * @param {number} delta  Phaser delta time in ms.
   */
  update(delta) {
    this._scrollOffset += SCROLL_SPEED * (delta / 1000);
    const px = Math.round(this._scrollOffset);

    // Reposition every tile using integer screen coords derived from the float
    // accumulator — prevents sub-pixel stutter under roundPixels mode.
    for (const tile of this._tiles) {
      tile.x = tile._worldX - px;
      tile.refreshBody();
    }

    // Recycle tiles that have fully scrolled off the left edge.
    while (this._tiles.length > 0 && this._tiles[0].x + TILE_W < 0) {
      this._tiles.shift().destroy();
    }

    // Spawn new runs ahead as needed.
    const canvasW = this.scene.scale.width;
    while (this._getRightEdge() < canvasW + SPAWN_AHEAD) {
      const edge   = this._getRightEdge();
      const addGap = Math.random() < GAP_CHANCE;

      if (addGap) {
        const gapW = Math.round(GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN));
        this._spawnRun(edge + gapW, true);   // landing tile first, then run
      } else {
        this._spawnRun(edge, false);          // seamless continuation
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Spawn one platform run starting at `screenStartX`.
   * withLanding=true prepends a roof_landing tile (always right after a gap).
   * All x positions are rounded to whole pixels — no sub-pixel gaps possible.
   */
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

  /**
   * Create one physics-enabled tile.
   *
   * The sprite Y is calculated per-tile-type so that every tile's brick
   * surface lands exactly at TARGET_SURFACE_Y, regardless of how much
   * transparent space sits above the art in each source PNG.
   * The physics body is offset to match that same Y so collision is accurate.
   */
  _addTile(key, screenX, px) {
    // Determine sprite Y so this tile's brick top aligns with TARGET_SURFACE_Y.
    const surfaceRow  = TILE_SURFACE_ROW[key] ?? 86;
    const bodyOffsetY = Math.round(surfaceRow * TILE_SCALE); // px from sprite top
    const spriteY     = TARGET_SURFACE_Y - bodyOffsetY;

    const tile = this._group.create(screenX, spriteY, key);
    tile.setOrigin(0, 0);

    // +2 px display width seals any sub-pixel crack the canvas rasterizer
    // might leave at a 0.75× scale boundary.
    tile.setDisplaySize(TILE_W + 2, TILE_H);
    tile.setDepth(10);

    // Collision body sits exactly at the visible brick surface.
    tile.body.setSize(TILE_W, BODY_H, false);
    tile.body.setOffset(0, bodyOffsetY);
    tile.refreshBody();

    // _worldX is always an integer → tile.x is always an integer → no gaps.
    tile._worldX = screenX + px;

    this._tiles.push(tile);
    return tile;
  }

  /**
   * Screen-space X of the right edge of the rightmost live tile.
   * Returns 0 when no tiles exist.
   */
  _getRightEdge() {
    if (this._tiles.length === 0) return 0;
    const last = this._tiles[this._tiles.length - 1];
    return last.x + TILE_W;
  }
}
