import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Tile display constants
// ---------------------------------------------------------------------------
const TILE_SCALE = 1.75;
const TILE_W     = Math.round(256 * TILE_SCALE); // 192 px world-space
const TILE_H     = Math.round(128 * TILE_SCALE); //  96 px world-space

// ---------------------------------------------------------------------------
// Platform surface
// Y coordinate of the TOP edge of each tile — the floor the player runs on.
// ---------------------------------------------------------------------------
const PLATFORM_Y = 50;

// Height of the physics collision body (top strip only), in world px.
const BODY_H = 10;

// ---------------------------------------------------------------------------
// Scroll speed — must match AUTO_SCROLL_PX_PER_SEC in BackgroundManager.
// ---------------------------------------------------------------------------
const SCROLL_SPEED = 150; // px / s

// ---------------------------------------------------------------------------
// Segment generation
// ---------------------------------------------------------------------------
const MID_MIN = 0; // minimum middle tiles per segment
const MID_MAX = 3; // maximum middle tiles per segment

const GAP_MIN = 55;  // px between consecutive segments
const GAP_MAX = 140;

// Spawn new segments when the screen-space right edge is closer than this
// many px to the right side of the canvas.
const SPAWN_AHEAD = 400;

// ---------------------------------------------------------------------------

export class PlatformManager {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this.scene = scene;

    // Static physics group — attach player collider to this in GameScene.
    this._group = scene.physics.add.staticGroup();

    // Ordered list of live segments (oldest = index 0 = leftmost).
    this._segments = [];

    // Accumulated scroll in float px — kept as a float to preserve sub-pixel
    // precision; integer part is applied to tile positions each frame.
    this._scrollOffset = 0;

    // Seed the screen at scroll = 0 (screen coords == world coords at t=0).
    const canvasW = scene.scale.width;
    let nextScreenX = 0;
    while (nextScreenX < canvasW + SPAWN_AHEAD) {
      nextScreenX = this._spawnSegment(nextScreenX);
      nextScreenX += this._randomGap();
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

    // Move every tile to its integer screen position and sync its body.
    for (const seg of this._segments) {
      for (const tile of seg.tiles) {
        tile.x = tile._worldX - px;
        tile.refreshBody();
      }
    }

    // Recycle segments whose last tile has left the left edge of the screen.
    while (this._segments.length > 0) {
      const seg      = this._segments[0];
      const lastTile = seg.tiles[seg.tiles.length - 1];
      if (lastTile.x + TILE_W < 0) {
        seg.tiles.forEach(t => t.destroy());
        this._segments.shift();
      } else {
        break;
      }
    }

    // Spawn ahead: all comparisons in SCREEN space via _getRightEdge().
    const canvasW = this.scene.scale.width;
    while (this._getRightEdge() < canvasW + SPAWN_AHEAD) {
      const nextX = this._getRightEdge() + this._randomGap();
      this._spawnSegment(nextX);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Spawn one segment whose left tile starts at screen-X `screenStartX`.
   * Returns the screen-X of the right edge of the new segment.
   *
   * _worldX for each tile = screenStartX + current integer scroll offset,
   * so that on subsequent frames: tile.x = _worldX - newPx = correct position.
   */
  _spawnSegment(screenStartX) {
    const midCount = MID_MIN + Math.floor(Math.random() * (MID_MAX - MID_MIN + 1));
    const px       = Math.round(this._scrollOffset);
    const tiles    = [];
    let   sx       = screenStartX;

    tiles.push(this._makeTile("roof_left", sx, px));   sx += TILE_W;
    for (let i = 0; i < midCount; i++) {
      tiles.push(this._makeTile("roof_middle", sx, px)); sx += TILE_W;
    }
    tiles.push(this._makeTile("roof_right", sx, px));  sx += TILE_W;

    this._segments.push({ tiles });
    return sx; // screen-space right edge at this moment
  }

  /**
   * Create one tile in the static physics group, configure its body, and
   * record its world X so it can be repositioned every frame.
   */
  _makeTile(key, screenX, px) {
    const tile = this._group.create(screenX, PLATFORM_Y, key);
    tile.setOrigin(0, 0);
    tile.setScale(TILE_SCALE);
    tile.setDepth(10);

    // Restrict collision to the top surface strip only.
    tile.body.setSize(TILE_W, BODY_H, false);
    tile.body.setOffset(0, 0);
    tile.refreshBody();

    // World X is fixed for the lifetime of this tile.
    // Each frame: tile.x = _worldX - Math.round(scrollOffset)
    tile._worldX = screenX + px;

    return tile;
  }

  /**
   * Current screen-X of the right edge of the rightmost live tile.
   * Returns 0 when no segments exist.
   */
  _getRightEdge() {
    if (this._segments.length === 0) return 0;
    const last     = this._segments[this._segments.length - 1];
    const lastTile = last.tiles[last.tiles.length - 1];
    return lastTile.x + TILE_W; // tile.x is always the current screen position
  }

  _randomGap() {
    return GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);
  }
}
