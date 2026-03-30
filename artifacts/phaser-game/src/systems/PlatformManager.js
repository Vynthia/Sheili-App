import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Tile constants
// ---------------------------------------------------------------------------
const TILE_SCALE = 0.75;
const TILE_W     = Math.round(256 * TILE_SCALE); // 192 px — exact integer, no gaps
const TILE_H     = Math.round(128 * TILE_SCALE); //  96 px

// Y of the TOP edge of each tile (= the player's floor).
const PLATFORM_Y = 175;

// Physics collision body: thin strip at the very top of each tile.
const BODY_H = 10;

// ---------------------------------------------------------------------------
// Scroll speed — keep in sync with AUTO_SCROLL_PX_PER_SEC in BackgroundManager.
// ---------------------------------------------------------------------------
const SCROLL_SPEED = 150; // px / s

// ---------------------------------------------------------------------------
// Generation parameters
// ---------------------------------------------------------------------------
// Probability that a gap is inserted between two consecutive runs.
const GAP_CHANCE = 0.25;

const GAP_MIN = 60;  // px — always integer-rounded before use
const GAP_MAX = 140;

const MID_MIN = 1; // minimum middle tiles per run
const MID_MAX = 4; // maximum middle tiles per run

// Pre-spawn this many px ahead of the right canvas edge.
const SPAWN_AHEAD = 450;

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
      const edge    = this._getRightEdge();
      const addGap  = Math.random() < GAP_CHANCE;

      if (addGap) {
        // Integer gap width so the landing tile lands on a whole pixel.
        const gapW = Math.round(GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN));
        this._spawnRun(edge + gapW, true);   // landing tile first
      } else {
        this._spawnRun(edge, false);          // seamless continuation
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Spawn one platform run starting at `screenStartX`.
   *
   * If `withLanding` is true, a roof_landing tile is placed first (always
   * immediately after a gap), followed by a normal left→mid…→right run.
   *
   * All x positions are rounded to whole pixels so tiles butt up seamlessly.
   */
  _spawnRun(screenStartX, withLanding) {
    const px  = Math.round(this._scrollOffset);
    let   sx  = Math.round(screenStartX); // ← integer snap, eliminates all gaps

    if (withLanding) {
      this._addTile("roof_landing", sx, px);
      sx += TILE_W;
    }

    const midCount = MID_MIN + Math.floor(Math.random() * (MID_MAX - MID_MIN + 1));
    this._addTile("roof_left", sx, px);   sx += TILE_W;
    for (let i = 0; i < midCount; i++) {
      this._addTile("roof_middle", sx, px); sx += TILE_W;
    }
    this._addTile("roof_right", sx, px);  sx += TILE_W;
  }

  /**
   * Create one physics-enabled tile, configure its body to the top surface
   * strip only, and track its immutable world X for per-frame repositioning.
   */
  _addTile(key, screenX, px) {
    const tile = this._group.create(screenX, PLATFORM_Y, key);
    tile.setOrigin(0, 0);
    tile.setScale(TILE_SCALE);
    tile.setDepth(10);

    // Body covers only the top BODY_H pixels — collision is fair and sharp.
    tile.body.setSize(TILE_W, BODY_H, false);
    tile.body.setOffset(0, 0);
    tile.refreshBody();

    // _worldX is an integer (screenX rounded + integer px), so tile.x is
    // always exactly an integer — no fractional rendering, no 1-px gaps.
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
