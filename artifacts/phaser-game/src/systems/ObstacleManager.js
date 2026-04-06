// ---------------------------------------------------------------------------
// ObstacleManager — spawns and scrolls rooftop obstacles, and manages the
// independent flying bird that crosses the canvas from left to right.
//
// ── Ground obstacle collision ──────────────────────────────────────────────
// Uses "single pinned body" AABB: the cat is always at CAT_SCREEN_X.
// Each frame we check every obstacle's hitbox against the cat's body rect.
//
// Jump clearance — two-part design:
//
//   1. AIRBORNE BYPASS: ground-obstacle Y-collision is SKIPPED entirely while
//      the cat is airborne (catBottom < SURFACE_Y − 3).  Any jump clears any
//      ground obstacle regardless of height.  The cat can only be killed by a
//      ground obstacle while running on the surface.
//
//   2. SMALL hitH: obsTop is kept close to SURFACE_Y so it only detects the
//      cat walking directly into the base of the object (not while jumping).
//      hitH = 5–8 px means the cat clears the hitbox after ~1 physics frame.
//
//   Flying bird (bird_fly) ignores the airborne bypass — jumping INTO it kills.
//
// ── Flying bird (bird_fly) ─────────────────────────────────────────────────
// Completely independent of the segment-spawning system.  The bird enters
// from the left edge, flies straight right at BIRD_FLY_SPEED px/s, and
// disappears off the right edge.  After a random delay it reappears.
// The cat must NOT jump while the bird is passing overhead — any jump that
// intersects the bird's hitbox triggers a restart.
// ---------------------------------------------------------------------------

const SCROLL_SPEED = 150; // px/s — must match PlatformManager
const TILE_W       = 512; // px  — must match PlatformManager
const SURFACE_Y    = 195; // px  — visual ground Y for obstacle sprites

// Obstacles must render IN FRONT of the cat (cat depth = 15).
const OBSTACLE_DEPTH = 20;

