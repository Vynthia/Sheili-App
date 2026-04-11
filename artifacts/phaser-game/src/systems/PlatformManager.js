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

// Catcher floor: a MOVING static body repositioned every frame to sit
// directly under the catcher's current screen X.  This eliminates all
// stale-broadphase-tree issues that plague a fixed-position body.
//
// Width chosen to cover the catcher's physics body (28 px) with margin.
// The body is re-centred on the catcher's sprite.x each frame via
// setPosition() + refreshBody(), so X range is always up-to-date.
const CATCHER_FLOOR_W = 80; // wider than catcher's 28-px physics body

// Catcher body X offsets from sprite.x (screen space).
// Derived from CatcherEnemy: BODY_OFFSET_X=22, BODY_WIDTH=28, displayOriginX=32
//   body.left  = sprite.x − 32 + 22           = sprite.x − 10
//   body.right = sprite.x − 32 + 22 + 28      = sprite.x + 18
// These offsets are used ONLY for the segment overlap test in updateCatcherFloor.
const CATCHER_BODY_LEFT_OFFSET  = -10; // px from sprite.x to body left edge
const CATCHER_BODY_RIGHT_OFFSET =  18; // px from sprite.x to body right edge

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

    // ── Catcher floor body — separate group, MOVES every frame ────────────
    // Unlike the cat floor (fixed at CAT_SCREEN_X), this body is repositioned
    // each frame by updateCatcherFloor() to sit directly under the catcher's
    // current screen X.  That makes the support deterministic: there is zero
    // ambiguity about whether the body is under the catcher.
    //
    // Initial position: place it at the catcher's spawn X (CAT_X − START_DIST
    // = 80 − 90 = −10).  The first segment starts at worldX=0; the catcher's
    // body right edge (sprite.x + 18 = 8) already overlaps it, so the overlap
    // test in updateCatcherFloor() will enable the body on frame 1.
    //
    // After setSize(), refreshBody() (called by staticGroup.add()) syncs the
    // broadphase tree with the new dimensions.
    const CATCHER_SPAWN_X = -10; // CAT_X − START_DISTANCE
    this._catcherGroup = scene.physics.add.staticGroup();
    this._catcherFloor = scene.physics.add.staticImage(
      CATCHER_SPAWN_X - CATCHER_FLOOR_W / 2, SURFACE_Y, "__ground_px"
    );
    this._catcherFloor.setOrigin(0, 0); // origin (0,0): body.x == go.x exactly
    this._catcherFloor.setAlpha(0);
    this._catcherFloor.setDepth(GROUND_DEPTH);
    // NOTE: setSize() is called AFTER staticGroup.add() below, because add()
    // internally calls refreshBody() → body.reset() which resets body.width and
    // body.height to match the game object's DISPLAY size (1×1 for this texture).
    // That would wipe out any setSize() call made before add().
    this._catcherGroup.add(this._catcherFloor);
    // Re-apply position and custom dimensions now that add() has finished.
    // setSize(w, h, false) sets width + height without centering (center=false),
    // then calls world.staticTree.update() — the single call that re-inserts the
    // body into the broadphase tree with the CORRECT 80×8 bounds.
    this._catcherFloor.body.position.x = CATCHER_SPAWN_X - CATCHER_FLOOR_W / 2;
    this._catcherFloor.body.position.y = SURFACE_Y;
    this._catcherFloor.body.setSize(CATCHER_FLOOR_W, FLOOR_H, false); // ← also updates tree

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
   * Reposition the catcher floor body to the catcher's current screen X and
   * enable it only when the catcher is above a real platform segment.
   *
   * DESIGN
   * ──────
   * A static body in Arcade Physics is cached in a broadphase RTree.  Any
   * time the body is moved or resized, the tree entry must be refreshed
   * (via refreshBody()) otherwise collisions use the stale, original bounds.
   * The old fixed-position approach never moved the body, but also meant the
   * body was always at x=−45…65 regardless of where the catcher actually was.
   * After crashes, the catcher creeps right (toward min-distance = 40 px),
   * and the fixed floor no longer had the catcher fully over it.
   *
   * NEW APPROACH: move the floor body to the catcher's screen X every frame.
   *   1. Convert catcherScreenX to world space using the current scroll offset.
   *   2. Test whether the catcher's PHYSICS BODY (not just sprite centre) world
   *      range overlaps any live segment.  Using the body's left/right edges
   *      (CATCHER_BODY_LEFT/RIGHT_OFFSET) means the catcher is detected as
   *      "on platform" even when its sprite.x sits slightly before a segment's
   *      worldX (e.g. at startup: sprite.x = −10, first segment worldX = 0,
   *      but body.right world = 8 which IS inside the segment).
   *   3. If over a segment: position the floor body centred on catcherScreenX
   *      via setPosition() + refreshBody().  refreshBody() re-inserts the body
   *      into the static tree at the new coordinates — this is the key step
   *      that was missing in every previous attempt.  Then enable the body.
   *   4. If over a gap: disable the body.  The catcher must be airborne (it
   *      mirrors the cat's jump).  The gap is only 70–90 px; the 120 ms jump
   *      delay gives the catcher ≈ 18 px of forward travel before it lifts off,
   *      well within the gap width.
   *
   * CALL ORDER (enforced by GameScene)
   * ───────────────────────────────────
   * updateCatcherFloor(x) runs BEFORE catcher.update() so the floor is at
   * the correct position when _updateChasing() reads body.blocked.down.
   * The Arcade physics step that resolves the collision against this floor
   * ran at the top of the CURRENT frame (before update() was called), so the
   * repositioned floor takes effect for the NEXT frame's physics step.  This
   * one-frame lag is identical to how the cat floor works and is acceptable.
   *
   * @param {number} catcherScreenX   catcher sprite.x in screen (canvas) pixels
   * @returns {{ segmentUnder: object|null, catcherBodyLeft: number,
   *             catcherBodyRight: number, scrollPx: number }}
   *   Diagnostic info consumed by GameScene's debug failsafe.
   */
  updateCatcherFloor(catcherScreenX) {
    const scrollPx = Math.round(this._scrollOffset);

    // ── 1. Catcher body world-space left / right ────────────────────────────
    // These offsets match the body geometry in CatcherEnemy exactly:
    //   displayOriginX = 32, BODY_OFFSET_X = 22, BODY_WIDTH = 28
    //   body.left  = sprite.x − 32 + 22      = sprite.x − 10
    //   body.right = sprite.x − 32 + 22 + 28 = sprite.x + 18
    const catcherBodyLeft  = scrollPx + catcherScreenX + CATCHER_BODY_LEFT_OFFSET;
    const catcherBodyRight = scrollPx + catcherScreenX + CATCHER_BODY_RIGHT_OFFSET;

    // ── 2. Segment overlap test (geometry only — no blocked.down) ───────────
    // AABB: catcher body overlaps segment when body.left < seg.right
    // AND body.right > seg.left.
    let segmentUnder = null;
    for (const seg of this._segments) {
      if (catcherBodyLeft < seg.worldX + seg.width && catcherBodyRight > seg.worldX) {
        segmentUnder = seg;
        break;
      }
    }

    // ── 3. Reposition and sync the static body ──────────────────────────────
    //
    // CRITICAL: do NOT use setPosition() + refreshBody() here.
    // refreshBody() calls body.reset() which resets body.width and body.height
    // to match the game object's DISPLAY dimensions (1×1 for this texture),
    // wiping out the custom 80×8 size set in the constructor.  The tree entry
    // would then be 1×1 and the collision would never fire.
    //
    // Correct approach: update body.position.x directly, then call
    // setSize(w, h, false) which (a) preserves the custom dimensions, (b)
    // recomputes body.center, and (c) calls world.staticTree.update() — the
    // only step needed to move a static body in the broadphase tree.
    if (segmentUnder) {
      this._catcherFloor.body.position.x = catcherScreenX - CATCHER_FLOOR_W / 2;
      // body.position.y stays permanently at SURFACE_Y — never changes.
      // setSize with center=false: keeps our position, restores 80×8, updates tree.
      this._catcherFloor.body.setSize(CATCHER_FLOOR_W, FLOOR_H, false);
      this._catcherFloor.body.enable = true;
    } else {
      // Gap under catcher — catcher must be airborne (mirroring the cat's jump).
      this._catcherFloor.body.enable = false;
    }

    // Return diagnostic info used by GameScene's debug failsafe.
    return { segmentUnder, catcherBodyLeft, catcherBodyRight, scrollPx };
  }

  /**
   * Returns true if `worldX` falls inside any live platform segment.
   * Used by ObstacleManager to verify ground support before spawning a bird.
   * @param {number} worldX
   */
  isWorldXOverGround(worldX) {
    for (const seg of this._segments) {
      if (worldX >= seg.worldX && worldX < seg.worldX + seg.width) return true;
    }
    return false;
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
