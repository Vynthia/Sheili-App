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
// Solution: ONE permanently-placed static floor body per character, fixed at
// that character's pinned screen-X range. Each frame we simply ENABLE it when
// the character's world-space X is inside a platform segment, or DISABLE it
// when the character is over a gap. The bodies never move — zero broadphase
// issues.
//
// Cat floor: centred at CAT_SCREEN_X (80). Catcher floor: covers the
// catcher's full possible screen-X range (CAT_X − START_DIST to
// CAT_X − MIN_DIST = −10 to 40), placed in a SEPARATE static group so the
// cat's collider never interacts with the catcher's floor and vice-versa.
// ---------------------------------------------------------------------------
const CAT_SCREEN_X = 80;
const FLOOR_W      = 80;   // wider than the cat's physics body
const FLOOR_H      = 8;    // same height as the old per-segment bodies
const GROUND_DEPTH = 9;

// Catcher floor: fixed rectangle covering every screen-X the catcher can
// occupy.  Catcher body left ≈ sprite.x − 10, right ≈ sprite.x + 18.
// sprite.x range: −10 (start) to 40 (minimum distance).
// So body x range: −20 to 58.  We use a generous 110-px-wide body centred
// at x = 10, covering x = −45 to x = 65.
const CATCHER_FLOOR_CENTER_X = 10;
const CATCHER_FLOOR_W        = 110;

// ---------------------------------------------------------------------------
// Scroll / generation constants
// ---------------------------------------------------------------------------
const SCROLL_SPEED = 150; // px / s — keep in sync with BackgroundManager
const SPAWN_AHEAD  = 1200; // px ahead of right canvas edge to keep spawned

// Tile repetition per type.
// roof_landing : always exactly 1 after a gap.
// roof_left / roof_middle / roof_right : 1–2 times each.
const REPEAT_MIN = 1;
const REPEAT_MAX = 2;

// ---------------------------------------------------------------------------
// Gap constants
//
// Cat jump math:
//   JUMP_VEL = -310, GRAVITY_Y = 900
//   Full air time  = 2 × 310 / 900 ≈ 0.689 s
//   World scroll during full jump = 150 × 0.689 ≈ 103 px
//
//   Cat physics body width ≈ 36 px.
//   A gap is only felt when the cat's BODY LEFT edge exits the segment AND
//   the cat's BODY RIGHT edge has not yet entered the next segment.
//   Effective "danger window" = gap − 36 px of body.
//
//   GAP_MAX = 90 px → danger window = 54 px — well within jump range (103 px).
//   GAP_MIN = 70 px → danger window = 34 px — short but still forces a jump.
// ---------------------------------------------------------------------------
const GAP_CHANCE = 0.70; // probability of a gap before each new segment
const GAP_MIN    = 70;   // minimum gap width (px)
const GAP_MAX    = 90;   // maximum gap width (px) — always jumpable ≤ 103 px

// Cat body left/right offsets from CAT_SCREEN_X (used for gap detection).
// body left  ≈ CAT_SCREEN_X − 13 px
// body right ≈ CAT_SCREEN_X + 23 px
const CAT_BODY_LEFT_OFFSET  = -13;
const CAT_BODY_RIGHT_OFFSET =  23;

