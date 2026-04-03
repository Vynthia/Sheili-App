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
// IMPORTANT: After moving all static bodies, this._group.refresh() MUST be
// called once per frame to flush the updated positions into the broadphase
// spatial hash.  Without this call the collision tree retains stale positions
// and the cat falls through the (visually correct) platforms.
//
// We do NOT attach bodies to the visual tile sprites — setCrop+setScale in
// Phaser 3.90 corrupts refreshBody(), so visuals and physics are kept separate.
// ---------------------------------------------------------------------------
const GROUND_DEPTH = 9; // drawn just below visual tiles (depth 10)

// ---------------------------------------------------------------------------
// Scroll / generation constants
//
// Gap visibility + jumpability constraints:
//
//   Cat physics body width ≈ 36 px (body.left ≈ 57.5, body.right ≈ 93.5).
//   The EFFECTIVE time the cat spends with NO platform body under it is:
//       effective_gap_time = (gapW − 36) / SCROLL_SPEED
//
//   With gapW = 50: effective_time = 14/150 = 0.093 s → fall = 4 px.
//   The next segment's 8 px body catches the cat automatically — no jump
//   needed, gap looks and behaves as if rooftops are connected.  BUG.
//
//   We need effective_gap_time long enough that the cat falls PAST the
//   next body's bottom (8 px) before it arrives, forcing a jump:
//       fall > 8 px  →  gapW > 56 px  (threshold)
//
//   GAP_MIN = 80 px  →  effective_time = 0.293 s, fall ≈ 39 px → game-over
//                        if no jump.  Clearly visible on screen (17 % width).
//   GAP_MAX = 95 px  →  effective_time = 0.393 s, fall ≈ 69 px → game-over.
//                        Safe: max jumpable ≈ 103 px (air time 0.689 s).
// ---------------------------------------------------------------------------
const SCROLL_SPEED = 150; // px / s — keep in sync with BackgroundManager
const SPAWN_AHEAD  = 1200; // px ahead of right canvas edge to keep spawned

// Tile repetition per type: each tile kind repeats 1–4 times per segment.
const REPEAT_MIN = 1;
const REPEAT_MAX = 4;

const GAP_CHANCE = 0.40; // probability of a gap before each new segment
const GAP_MIN    = 80;   // minimum gap width — forces a real fall if missed
const GAP_MAX    = 95;   // maximum gap width — safe ceiling is ~103 px

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

      // Move the static physics sprite and body to the new screen position.
      seg.ground.x = screenX;
      seg.ground.body.reset(screenX, SURFACE_Y);

      // Reposition visual tiles.
      for (const t of seg.tiles) {
        t.sprite.x = screenX + t.localX;
      }
    }

    // ── Flush all moved static bodies into the broadphase tree ─────────────
    // Without this call the spatial hash keeps stale positions, causing the
    // cat to fall through platforms that look correct on screen.
    this._group.refresh();

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
      withLanding = true;       // the segment opens with landing tiles
    }

    // ── Decide tile sequence ───────────────────────────────────────────────
    // Order: roof_landing (1–4×, only after gap) → roof_left (1–4×)
    //        → roof_middle (1–4×) → roof_right (1–4×)
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

    // ── Create invisible physics body for this segment ─────────────────────
    const screenX = segWorldX - scrollPx;
    const ground  = this.scene.physics.add.staticImage(
      screenX, SURFACE_Y, "__ground_px"
    );
    ground.setOrigin(0, 0);
    ground.setAlpha(0);
    ground.setDepth(GROUND_DEPTH);
    ground.body.setSize(segWidth, 8); // 8 px tall — tolerant of 1-frame timing gaps
    this._group.add(ground);
    ground.body.reset(screenX, SURFACE_Y);

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
