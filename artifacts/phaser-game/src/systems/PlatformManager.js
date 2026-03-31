import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Tile visual constants
// ---------------------------------------------------------------------------
const TILE_SCALE = 2.00;
const TILE_W     = Math.round(256 * TILE_SCALE); // 512 px per tile
const TILE_H     = Math.round(128 * TILE_SCALE); // 256 px

// Crop (texture-space pixels) — show only the brick rows, same for all tiles.
const CROP_TOP = 91;
const CROP_H   = 128 - CROP_TOP; // 37 rows

// ---------------------------------------------------------------------------
// Platform layout
//
// PLATFORM_Y : sprite origin Y (top-left, origin 0,0) of each tile.
// SURFACE_Y  : world Y of the walkable surface (where cat feet land).
//              = PLATFORM_Y + CROP_TOP × TILE_SCALE  (rounded)
//
// Tile bottom = 13 + 256 = 269 ≈ canvas height (270 px).
// SURFACE_Y   = 13 + round(91 × 2) = 195.
// ---------------------------------------------------------------------------
const PLATFORM_Y = 13;
const SURFACE_Y  = PLATFORM_Y + Math.round(CROP_TOP * TILE_SCALE); // 195

// ---------------------------------------------------------------------------
// Physics note
//
// Each platform SEGMENT gets its own invisible 1×1-px StaticImage whose body
// is sized to the segment's full width.  Every frame body.reset(screenX, y)
// repositions it in the broadphase tree to follow the scroll.
//
// We do NOT attach bodies to the visual tile sprites — setCrop+setScale in
// Phaser 3.90 corrupts refreshBody(), so visuals and physics are kept separate.
// ---------------------------------------------------------------------------
const GROUND_DEPTH = 9; // drawn just below visual tiles (depth 10)

// ---------------------------------------------------------------------------
// Scroll / generation constants
//
// Gap safety check:
//   JUMP_VEL = 310, GRAVITY_Y = 900  →  air time = 2×310/900 ≈ 0.689 s
//   World scroll during jump = SCROLL_SPEED × 0.689 = 150 × 0.689 ≈ 103 px
//   GAP_MAX = 80 px  →  landing margin ≈ 23 px  (always jumpable)
// ---------------------------------------------------------------------------
const SCROLL_SPEED = 150; // px / s — keep in sync with BackgroundManager
const SPAWN_AHEAD  = 900; // px ahead of right canvas edge to keep spawned

const MID_MIN = 0; // minimum middle tiles per segment (0 = left+right only)
const MID_MAX = 2; // maximum middle tiles per segment

const GAP_CHANCE = 0.40; // probability of a gap before each new segment
const GAP_MIN    = 50;   // minimum gap width (world px)
const GAP_MAX    = 80;   // maximum gap width — safe ceiling is 103 px

// No gaps for the first N segments: gives the player time to settle in.
const INITIAL_SAFE_SEGMENTS = 2;

// ---------------------------------------------------------------------------

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------

export class PlatformManager {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this.scene = scene;

    // World-space x cursor: where the NEXT segment (after any gap) will start.
    this._nextWorldX     = 0;
    this._scrollOffset   = 0;
    this._segmentsSpawned = 0;

    // Live segment records:
    //   { worldX, width, ground: staticImage, tiles: [{sprite, localX}, ...] }
    this._segments = [];

    // Shared 1×1 white texture for invisible ground bodies.
    if (!scene.textures.exists("__ground_px")) {
      const gfx = scene.add.graphics();
      gfx.fillStyle(0xffffff, 1);
      gfx.fillRect(0, 0, 1, 1);
      gfx.generateTexture("__ground_px", 1, 1);
      gfx.destroy();
    }

    // Single static group — CatPlayer registers one collider against this.
    this._group = scene.physics.add.staticGroup();

