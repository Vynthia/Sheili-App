// ---------------------------------------------------------------------------
// ObstacleManager — spawns and scrolls rooftop obstacles.
//
// Obstacle collision uses the same "single pinned body" philosophy as the
// floor: the cat is always at a fixed screen X (CAT_SCREEN_X).  Every frame
// we check which obstacle — if any — is currently overlapping the cat's
// physics-body bounding box in screen space.  If an overlap is detected the
// manager sets its `collision` flag so GameScene can act (e.g. restart).
//
// Jump clearance maths:
//   JUMP_VEL = -310, GRAVITY_Y = 900
//   Peak height above ground = 310² / (2 × 900) ≈ 53 px
//   At peak: catBodyBottom = SURFACE_Y − 53 = 142
//   Obstacle must have hitH ≤ 53 px so its top (SURFACE_Y − hitH) ≥ 142.
//   All hitH values below are ≤ 44 px → 9 px clearance at peak.
// ---------------------------------------------------------------------------

const SCROLL_SPEED = 150; // px/s — must match PlatformManager
const TILE_W       = 512; // px  — must match PlatformManager
const SURFACE_Y    = 220; // px  — must match PlatformManager

// Visual scale for all obstacle sprites (source 128×128).
// 128 × 0.8 = 102 px display — obstacle top appears at SURFACE_Y − 102 = 118,
// which is prominently visible on the cat's body level (cat sprite feet at y ≈ 220).
const OBSTACLE_SCALE = 0.8;

// Obstacles must render IN FRONT of the cat (cat depth = 15).
const OBSTACLE_DEPTH = 20;

// Per-type hit boxes (display pixels, at OBSTACLE_SCALE = 0.8).
//
// Jump-clearance budget: cat body.bottom at peak ≈ 142.
// Obstacle top at SURFACE_Y − 102 = 118 → clearance = 142 − 118 = 24 px.
// We use hitH ≤ 36 to maintain safe jump clearance even at larger scale.
// hitW is narrower than the full display width to give a forgiving margin.
const OBSTACLE_TYPES = [
  { key: "chimney",  hitW: 26, hitH: 36 },
  { key: "antenna",  hitW: 10, hitH: 36 },
  { key: "vent",     hitW: 32, hitH: 22 },
  { key: "skylight", hitW: 40, hitH: 14 },
];

// Maximum obstacles placed per segment.
const MAX_PER_SEGMENT = 2;

// Minimum world-space distance between any two consecutive obstacles.
// One tile (512 px) ≈ 3.4 s — enough time to react, jump, land, and react again.
const MIN_SPACING = TILE_W;

// Per-tile spawn probability (applied to each safe tile independently).
const SPAWN_CHANCE = 0.55;

// Cat body offsets from CAT_SCREEN_X used for X collision.
const CAT_SCREEN_X         = 80;
const CAT_BODY_LEFT_OFFSET = -13; // catBodyLeft  = CAT_SCREEN_X − 13 = 67
const CAT_BODY_RIGHT_OFFSET = 23; // catBodyRight = CAT_SCREEN_X + 23 = 103

// Cat body Y offsets from sprite.y (origin 0.5,1 → displayOriginY = 64):
//   body.top    = sprite.y − 64 + 70 = sprite.y + 6
//   body.bottom = body.top + 46      = sprite.y + 52
const CAT_BODY_TOP_OFFSET    =  6;
const CAT_BODY_BOTTOM_OFFSET = 52;

// ---------------------------------------------------------------------------

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------

