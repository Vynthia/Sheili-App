// ---------------------------------------------------------------------------
// ObstacleManager — spawns and scrolls rooftop obstacles, and manages the
// independent flying bird that crosses the canvas from left to right.
//
// ── Ground obstacle collision ──────────────────────────────────────────────
// All obstacles are plain visual images (no physics bodies).
// Collision is pure AABB in screen-space, checked every frame in update().
// `this.collision` is set true on any hit; GameScene reads the flag and
// calls scene.restart().
//
// Hitboxes are calibrated individually per obstacle type:
//   The hitbox covers only the solid visible shape of each sprite.
//   hitH < 53 px guarantees the cat can jump over at apex (catBottom≈142).
//   Timing windows: chimney 130 ms, antenna 190 ms, vent 195 ms, bird 195 ms.
//
// ── Depths ─────────────────────────────────────────────────────────────────
//   Cat depth = 30.  Ground obstacles depth = 20.  Cat always renders in front.
//
// ── Flying bird (bird_fly) ─────────────────────────────────────────────────
// Completely independent of the segment system.  Managed by separate manual
// AABB — also sets `this.collision = true`.  Not in any physics group.
// Bird will NOT spawn while any ground obstacle is visible on screen.
// ---------------------------------------------------------------------------

const SCROLL_SPEED = 150; // px/s — must match PlatformManager
const TILE_W       = 512; // px  — must match PlatformManager
const SURFACE_Y    = 195; // px  — visual ground Y for obstacle sprites

// Depth for ALL ground obstacles (cat depth = 30 → cat always in front).
const OBSTACLE_DEPTH = 20;

// ---------------------------------------------------------------------------
// Ground obstacle type definitions.
//
// `scale`  — display scale (source sprites are 128×128 px).
// `hitW`   — collision box total width  (display px, centred on sprite X).
// `hitH`   — collision box total height (display px, measured UP from SURFACE_Y).
//            Must be < 53 so the cat can clear it at jump apex (catBottom≈142).
//            Individual values calibrated to each obstacle's solid visible shape.
// ---------------------------------------------------------------------------
const OBSTACLE_TYPES = [
  { key: "chimney", scale: 0.7,  hitW: 28, hitH: 25 }, // 130 ms timing window
  { key: "antenna", scale: 0.45, hitW: 12, hitH: 30 }, // 190 ms timing window
  { key: "vent",    scale: 0.6,  hitW: 36, hitH: 20 }, // 195 ms timing window
  { key: "bird",    scale: 0.3,  hitW: 22, hitH: 22 }, // 195 ms timing window
];

// Maximum ground obstacles placed per segment.
const MAX_PER_SEGMENT = 2;

// Minimum world-space gap between any two consecutive ground obstacles.
const MIN_SPACING = TILE_W;

// Per-tile spawn probability for ground obstacles.
const SPAWN_CHANCE = 0.55;

// ---------------------------------------------------------------------------
// Flying bird constants.
// ---------------------------------------------------------------------------

// Display scale for bird_fly (source 128×128 per frame).
// Scale 0.3 matches the sitting bird obstacle scale.
const BIRD_FLY_SCALE = 0.3;

// Screen Y centre of the flying bird.
// At Y=100 the bird is well above the platform; any full jump will reach it.
const BIRD_FLY_Y = 100;

// Horizontal travel speed (px/s, left → right).
const BIRD_FLY_SPEED = 80;

// Collision hitbox for the flying bird (display px, centred on BIRD_FLY_Y).
const BIRD_FLY_HIT_W = 38;
const BIRD_FLY_HIT_H = 24;

// Canvas width — used to detect when the bird exits the right edge.
const CANVAS_W = 480;

// Random gap between one crossing and the next (milliseconds).
const BIRD_FLY_MIN_DELAY = 4000;
const BIRD_FLY_MAX_DELAY = 10000;

// If a ground obstacle is still on screen when the timer expires, retry.
const BIRD_RETRY_DELAY = 800; // ms

// ---------------------------------------------------------------------------
// Cat body dimensions — must match CatPlayer's physics body exactly.
//
// Cat body: setSize(28, 40), setOffset(22, 76), scale 0.5, origin (0.5, 1).
//
//   catLeft   = CAT_SCREEN_X − 32 + 22        = CAT_SCREEN_X − 10   = 70
//   catRight  = catLeft + 28                   = CAT_SCREEN_X + 18   = 98
//   catTop    = sprite.y − 64 + 76             = sprite.y + 12
//   catBottom = sprite.y + 12 + 40             = sprite.y + 52
//   On ground: sprite.y ≈ 143 → catTop=155, catBottom=195 = SURFACE_Y ✓
// ---------------------------------------------------------------------------
const CAT_SCREEN_X           = 80;
const CAT_BODY_LEFT_OFFSET   = -10; // catLeft  = 70
const CAT_BODY_RIGHT_OFFSET  =  18; // catRight = 98
const CAT_BODY_TOP_OFFSET    =  12; // catTop   = sprite.y + 12
const CAT_BODY_BOTTOM_OFFSET =  52; // catBottom = sprite.y + 52

// ---------------------------------------------------------------------------

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randDelay() {
  return randInt(BIRD_FLY_MIN_DELAY, BIRD_FLY_MAX_DELAY);
}

// ---------------------------------------------------------------------------

export class ObstacleManager {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this._scene        = scene;
    this._scrollOffset = 0;
    this._obstacles    = []; // { worldX, sprite, hitW, obsTop, obsBottom }
    this._lastWorldX   = -MIN_SPACING * 2;
    this.collision     = false;

