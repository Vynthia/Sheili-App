import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Tile display constants
// ---------------------------------------------------------------------------
const TILE_SCALE  = 0.5;
const TILE_W      = Math.round(256 * TILE_SCALE); // 128 px in world space
const TILE_H      = Math.round(128 * TILE_SCALE); //  64 px in world space

// ---------------------------------------------------------------------------
// Platform surface
// ---------------------------------------------------------------------------
// Y coordinate of the TOP edge of every platform tile.
// This is the floor the player runs on.
const PLATFORM_Y = 190;

// Height of the collision body strip at the tile top, in world px.
// Thin enough to feel sharp, generous enough to land fairly.
const BODY_H = 10;

// ---------------------------------------------------------------------------
// Scroll speed — must match AUTO_SCROLL_PX_PER_SEC in BackgroundManager so
// the platforms feel anchored in the world.
// ---------------------------------------------------------------------------
const SCROLL_SPEED = 150; // px / s

// ---------------------------------------------------------------------------
// Segment generation parameters
// ---------------------------------------------------------------------------
const MID_MIN = 0; // minimum number of middle tiles per segment
const MID_MAX = 3; // maximum number of middle tiles per segment

// Gap between consecutive segments (px).
const GAP_MIN = 55;
const GAP_MAX = 140;

// Spawn new segments when the rightmost edge is within this many px of the
// right side of the canvas.
const SPAWN_AHEAD = 400;

// ---------------------------------------------------------------------------

export class PlatformManager {
  /**
   * @param {Phaser.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;

    // Static physics group — add collider / overlap against this in GameScene.
    this._group = scene.physics.add.staticGroup();

    // Array of segment descriptors:
    //   { tiles: Phaser.GameObjects.Image[], width: number }
    // Ordered left-to-right; oldest (leftmost) segment is at index 0.
    this._segments = [];

    // Accumulated float scroll offset for sub-pixel precision (same technique
    // used in BackgroundManager).
    this._scrollOffset = 0;

    // Seed the screen: spawn segments until we cover the canvas + SPAWN_AHEAD.
    const canvasW = scene.scale.width;
    let nextX = 0;
    while (nextX < canvasW + SPAWN_AHEAD) {
      nextX = this._spawnSegment(nextX);
      nextX += this._randomGap();
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** The static physics group. Attach player collider to this. */
  get group() {
    return this._group;
  }

  /**
   * Call every frame from GameScene.update().
   * @param {number} delta  Phaser delta time in ms.
   */
  update(delta) {
    this._scrollOffset += SCROLL_SPEED * (delta / 1000);
    const px = Math.round(this._scrollOffset);

    // Move every tile to its snapped integer position and sync the body.
    for (const seg of this._segments) {
      for (const tile of seg.tiles) {
        tile.x = tile._baseX - px;
        tile.refreshBody();
      }
    }

    // Recycle segments whose last tile has left the screen.
    while (this._segments.length > 0) {
      const seg  = this._segments[0];
      const last = seg.tiles[seg.tiles.length - 1];
      if (last.x + TILE_W < 0) {
        seg.tiles.forEach(t => t.destroy());
        this._segments.shift();
      } else {
        break;
      }
    }

    // Spawn ahead.
    const canvasW   = this.scene.scale.width;
    let rightEdge = this._getRightEdge();
    while (rightEdge < canvasW + SPAWN_AHEAD) {
      rightEdge = this._spawnSegment(rightEdge + this._randomGap());
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Spawn one segment starting at world X position `startX`.
   * Returns the world X of the right edge of the new segment.
   */
  _spawnSegment(startX) {
    const midCount = MID_MIN + Math.floor(Math.random() * (MID_MAX - MID_MIN + 1));
    const tiles    = [];
    const px       = Math.round(this._scrollOffset); // current scroll in whole px

    let wx = startX; // walking x in world coordinates

    // Left cap
    tiles.push(this._makeTile("roof_left", wx, px));
    wx += TILE_W;

    // Middle tiles (0 – MID_MAX)
    for (let i = 0; i < midCount; i++) {
      tiles.push(this._makeTile("roof_middle", wx, px));
      wx += TILE_W;
    }

    // Right cap
    tiles.push(this._makeTile("roof_right", wx, px));
    wx += TILE_W;

    this._segments.push({ tiles });
    return wx; // right edge of the new segment
  }

  /**
   * Create one platform tile, add it to the static physics group, and
   * configure its collision body to cover only the top surface strip.
   *
   * @param {string} key      Texture key
   * @param {number} worldX   Left edge in world X (before scroll offset)
   * @param {number} scrollPx Current integer scroll offset
   */
  _makeTile(key, worldX, scrollPx) {
    const screenX = worldX - scrollPx;

    const tile = this._group.create(screenX, PLATFORM_Y, key);
    tile.setOrigin(0, 0);
    tile.setScale(TILE_SCALE);

    // Render in front of all background layers (depths 0 – 5).
    tile.setDepth(10);

    // Restrict the physics body to the very top of the tile only.
    // setSize(w, h, center=false) — sizes are in WORLD px (post-scale).
    tile.body.setSize(TILE_W, BODY_H, false);
    tile.body.setOffset(0, 0);
    tile.refreshBody();

    // Store the world X so update() can compute screen position each frame.
    tile._baseX = worldX;

    return tile;
  }

  /**
   * World X of the right edge of the rightmost tile currently alive.
   * Returns 0 when no segments exist.
   */
  _getRightEdge() {
    if (this._segments.length === 0) return 0;
    const last     = this._segments[this._segments.length - 1];
    const lastTile = last.tiles[last.tiles.length - 1];
    return lastTile._baseX + TILE_W;
  }

  _randomGap() {
    return GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);
  }
}
