import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Tile display constants
// ---------------------------------------------------------------------------
const TILE_SCALE = 0.75;
const TILE_W     = Math.round(256 * TILE_SCALE); // 192 px — exact integer
const TILE_H     = Math.round(128 * TILE_SCALE); //  96 px

// ---------------------------------------------------------------------------
// Uniform crop — forces every tile type to show EXACTLY the same texture rows.
//
// Raw pixel measurements (Paeth-reconstructed) show content begins at:
//   roof_right   row 84  |  roof_left / roof_landing  row 86
//   roof_middle  row 91  ← latest start, sets the common crop top
//   All tiles end at row 127 (canvas clips the rest).
//
// Cropping from row 91 downward means:
//  • roof_middle shows its full content (rows 91-127)
//  • roof_right / left / landing lose their top 5-7 rows (imperceptibly thin)
//  • Every tile is IDENTICAL in visible height (37 rows → ~28 px rendered)
//  • The brick surface lands at exactly TARGET_SURFACE_Y for all tiles
// ---------------------------------------------------------------------------
const CROP_TOP  = 91;             // first texture row to show
const CROP_H    = 128 - CROP_TOP; // = 37 rows (texture space)

// In display space (TILE_SCALE 0.75), the crop sits this many px below sprite origin.
const BODY_OFFSET_Y = Math.round(CROP_TOP * TILE_SCALE); // 68 px

// The screen Y where the brick surface appears — every tile aligned to this line.
// Set so the tile bottom (PLATFORM_Y + TILE_H = 176+96 = 272) extends just
// past the 270 px canvas edge, leaving no visible gap below the platform.
const TARGET_SURFACE_Y = 244;
const PLATFORM_Y       = TARGET_SURFACE_Y - BODY_OFFSET_Y; // 176 — same for all

// Physics strip: thin bar at the very top of the visible brick.
const BODY_H = 10;

// ---------------------------------------------------------------------------
// Scroll / generation constants
// ---------------------------------------------------------------------------
const SCROLL_SPEED = 150; // px / s — keep in sync with BackgroundManager

const GAP_CHANCE  = 0.25;
const GAP_MIN     = 60;
const GAP_MAX     = 140;
const MID_MIN     = 1;
const MID_MAX     = 4;
const SPAWN_AHEAD = 450;

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

    // Crop the texture so every tile shows exactly the same rows —
    // this is what makes them look identical in height regardless of
    // how much content each source PNG has above row CROP_TOP.
    tile.setCrop(0, CROP_TOP, 256, CROP_H);

    // +2 px display width closes any sub-pixel crack at 0.75× canvas scale.
    tile.setDisplaySize(TILE_W + 2, TILE_H);
    tile.setDepth(10);

    // Physics body sits at the crop boundary = top of visible brick.
    tile.body.setSize(TILE_W, BODY_H, false);
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