    // Seed enough segments to fill canvas + buffer before first frame.
    const canvasW = scene.scale.width;
    while (this._getRightWorldEdge() < canvasW + SPAWN_AHEAD) {
      this._spawnNextSegment();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** The static physics group — pass to CatPlayer for the collider. */
  get group() { return this._group; }

  /**
   * World Y of the walkable brick surface.
   * CatPlayer uses this to position the cat at spawn.
   */
  get surfaceY() { return SURFACE_Y; }

  /** Call every frame from GameScene.update(). */
  update(delta) {
    this._scrollOffset += SCROLL_SPEED * (delta / 1000);
    const scrollPx = Math.round(this._scrollOffset);
    const canvasW  = this.scene.scale.width;

    // ── Move segment bodies and tiles with the scroll ──────────────────────
    for (const seg of this._segments) {
      const screenX = seg.worldX - scrollPx;

      // Reposition physics body in the broadphase tree each frame.
      seg.ground.x = screenX;
      seg.ground.body.reset(screenX, SURFACE_Y);

      // Reposition visual tiles.
      for (const t of seg.tiles) {
        t.sprite.x = screenX + t.localX;
      }
    }

    // ── Recycle segments scrolled fully off the left edge ──────────────────
    while (this._segments.length > 0) {
      const seg = this._segments[0];
      if (seg.worldX - scrollPx + seg.width < 0) {
        this._destroySegment(seg);
        this._segments.shift();
      } else {
        break;
      }
    }

    // ── Spawn new segments ahead of the right canvas edge ─────────────────
    while (this._getRightWorldEdge() < scrollPx + canvasW + SPAWN_AHEAD) {
      this._spawnNextSegment();
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _spawnNextSegment() {
    const scrollPx = Math.round(this._scrollOffset);
    const isSafe   = this._segmentsSpawned < INITIAL_SAFE_SEGMENTS;

    // ── Gap before this segment? ───────────────────────────────────────────
    let withLanding = false;
    if (!isSafe && Math.random() < GAP_CHANCE) {
      const gapW = randInt(GAP_MIN, GAP_MAX);
      this._nextWorldX += gapW; // advance cursor past the gap
      withLanding = true;       // the segment opens with a landing tile
    }

    // ── Decide tile sequence ───────────────────────────────────────────────
    const tileKeys = [];
    if (withLanding) tileKeys.push("roof_landing");
    tileKeys.push("roof_left");
    for (let i = 0, n = randInt(MID_MIN, MID_MAX); i < n; i++) {
      tileKeys.push("roof_middle");
    }
    tileKeys.push("roof_right");

    const segWorldX = this._nextWorldX;
    const segWidth  = tileKeys.length * TILE_W;

    // ── Create visual tiles ────────────────────────────────────────────────
    const tiles = [];
    let localX = 0;
    for (const key of tileKeys) {
      const sprite = this.scene.add.image(
        segWorldX - scrollPx + localX, PLATFORM_Y, key
      );
      sprite.setOrigin(0, 0);
      sprite.setScale(TILE_SCALE);
      sprite.setCrop(0, CROP_TOP, 256, CROP_H);
      sprite.setDepth(10);
      tiles.push({ sprite, localX });
      localX += TILE_W;
    }

    // ── Create invisible physics body for this segment ─────────────────────
    // Origin (0,0) → displayOriginX/Y = 0, so body.reset(x,y) = sprite.x/y.
    // We pin explicitly with body.reset() after group.add() in case the group
    // createCallback overwrites the position.
    const screenX = segWorldX - scrollPx;
    const ground  = this.scene.physics.add.staticImage(
      screenX, SURFACE_Y, "__ground_px"
    );
    ground.setOrigin(0, 0);
    ground.setAlpha(0);
    ground.setDepth(GROUND_DEPTH);
    ground.body.setSize(segWidth, 8); // 8 px tall — tolerant of 1-frame timing gaps
    this._group.add(ground);          // createCallback resets position to sprite.x/y ✓
    ground.body.reset(screenX, SURFACE_Y); // re-pin after createCallback

    // ── Register segment ───────────────────────────────────────────────────
    this._segments.push({ worldX: segWorldX, width: segWidth, ground, tiles });
    this._nextWorldX += segWidth;
    this._segmentsSpawned++;
  }

  _destroySegment(seg) {
    for (const t of seg.tiles) t.sprite.destroy();
    // group.remove(child, removeFromScene, destroyChild) — cleans everything.
    this._group.remove(seg.ground, true, true);
  }

  _getRightWorldEdge() {
    if (this._segments.length === 0) return 0;
    const last = this._segments[this._segments.length - 1];
    return last.worldX + last.width;
  }
}