// ---------------------------------------------------------------------------
// Ground obstacle type definitions.
//
// `scale`  — individual display scale (source sprites are 128×128).
//            Change per-type to resize an obstacle independently.
// `hitW`   — collision box half-width (display px); narrower = more forgiving.
// `hitH`   — collision box height (display px, measured up from SURFACE_Y).
//            See clearance formula in the header — value depends on hitW.
// ---------------------------------------------------------------------------
const OBSTACLE_TYPES = [
  { key: "chimney", scale: 0.7,  hitW: 14, hitH: 6 },
  { key: "antenna", scale: 0.45, hitW: 8,  hitH: 8 },
  { key: "vent",    scale: 0.6,  hitW: 12, hitH: 6 },
  { key: "bird",    scale: 0.4,  hitW: 10, hitH: 6 },
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

// Display scale for the bird_fly spritesheet (source 128×128 per frame).
const BIRD_FLY_SCALE = 0.4;

// Screen Y centre of the flying bird (0 = top of canvas).
// At Y=100 the bird is well above the platform (SURFACE_Y=195) so the cat
// passes safely underneath when running.  Any full jump will reach it.
const BIRD_FLY_Y = 100;

// Horizontal travel speed (px/s, left → right).
const BIRD_FLY_SPEED = 80;

// Collision hitbox for the flying bird (display px, centred on BIRD_FLY_Y).
const BIRD_FLY_HIT_W = 50;
const BIRD_FLY_HIT_H = 30;

// Canvas width — used to detect when the bird exits the right edge.
const CANVAS_W = 480;

// Random gap between one crossing and the next (milliseconds).
const BIRD_FLY_MIN_DELAY = 4000;
const BIRD_FLY_MAX_DELAY = 10000;

// ---------------------------------------------------------------------------
// Cat body offsets (used for both ground and flying-bird collision).
// ---------------------------------------------------------------------------
const CAT_SCREEN_X          = 80;
const CAT_BODY_LEFT_OFFSET  = -13; // catLeft  = 67
const CAT_BODY_RIGHT_OFFSET =  23; // catRight = 103

// body.top    = catSprite.y + 6
// body.bottom = catSprite.y + 52
const CAT_BODY_TOP_OFFSET    =  6;
const CAT_BODY_BOTTOM_OFFSET = 52;

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
    this._obstacles    = []; // ground obstacles: { worldX, sprite, hitW, obsTop, obsBottom }
    this._lastWorldX   = -MIN_SPACING * 2;
    this.collision     = false;

    // Flying bird state
    this._flySprite    = null;  // live Phaser sprite, or null when not in flight
    this._flyX         = 0;    // current screen X of the bird
    this._flyTimer     = randDelay(); // ms until the bird next appears
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Called by PlatformManager whenever a new segment is spawned.
   * Randomly places 0–MAX_PER_SEGMENT ground obstacles in the segment interior.
   *
   * @param {{ worldX: number, width: number }} seg
   */
  onSegmentSpawned(seg) {
    const numTiles = Math.round(seg.width / TILE_W);
    if (numTiles < 3) return;

    // Eligible tile indices: skip the first (landing edge) and last (gap edge).
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

      const sprite = this._scene.add.image(
        worldX - scrollPx, SURFACE_Y, type.key
      );
      sprite.setOrigin(0.5, 1);  // bottom-centre on the surface
      sprite.setScale(type.scale);
      sprite.setDepth(OBSTACLE_DEPTH);

      // Hitbox vertical bounds, pre-computed once at spawn.
      const obsTop    = SURFACE_Y - type.hitH;
      const obsBottom = SURFACE_Y;

      this._obstacles.push({ worldX, sprite, hitW: type.hitW, obsTop, obsBottom });
      this._lastWorldX = worldX;
      placed++;
    }
  }

  /**
   * Advance all obstacles and the flying bird, then run collision checks.
   * Sets `this.collision = true` if the cat's body overlaps any hazard.
   *
   * @param {number}                    delta     Phaser delta ms
   * @param {Phaser.GameObjects.Sprite} catSprite
   */
  update(delta, catSprite) {
    this._scrollOffset += SCROLL_SPEED * (delta / 1000);
    const scrollPx = Math.round(this._scrollOffset);

    const catLeft   = CAT_SCREEN_X + CAT_BODY_LEFT_OFFSET;
    const catRight  = CAT_SCREEN_X + CAT_BODY_RIGHT_OFFSET;
    const catTop    = catSprite.y  + CAT_BODY_TOP_OFFSET;
    const catBottom = catSprite.y  + CAT_BODY_BOTTOM_OFFSET;

    this.collision = false;

    // ── Ground obstacles ──────────────────────────────────────────────────
    // Airborne bypass: skip Y-collision while the cat is in the air.
    // Any jump clears any ground obstacle — the cat can only be killed by
    // running directly into the base while standing firmly on the surface.
    // catBottom must be AT the surface (within 1px tolerance) to be "on ground".
    const catOnGround = catBottom >= SURFACE_Y - 1;

    for (const obs of this._obstacles) {
      const screenX = obs.worldX - scrollPx;
      obs.sprite.x  = screenX;

      const obsLeft  = screenX - obs.hitW / 2;
      const obsRight = screenX + obs.hitW / 2;

      if (
        catOnGround           &&
        catLeft   < obsRight  &&
        catRight  > obsLeft   &&
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

    // ── Flying bird ───────────────────────────────────────────────────────
    this._updateFlyingBird(delta, catLeft, catRight, catTop, catBottom);
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

  /**
   * Manages the independent flying bird lifecycle:
   *   waiting → spawns from left → flies right → exits right → waiting …
   */
  _updateFlyingBird(delta, catLeft, catRight, catTop, catBottom) {
    if (this._flySprite) {
      // Bird is in flight — move it to the right.
      this._flyX       += BIRD_FLY_SPEED * (delta / 1000);
      this._flySprite.x = this._flyX;

      // Collision check (AABB, hitbox centred at flyX / BIRD_FLY_Y).
      const halfW = BIRD_FLY_HIT_W / 2;
      const halfH = BIRD_FLY_HIT_H / 2;
      if (
        catLeft   < this._flyX + halfW          &&
        catRight  > this._flyX - halfW          &&
        catTop    < BIRD_FLY_Y + halfH          &&
        catBottom > BIRD_FLY_Y - halfH
      ) {
        this.collision = true;
      }

      // Bird has exited the right edge — despawn and start the delay timer.
      const halfDisplayW = (128 * BIRD_FLY_SCALE) / 2;
      if (this._flyX - halfDisplayW > CANVAS_W) {
        this._flySprite.destroy();
        this._flySprite = null;
        this._flyTimer  = randDelay();
      }
    } else {
      // Waiting — count down until the next crossing.
      this._flyTimer -= delta;
      if (this._flyTimer <= 0) {
        const halfDisplayW = (128 * BIRD_FLY_SCALE) / 2;
        this._flyX = -halfDisplayW; // start just off the left edge

        this._flySprite = this._scene.add.sprite(
          this._flyX, BIRD_FLY_Y, "bird_fly"
        );
        this._flySprite.setOrigin(0.5, 0.5);
        this._flySprite.setScale(BIRD_FLY_SCALE);
        this._flySprite.setDepth(OBSTACLE_DEPTH);
        this._flySprite.play("bird_fly");
        this._flySprite.setFlipX(false); // sprite naturally faces right (left→right travel)
      }
    }
  }
}