export class ObstacleManager {
  /**
   * @param {Phaser.Scene} scene
   */
  constructor(scene) {
    this._scene          = scene;
    this._scrollOffset   = 0;
    this._obstacles      = []; // { worldX, sprite, hitW, hitH }
    this._lastWorldX     = -MIN_SPACING * 2; // no obstacle too close at start
    this.collision       = false; // set true this frame if cat hits an obstacle
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Called by PlatformManager (via GameScene callback) whenever a new segment
   * is spawned.  Randomly places 0–2 obstacles in the safe interior of the
   * segment — never on the first tile (landing / left edge) or the last tile
   * (right edge, where the gap starts).
   *
   * @param {{ worldX: number, width: number, withLanding: boolean }} seg
   */
  onSegmentSpawned(seg) {
    const numTiles = Math.round(seg.width / TILE_W);
    // Need at least 3 tiles so there is one safe interior tile.
    if (numTiles < 3) return;

    // Collect eligible tile indices (skip index 0 and the last).
    const eligible = [];
    for (let i = 1; i < numTiles - 1; i++) eligible.push(i);

    // Shuffle in place (Fisher-Yates).
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }

    let placed = 0;
    for (const tileIdx of eligible) {
      if (placed >= MAX_PER_SEGMENT) break;

      // Centre of this tile in world space.
      const worldX = seg.worldX + tileIdx * TILE_W + TILE_W / 2;

      // Enforce minimum spacing from any previously placed obstacle.
      if (worldX - this._lastWorldX < MIN_SPACING) continue;

      // Random chance to actually place one.
      if (Math.random() > SPAWN_CHANCE) continue;

      // Pick a random obstacle type.
      const type = OBSTACLE_TYPES[randInt(0, OBSTACLE_TYPES.length - 1)];

      // Spawn visual sprite (it scrolls via worldX each frame).
      const scrollPx = Math.round(this._scrollOffset);
      const sprite   = this._scene.add.image(
        worldX - scrollPx, SURFACE_Y, type.key
      );
      sprite.setOrigin(0.5, 1); // bottom-centre sits on the rooftop surface
      sprite.setScale(OBSTACLE_SCALE);
      sprite.setDepth(OBSTACLE_DEPTH);

      this._obstacles.push({ worldX, sprite, hitW: type.hitW, hitH: type.hitH });
      this._lastWorldX = worldX;
      placed++;
    }
  }

  /**
   * Scroll all obstacles, recycle off-screen ones, and test collision with
   * the cat.  Sets `this.collision = true` if the cat's body overlaps any
   * obstacle hitbox this frame.
   *
   * @param {number}                    delta     Phaser delta ms
   * @param {Phaser.GameObjects.Sprite} catSprite The cat's physics sprite
   */
  update(delta, catSprite) {
    this._scrollOffset += SCROLL_SPEED * (delta / 1000);
    const scrollPx = Math.round(this._scrollOffset);

    // Cat body bounds in screen space (constant X, varying Y).
    const catLeft   = CAT_SCREEN_X + CAT_BODY_LEFT_OFFSET;   // 67
    const catRight  = CAT_SCREEN_X + CAT_BODY_RIGHT_OFFSET;  // 103
    const catTop    = catSprite.y + CAT_BODY_TOP_OFFSET;      // varies
    const catBottom = catSprite.y + CAT_BODY_BOTTOM_OFFSET;   // varies

    this.collision = false;

    // Reposition and check each obstacle.
    for (const obs of this._obstacles) {
      const screenX = obs.worldX - scrollPx;
      obs.sprite.x  = screenX;

      // Obstacle hitbox centred on screenX, bottom at SURFACE_Y.
      const obsLeft   = screenX      - obs.hitW / 2;
      const obsRight  = screenX      + obs.hitW / 2;
      const obsTop    = SURFACE_Y    - obs.hitH;
      const obsBottom = SURFACE_Y;

      // AABB overlap test.
      if (
        catLeft   < obsRight  &&
        catRight  > obsLeft   &&
        catTop    < obsBottom &&
        catBottom > obsTop
      ) {
        this.collision = true;
      }
    }

    // Recycle obstacles that have scrolled fully off the left edge.
    while (this._obstacles.length > 0) {
      const obs = this._obstacles[0];
      if (obs.worldX - scrollPx + obs.hitW / 2 < 0) {
        obs.sprite.destroy();
        this._obstacles.shift();
      } else {
        break;
      }
    }
  }

  /** Clean up all live obstacles (call on scene restart). */
  destroy() {
    for (const obs of this._obstacles) obs.sprite.destroy();
    this._obstacles = [];
  }
}