    // Flying bird state.
    this._flySprite = null;
    this._flyX      = 0;
    this._flyTimer  = randDelay();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Called by PlatformManager whenever a new segment is spawned.
   * Randomly places 0–MAX_PER_SEGMENT ground obstacles in the segment interior.
   */
  onSegmentSpawned(seg) {
    const numTiles = Math.round(seg.width / TILE_W);
    if (numTiles < 3) return;

    // Eligible tile indices: skip first (landing edge) and last (gap edge).
    const eligible = [];
    for (let i = 1; i < numTiles - 1; i++) eligible.push(i);

    // Fisher-Yates shuffle.
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

      // Plain visual image — no physics body.
      const sprite = this._scene.add.image(worldX - scrollPx, SURFACE_Y, type.key);
      sprite.setOrigin(0.5, 1); // bottom-centre on the surface
      sprite.setScale(type.scale);
      sprite.setDepth(OBSTACLE_DEPTH);

      // Hitbox: pre-computed once at spawn; Y measured up from SURFACE_Y.
      const obsTop    = SURFACE_Y - type.hitH;
      const obsBottom = SURFACE_Y;

      this._obstacles.push({ worldX, sprite, hitW: type.hitW, obsTop, obsBottom });
      this._lastWorldX = worldX;
      placed++;
    }
  }

  /**
   * Advance all obstacles and the flying bird, then run AABB collision checks.
   * Sets `this.collision = true` on any hit; GameScene calls scene.restart().
   *
   * @param {number}                    delta
   * @param {Phaser.GameObjects.Sprite} catSprite
   */
  update(delta, catSprite) {
    this._scrollOffset += SCROLL_SPEED * (delta / 1000);
    const scrollPx = Math.round(this._scrollOffset);

    const catLeft   = CAT_SCREEN_X + CAT_BODY_LEFT_OFFSET;   // 70
    const catRight  = CAT_SCREEN_X + CAT_BODY_RIGHT_OFFSET;  // 98
    const catTop    = catSprite.y  + CAT_BODY_TOP_OFFSET;     // sprite.y + 12
    const catBottom = catSprite.y  + CAT_BODY_BOTTOM_OFFSET;  // sprite.y + 52

    this.collision = false;

    // ── Ground obstacles ──────────────────────────────────────────────────
    // Full AABB — no airborne bypass.
    // hitH < 53 ensures catBottom at jump apex (≈142) is above obsTop.
    // The cat must time its jump so the obstacle passes during Y-clear window.
    for (const obs of this._obstacles) {
      const screenX = obs.worldX - scrollPx;
      obs.sprite.x  = screenX;

      const obsLeft  = screenX - obs.hitW / 2;
      const obsRight = screenX + obs.hitW / 2;

      if (
        catLeft   < obsRight      &&
        catRight  > obsLeft       &&
        catTop    < obs.obsBottom &&
        catBottom > obs.obsTop
      ) {
        this.collision = true;
      }
    }

    // Recycle obstacles that have fully scrolled off the left edge.
    while (this._obstacles.length > 0) {
      const obs = this._obstacles[0];
      if (obs.worldX - scrollPx + obs.hitW / 2 < 0) {
        obs.sprite.destroy();
        this._obstacles.shift();
      } else {
        break;
      }
    }

    // ── Flying bird (manual AABB) ─────────────────────────────────────────
    this._updateFlyingBird(delta, scrollPx, catLeft, catRight, catTop, catBottom);
  }

  /** Destroy all managed objects (call before scene.restart()). */
  destroy() {
    for (const obs of this._obstacles) obs.sprite.destroy();
    this._obstacles = [];

    if (this._flySprite) {
      this._flySprite.destroy();
      this._flySprite = null;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _updateFlyingBird(delta, scrollPx, catLeft, catRight, catTop, catBottom) {
    if (this._flySprite) {
      // Move bird right.
      this._flyX       += BIRD_FLY_SPEED * (delta / 1000);
      this._flySprite.x = this._flyX;

      // AABB collision (centred on flyX / BIRD_FLY_Y).
      const halfW = BIRD_FLY_HIT_W / 2;
      const halfH = BIRD_FLY_HIT_H / 2;
      if (
        catLeft   < this._flyX + halfW   &&
        catRight  > this._flyX - halfW   &&
        catTop    < BIRD_FLY_Y + halfH   &&
        catBottom > BIRD_FLY_Y - halfH
      ) {
        this.collision = true;
      }

      // Despawn when exiting the right edge.
      const halfDisplayW = (128 * BIRD_FLY_SCALE) / 2;
      if (this._flyX - halfDisplayW > CANVAS_W) {
        this._flySprite.destroy();
        this._flySprite = null;
        this._flyTimer  = randDelay();
      }
    } else {
      this._flyTimer -= delta;
      if (this._flyTimer <= 0) {
        // Only spawn when no ground obstacle is visible on screen.
        const hasObstacleOnScreen = this._obstacles.some(obs => {
          const sx = obs.worldX - scrollPx;
          return sx + obs.hitW / 2 > 0 && sx - obs.hitW / 2 < CANVAS_W;
        });

        if (hasObstacleOnScreen) {
          this._flyTimer = BIRD_RETRY_DELAY;
          return;
        }

        // Spawn bird just off the left edge.
        const halfDisplayW = (128 * BIRD_FLY_SCALE) / 2;
        this._flyX = -halfDisplayW;

        this._flySprite = this._scene.add.sprite(
          this._flyX, BIRD_FLY_Y, "bird_fly"
        );
        this._flySprite.setOrigin(0.5, 0.5);
        this._flySprite.setScale(BIRD_FLY_SCALE);
        this._flySprite.setDepth(OBSTACLE_DEPTH);
        this._flySprite.play("bird_fly");
        this._flySprite.setFlipX(false); // sprite naturally faces right
      }
    }
  }
}
