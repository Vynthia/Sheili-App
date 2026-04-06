// ---------------------------------------------------------------------------
// ObstacleManager — spawns and scrolls rooftop obstacles.
//
// Obstacle collision uses the same "single pinned body" philosophy as the
// floor: the cat is always at a fixed screen X (CAT_SCREEN_X).  Every frame
// we check which obstacle — if any — is currently overlapping the cat's
// physics-body bounding box in screen space.  If an overlap is detected the
// manager sets its `collision` flag so GameScene can act (e.g. restart).
//
// Jump clearance maths (SURFACE_Y here = 220 for obstacle visuals):
//   JUMP_VEL = -310, GRAVITY_Y = 900
//   Peak height above ground = 310² / (2 × 900) ≈ 53 px
//   PlatformManager surfaceY = 195 → cat sprite.y on ground ≈ 195
//   At peak: sprite.y ≈ 195 − 53 = 142
//   catBodyTop at peak    = 142 + 6  = 148
//   catBodyBottom at peak = 142 + 52 = 194
//   catBodyTop on ground  = 195 + 6  = 201
//
// Ground obstacles: hitH ≤ 36 so the cat can jump over them.
// Airborne obstacles (bird_fly): positioned so obsBottom < 201 (safe on
//   ground) and obsBottom > 148 (fatal during jump).
// ---------------------------------------------------------------------------

const SCROLL_SPEED = 150; // px/s — must match PlatformManager
const TILE_W       = 512; // px  — must match PlatformManager
const SURFACE_Y    = 220; // px  — visual ground Y for obstacle sprites

// Visual scale for ground obstacle sprites (source 128×128).
// 128 × 0.8 = 102 px display.
const OBSTACLE_SCALE = 0.8;

// Scale for the airborne bird_fly sprite (source 128×128 per frame).
// 128 × 0.5 = 64 px display — a natural size for a bird in flight.
const BIRD_FLY_SCALE = 0.5;

// Y centre of the flying bird in screen space.
// Must satisfy: obsBottom < 201 (won't hit cat on ground)
//               obsTop    < 194 (will hit cat at jump peak)
// airY=165, hitH=30 → obsTop=150, obsBottom=180.  Fits both constraints.
const BIRD_FLY_Y = 165;

// Obstacles must render IN FRONT of the cat (cat depth = 15).
const OBSTACLE_DEPTH = 20;

// ---------------------------------------------------------------------------
// Obstacle type definitions.
//
// Ground types (airborne: false):
//   hitW / hitH are the collision box in display pixels.
//   obsBottom = SURFACE_Y, obsTop = SURFACE_Y − hitH.
//
// Airborne types (airborne: true):
//   hitbox is centred on airY in screen space.
//   obsTop = airY − hitH/2, obsBottom = airY + hitH/2.
// ---------------------------------------------------------------------------
const OBSTACLE_TYPES = [
  { key: "chimney",  hitW: 26, hitH: 36, airborne: false },
  { key: "antenna",  hitW: 10, hitH: 36, airborne: false },
  { key: "vent",     hitW: 32, hitH: 22, airborne: false },
  { key: "bird",     hitW: 40, hitH: 30, airborne: false },
  { key: "bird_fly", hitW: 50, hitH: 30, airborne: true  },
];

// Maximum obstacles placed per segment.
const MAX_PER_SEGMENT = 2;

// Minimum world-space distance between any two consecutive obstacles.
const MIN_SPACING = TILE_W;

// Per-tile spawn probability (applied to each safe tile independently).
const SPAWN_CHANCE = 0.55;

// Cat body offsets from CAT_SCREEN_X used for X collision.
const CAT_SCREEN_X          = 80;
const CAT_BODY_LEFT_OFFSET  = -13; // catBodyLeft  = 80 − 13 = 67
const CAT_BODY_RIGHT_OFFSET =  23; // catBodyRight = 80 + 23 = 103

// Cat body Y offsets from sprite.y (origin 0.5,1 → displayOriginY = 32 at
// scale 0.5; BODY_OFFSET_Y = 70 relative to unscaled top).
const CAT_BODY_TOP_OFFSET    =  6;  // body.top    = sprite.y + 6
const CAT_BODY_BOTTOM_OFFSET = 52;  // body.bottom = sprite.y + 52

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
    this._scene        = scene;
    this._scrollOffset = 0;
    this._obstacles    = []; // { worldX, sprite, hitW, obsTop, obsBottom }
    this._lastWorldX   = -MIN_SPACING * 2;
    this.collision     = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Called by PlatformManager (via GameScene callback) whenever a new segment
   * is spawned.  Randomly places 0–2 obstacles in the safe interior of the
   * segment — never on the first tile or the last tile.
   *
   * @param {{ worldX: number, width: number, withLanding: boolean }} seg
   */
  onSegmentSpawned(seg) {
    const numTiles = Math.round(seg.width / TILE_W);
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

      const worldX = seg.worldX + tileIdx * TILE_W + TILE_W / 2;

      if (worldX - this._lastWorldX < MIN_SPACING) continue;
      if (Math.random() > SPAWN_CHANCE) continue;

      const type     = OBSTACLE_TYPES[randInt(0, OBSTACLE_TYPES.length - 1)];
      const scrollPx = Math.round(this._scrollOffset);
      const screenX  = worldX - scrollPx;

      let sprite;

      if (type.airborne) {
        // Animated flying bird — use sprite so animation plays.
        sprite = this._scene.add.sprite(screenX, BIRD_FLY_Y, type.key);
        sprite.setOrigin(0.5, 0.5);
        sprite.setScale(BIRD_FLY_SCALE);
        sprite.play("bird_fly");
      } else {
        // Static ground obstacle — plain image, bottom sits on SURFACE_Y.
        sprite = this._scene.add.image(screenX, SURFACE_Y, type.key);
        sprite.setOrigin(0.5, 1);
        sprite.setScale(OBSTACLE_SCALE);
      }

      sprite.setDepth(OBSTACLE_DEPTH);

      // Pre-compute the screen-space hitbox vertical bounds.
      const obsTop    = type.airborne
        ? BIRD_FLY_Y - type.hitH / 2
        : SURFACE_Y  - type.hitH;
      const obsBottom = type.airborne
        ? BIRD_FLY_Y + type.hitH / 2
        : SURFACE_Y;

      this._obstacles.push({ worldX, sprite, hitW: type.hitW, obsTop, obsBottom });
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

    const catLeft   = CAT_SCREEN_X + CAT_BODY_LEFT_OFFSET;
    const catRight  = CAT_SCREEN_X + CAT_BODY_RIGHT_OFFSET;
    const catTop    = catSprite.y  + CAT_BODY_TOP_OFFSET;
    const catBottom = catSprite.y  + CAT_BODY_BOTTOM_OFFSET;

    this.collision = false;

    for (const obs of this._obstacles) {
      const screenX = obs.worldX - scrollPx;
      obs.sprite.x  = screenX;

      const obsLeft   = screenX - obs.hitW / 2;
      const obsRight  = screenX + obs.hitW / 2;

      // AABB overlap test using pre-computed vertical bounds.
      if (
        catLeft   < obsRight    &&
        catRight  > obsLeft     &&
        catTop    < obs.obsBottom &&
        catBottom > obs.obsTop
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
