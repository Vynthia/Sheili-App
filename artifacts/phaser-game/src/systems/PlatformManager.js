import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Tile constants
// ---------------------------------------------------------------------------
const TILE_SCALE = 1.25;
const TILE_W     = Math.round(256 * TILE_SCALE); // 320 px
const TILE_H     = Math.round(128 * TILE_SCALE); // 160 px

// ---------------------------------------------------------------------------
// Ridge alignment
//
// Each tile is a largely-transparent PNG.  The only opaque content is:
//   • A single "ridge" row (the decorative cap at the top of the wall)
//   • A thin base section at the very bottom of the texture
//   • The middle is fully transparent — the background shows through.
//
// First fully-opaque ridge row per tile type (measured from pixel analysis):
//   roof_right   → row 84
//   roof_left    → row 87
//   roof_landing → row 87  (same as left)
//   roof_middle  → row 92
//
// SURFACE_Y is the world Y where ALL ridge rows should appear.
// Each tile is placed at:
//   tile.y = SURFACE_Y - round(RIDGE_ROW[key] × TILE_SCALE)
//
// This ensures all ridges land at exactly SURFACE_Y regardless of their
// internal texture offset, giving a perfectly seamless platform top edge.
// ---------------------------------------------------------------------------
const RIDGE_ROW = {
  roof_right:   84,
  roof_left:    87,
  roof_landing: 87,
  roof_middle:  92,
};

// World Y where the cat's feet land and the ridge line appears.
const SURFACE_Y = 207;

// ---------------------------------------------------------------------------
// Physics ground
//
// One invisible static body at SURFACE_Y spanning the full canvas width.
// Visual tiles have NO physics bodies (setCrop + setScale in Phaser 3.90
// corrupts StaticBody.refreshBody() offsets, causing fall-through bugs).
// ---------------------------------------------------------------------------
const GROUND_DEPTH = 9;

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
    this._tiles        = [];
    this._scrollOffset = 0;

    const canvasW = scene.scale.width;
    while (this._getRightEdge() < canvasW + SPAWN_AHEAD) {
      this._spawnRun(this._getRightEdge(), false);
    }

    // ── Physics ground ─────────────────────────────────────────────────────
    if (!scene.textures.exists("__ground_px")) {
      const gfx = scene.add.graphics();
      gfx.fillStyle(0xffffff, 1);
      gfx.fillRect(0, 0, 1, 1);
      gfx.generateTexture("__ground_px", 1, 1);
      gfx.destroy();
    }

    // origin(0,0) → body.y == sprite.y == SURFACE_Y exactly (no display-origin offset).
    this._ground = scene.physics.add.staticImage(0, SURFACE_Y, "__ground_px");
    this._ground.setOrigin(0, 0);
    this._ground.setDisplaySize(canvasW, 4);
    this._ground.setAlpha(0);
    this._ground.setDepth(GROUND_DEPTH);
    this._ground.body.setSize(canvasW, 4);
    this._ground.refreshBody();

    this._group = scene.physics.add.staticGroup();
    this._group.add(this._ground);
  }

  /** The static physics group — register player collider against this. */
  get group() { return this._group; }

  /** World Y of the walkable surface (ridge line). */
  get surfaceY() { return SURFACE_Y; }

  /** Call every frame from GameScene.update(). */
  update(delta) {
    this._scrollOffset += SCROLL_SPEED * (delta / 1000);
    const px = Math.round(this._scrollOffset);

    for (const tile of this._tiles) {
      tile.x = tile._worldX - px;
    }

    // Recycle off-screen tiles.
    while (this._tiles.length > 0 && this._tiles[0].x + TILE_W < 0) {
      this._tiles.shift().destroy();
    }

    // Spawn ahead.
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
    // Position tile so its ridge row lands exactly at SURFACE_Y.
    // No setCrop — the middle is transparent and shows the background through.
    const ridgeRow = RIDGE_ROW[key] ?? 87;
    const tileY    = SURFACE_Y - Math.round(ridgeRow * TILE_SCALE);

    const tile = this.scene.add.image(screenX, tileY, key);
    tile.setOrigin(0, 0);
    tile.setScale(TILE_SCALE);
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