// Only 1 safe segment at startup so the cat can land; gaps begin on segment 2.
const INITIAL_SAFE_SEGMENTS = 1;

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

    // Optional callback — set by GameScene so ObstacleManager can react to
    // each newly spawned segment.  Signature: (seg) => void
    // where seg = { worldX, width, withLanding }.
    this.onSegmentSpawned = null;

    // Read-only accessor used by GameScene to seed obstacles on the initial
    // segments that were created before the callback was installed.
    this.segments = this._segments;

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

    // ── Catcher floor body — separate group, covers catcher's X range ───────
    // Same design as the cat floor: permanently fixed, never repositioned.
    // CatcherEnemy registers its own one-way collider against this group.
    // GameScene calls updateCatcherFloor() each frame to enable / disable it.
    this._catcherGroup = scene.physics.add.staticGroup();
    this._catcherFloor = scene.physics.add.staticImage(
      CATCHER_FLOOR_CENTER_X, SURFACE_Y, "__ground_px"
    );
    this._catcherFloor.setOrigin(0.5, 0);
    this._catcherFloor.setAlpha(0);
    this._catcherFloor.setDepth(GROUND_DEPTH);
    this._catcherFloor.body.setSize(CATCHER_FLOOR_W, FLOOR_H);
    this._catcherFloor.body.reset(CATCHER_FLOOR_CENTER_X - CATCHER_FLOOR_W / 2, SURFACE_Y);
    this._catcherGroup.add(this._catcherFloor);

    // ── Seed enough segments to fill canvas + buffer ───────────────────────
    const canvasW = scene.scale.width;
    while (this._getRightWorldEdge() < canvasW + SPAWN_AHEAD) {
      this._spawnNextSegment();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** The static physics group — pass to CatPlayer for the collider. */
  get group() { return this._group; }

  /** Separate static group for the catcher — pass to CatcherEnemy for its collider. */
  get catcherGroup() { return this._catcherGroup; }

  /** World Y of the walkable brick surface. */
  get surfaceY() { return SURFACE_Y; }

  /**
   * Keep the catcher's dedicated floor body permanently enabled.
   *
   * The catcher is a supernatural pursuer — it never falls through gaps.
   * It already mirrors the cat's jumps, so it is airborne when a gap passes
   * beneath it.  The floor body must be ALWAYS active so that when the
   * catcher comes back down (sometimes right at a gap edge), the Arcade
   * physics collider fires correctly and the catcher lands at SURFACE_Y
   * rather than falling through into the void.
   *
   * Disabling it based on gap overlap caused a timing bug: on wide gaps
   * (70–90 px) the catcher could land exactly as the gap was still beneath
   * it, the disabled body meant no collider fired, and the catcher fell
   * to the bottom of the canvas.
   *
   * Call signature is kept so GameScene.update() needs no changes.
   *
   * @param {number} _catcherScreenX  (unused — kept for call-site compatibility)
   */
  updateCatcherFloor(_catcherScreenX) {
    // Always enabled — catcher never falls through gaps.
    this._catcherFloor.body.enable = true;
  }

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
    // In world space the cat's physics body spans:
    //   left  = scrollPx + CAT_SCREEN_X + CAT_BODY_LEFT_OFFSET  (≈ scrollPx + 67)
    //   right = scrollPx + CAT_SCREEN_X + CAT_BODY_RIGHT_OFFSET (≈ scrollPx + 103)
    //
    // The floor is ENABLED whenever ANY segment overlaps the cat body range.
    // This means:
    //   • The floor stays on until the cat's BACK foot leaves the segment edge.
    //   • The floor turns back on as soon as the cat's FRONT foot reaches the
    //     next segment — giving the player the most generous landing window.
    const catBodyLeft  = scrollPx + CAT_SCREEN_X + CAT_BODY_LEFT_OFFSET;
    const catBodyRight = scrollPx + CAT_SCREEN_X + CAT_BODY_RIGHT_OFFSET;
    let hasPlatform = false;
    for (const seg of this._segments) {
      // AABB overlap: cat body overlaps segment if left < segRight AND right > segLeft
      if (catBodyLeft < seg.worldX + seg.width && catBodyRight > seg.worldX) {
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

    // ── Tile sequence: landing(×1, only after gap) + left(1-2) + middle(1-2) + right(1-2)
    const tileKeys = [];

    if (withLanding) {
      tileKeys.push("roof_landing"); // always exactly one landing tile after a gap
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

    // Notify ObstacleManager (or any other listener) about this new segment.
    if (this.onSegmentSpawned) {
      this.onSegmentSpawned({ worldX: segWorldX, width: segWidth, withLanding });
    }
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
