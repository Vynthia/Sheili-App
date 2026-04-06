import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Tile visual constants
// ---------------------------------------------------------------------------
const TILE_SCALE = 2.00;
const TILE_W     = Math.round(256 * TILE_SCALE); // 512 px per tile

// Crop (texture-space pixels) — show only the brick rows, same for all tiles.
const CROP_TOP = 91;
const CROP_H   = 128 - CROP_TOP; // 37 rows

// ---------------------------------------------------------------------------
// Platform layout
//
// PLATFORM_Y : sprite origin Y (top-left, origin 0,0) of each tile.
// SURFACE_Y  : world Y of the walkable surface (where cat feet land).
//              = PLATFORM_Y + CROP_TOP × TILE_SCALE  (rounded)
// ---------------------------------------------------------------------------
const PLATFORM_Y = 13;
const SURFACE_Y  = PLATFORM_Y + Math.round(CROP_TOP * TILE_SCALE); // 195

// ---------------------------------------------------------------------------
// Physics design
//
// Moving Phaser StaticBodies every frame corrupts the static broadphase tree,
// causing the cat to fall through visually correct platforms.
//
// Solution: ONE permanently-placed static floor body, fixed at the cat's
// pinned screen X (CAT_SCREEN_X). Each frame we simply ENABLE it when the
// cat's world-space X is inside a platform segment, or DISABLE it when the
// cat is over a gap. The body never moves — zero broadphase issues.
//
// CAT_SCREEN_X must match CatPlayer.CAT_X (80 px).
// FLOOR_W is slightly wider than the cat's physics body (36 px) so diagonal
// contact at the segment edge still registers.
// ---------------------------------------------------------------------------
const CAT_SCREEN_X = 80;
const FLOOR_W      = 80;  // wider than the 36-px cat body
const FLOOR_H      = 8;   // same height as the old per-segment bodies
const GROUND_DEPTH = 9;

// ---------------------------------------------------------------------------
// Scroll / generation constants
// ---------------------------------------------------------------------------
const SCROLL_SPEED = 150; // px / s — keep in sync with BackgroundManager
const SPAWN_AHEAD  = 1200; // px ahead of right canvas edge to keep spawned

// Tile repetition per type: each tile kind repeats 1–4 times per segment.
const REPEAT_MIN = 1;
const REPEAT_MAX = 4;

const GAP_CHANCE = 0.40; // probability of a gap before each new segment
const GAP_MIN    = 80;   // minimum gap width (px)
const GAP_MAX    = 95;   // maximum gap width (px)

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

    this._nextWorldX      = 0;
    this._scrollOffset    = 0;
    this._segmentsSpawned = 0;

    // Segment records — visual only (no per-segment physics body):
    //   { worldX, width, tiles: [{sprite, localX}, ...] }
    this._segments = [];

    // ── Shared 1×1 white texture for the floor body ────────────────────────
    if (!scene.textures.exists("__ground_px")) {
      const gfx = scene.add.graphics();
      gfx.fillStyle(0xffffff, 1);
      gfx.fillRect(0, 0, 1, 1);
      gfx.generateTexture("__ground_px", 1, 1);
      gfx.destroy();
    }

    // ── Static group (CatPlayer registers its collider against this) ────────
    this._group = scene.physics.add.staticGroup();

    // ── THE floor body — permanently at the cat's screen X, never moves ────
    // Centred on CAT_SCREEN_X, top edge at SURFACE_Y.
    this._floor = scene.physics.add.staticImage(
      CAT_SCREEN_X, SURFACE_Y, "__ground_px"
    );
    this._floor.setOrigin(0.5, 0);   // top-centre anchor
    this._floor.setAlpha(0);
    this._floor.setDepth(GROUND_DEPTH);
    this._floor.body.setSize(FLOOR_W, FLOOR_H);
    // Manually pin the body — setOrigin(0.5, 0) means:
    //   body.x = sprite.x − displayOriginX = CAT_SCREEN_X − FLOOR_W/2
    //   body.y = sprite.y − displayOriginY  = SURFACE_Y − 0 = SURFACE_Y
    this._floor.body.reset(CAT_SCREEN_X - FLOOR_W / 2, SURFACE_Y);
    this._group.add(this._floor);

    // ── Seed enough segments to fill canvas + buffer ───────────────────────
    const canvasW = scene.scale.width;
    while (this._getRightWorldEdge() < canvasW + SPAWN_AHEAD) {
      this._spawnNextSegment();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** The static physics group — pass to CatPlayer for the collider. */
  get group() { return this._group; }

  /** World Y of the walkable brick surface. */
  get surfaceY() { return SURFACE_Y; }

  /** Call every frame from GameScene.update(). */
  update(delta) {
    this._scrollOffset += SCROLL_SPEED * (delta / 1000);
    const scrollPx = Math.round(this._scrollOffset);
    const canvasW  = this.scene.scale.width;

    // ── Reposition visual tiles ────────────────────────────────────────────
    for (const seg of this._segments) {
      const screenX = seg.worldX - scrollPx;
      for (const t of seg.tiles) {
        t.sprite.x = screenX + t.localX;
      }
    }

    // ── Enable / disable the floor body based on gap detection ─────────────
    // The cat is pinned at CAT_SCREEN_X on screen.
    // Its world-space X at this scroll offset is: scrollPx + CAT_SCREEN_X.
    const catWorldX = scrollPx + CAT_SCREEN_X;
    let hasPlatform = false;
    for (const seg of this._segments) {
      if (catWorldX >= seg.worldX && catWorldX < seg.worldX + seg.width) {
        hasPlatform = true;
        break;
      }
    }
    this._floor.body.enable = hasPlatform;

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

    // ── Spawn new segments ahead ───────────────────────────────────────────
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
      this._nextWorldX += gapW;
      withLanding = true;
    }

    // ── Tile sequence: landing(1-4)? + left(1-4) + middle(1-4) + right(1-4)
    const tileKeys = [];

    if (withLanding) {
      const n = randInt(REPEAT_MIN, REPEAT_MAX);
      for (let i = 0; i < n; i++) tileKeys.push("roof_landing");
    }

    const leftN = randInt(REPEAT_MIN, REPEAT_MAX);
    for (let i = 0; i < leftN; i++) tileKeys.push("roof_left");

    const midN = randInt(REPEAT_MIN, REPEAT_MAX);
    for (let i = 0; i < midN; i++) tileKeys.push("roof_middle");

    const rightN = randInt(REPEAT_MIN, REPEAT_MAX);
    for (let i = 0; i < rightN; i++) tileKeys.push("roof_right");

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

    this._segments.push({ worldX: segWorldX, width: segWidth, tiles });
    this._nextWorldX += segWidth;
    this._segmentsSpawned++;
  }

  _destroySegment(seg) {
    for (const t of seg.tiles) t.sprite.destroy();
  }

  _getRightWorldEdge() {
    if (this._segments.length === 0) return 0;
    const last = this._segments[this._segments.length - 1];
    return last.worldX + last.width;
  }
}
