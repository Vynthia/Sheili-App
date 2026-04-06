// ---------------------------------------------------------------------------
// ObstacleManager — spawns and scrolls rooftop obstacles, and manages the
// independent flying bird that crosses the canvas from left to right.
//
// ── Ground obstacle collision ──────────────────────────────────────────────
// Ground obstacles (chimney, antenna, vent, bird) are Arcade Physics static
// images collected in `this.group` (StaticGroup).  Collision with the cat is
// handled by a physics.add.collider set up in GameScene — no manual AABB.
//
// Hitbox design:
//   Each obstacle body spans the full visual width of the sprite but only the
//   bottom 20 px in height, so the cat can jump clean over the top.
//
//   Cat peak catBottom ≈ 142 px.  obsTop = SURFACE_Y − 20 = 175 px.
//   142 < 175 → cat always clears at apex.
//
//   Offset formula (sprite origin 0.5, 1 at SURFACE_Y, scale s):
//     hitW   = Math.round(128 × s)     — full display width
//     hitH   = 20                       — bottom band only
//     offsetX = 0                       — body centred on sprite
//     offsetY = Math.round(128 × s − 20) — shifts body to base
//
// ── Depths ─────────────────────────────────────────────────────────────────
// Cat depth = 30.  Ground obstacles depth = 20.  Cat always renders in front.
//
// ── Flying bird (bird_fly) ─────────────────────────────────────────────────
// Completely independent of the segment-spawning system.  Managed by manual
// AABB (not a physics group) because it moves continuously across the canvas.
// Sets `this.collision = true` on hit; GameScene restarts on that flag.
// The bird will NOT spawn while any ground obstacle is on screen.
// ---------------------------------------------------------------------------

const SCROLL_SPEED = 150; // px/s — must match PlatformManager
const TILE_W       = 512; // px  — must match PlatformManager
const SURFACE_Y    = 195; // px  — visual ground Y for obstacle sprites

// Depth for ALL ground obstacles (cat depth = 30 → cat always in front).
const OBSTACLE_DEPTH = 20;

// Hitbox height for ALL ground obstacles (display px, from SURFACE_Y upward).
// Must be < 53 so cat can jump over at peak (catBottom_peak ≈ 142).
const HIT_H = 20;

// ---------------------------------------------------------------------------
// Ground obstacle type definitions.
//
// `scale`  — individual display scale (source sprites are 128×128).
//            hitW and offsetY are derived from scale at spawn time:
//              hitW    = Math.round(128 × scale)
//              offsetY = Math.round(128 × scale − HIT_H)
// ---------------------------------------------------------------------------
const OBSTACLE_TYPES = [
  { key: "chimney", scale: 0.7  },
  { key: "antenna", scale: 0.45 },
  { key: "vent",    scale: 0.6  },
  { key: "bird",    scale: 0.4  },
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

const BIRD_FLY_SCALE = 0.4;
const BIRD_FLY_Y     = 100;   // screen Y centre
const BIRD_FLY_SPEED = 80;    // px/s, left → right
const BIRD_FLY_HIT_W = 50;    // collision hitbox width
const BIRD_FLY_HIT_H = 30;    // collision hitbox height
const CANVAS_W       = 480;

const BIRD_FLY_MIN_DELAY = 4000;  // ms
const BIRD_FLY_MAX_DELAY = 10000; // ms
const BIRD_RETRY_DELAY   = 800;   // ms — retry if runway not clear

// ---------------------------------------------------------------------------
// Cat body offsets (used for flying-bird AABB only — ground uses physics).
// ---------------------------------------------------------------------------
const CAT_SCREEN_X          = 80;
const CAT_BODY_LEFT_OFFSET  = -13; // catLeft  = 67
const CAT_BODY_RIGHT_OFFSET =  23; // catRight = 103
const CAT_BODY_TOP_OFFSET   =  6;
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
    this._lastWorldX   = -MIN_SPACING * 2;

    // Physics StaticGroup for all ground obstacles.
    // GameScene wires a physics.add.collider against this.group.
    this.group = scene.physics.add.staticGroup();

    // Internal list of { worldX, sprite } for position updates & recycling.
    this._obstacles = [];

    // Flying bird state — collision via manual AABB.
    this.collision  = false;
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
      const screenX  = worldX - scrollPx;

      // ── Create physics static image ────────────────────────────────────
      const sprite = this.group.create(screenX, SURFACE_Y, type.key);
      sprite.setOrigin(0.5, 1);
      sprite.setScale(type.scale);
      sprite.setDepth(OBSTACLE_DEPTH);

      // Hitbox: full visual width, HIT_H px tall at the very base.
      const hitW    = Math.round(128 * type.scale);
      const offsetY = Math.round(128 * type.scale - HIT_H);
      sprite.body.setSize(hitW, HIT_H);
      sprite.body.setOffset(0, offsetY);
      sprite.refreshBody();

      this._obstacles.push({ worldX, sprite });
      this._lastWorldX = worldX;
      placed++;
    }
  }

  /**
   * Advance all obstacles and the flying bird.
   * Only the flying bird sets `this.collision` — ground obstacle collision is
   * handled by the physics collider registered in GameScene.
   *
   * @param {number}                    delta
   * @param {Phaser.GameObjects.Sprite} catSprite
   */
  update(delta, catSprite) {
    this._scrollOffset += SCROLL_SPEED * (delta / 1000);
    const scrollPx = Math.round(this._scrollOffset);

    this.collision = false;

    // ── Ground obstacles — position update ────────────────────────────────
    for (const obs of this._obstacles) {
      const screenX = obs.worldX - scrollPx;
      // Move the sprite and refresh the static body so the physics engine
      // sees the updated position in the next collision check.
      obs.sprite.setPosition(screenX, SURFACE_Y);
      obs.sprite.refreshBody();
    }

    // Recycle obstacles that have scrolled fully off the left edge.
    while (this._obstacles.length > 0) {
      const obs = this._obstacles[0];
      const screenX = obs.worldX - scrollPx;
      const halfW   = obs.sprite.displayWidth / 2;
      if (screenX + halfW < 0) {
        obs.sprite.destroy();
        this._obstacles.shift();
      } else {
        break;
      }
    }

    // ── Flying bird (manual AABB) ─────────────────────────────────────────
    const catLeft   = CAT_SCREEN_X + CAT_BODY_LEFT_OFFSET;
    const catRight  = CAT_SCREEN_X + CAT_BODY_RIGHT_OFFSET;
    const catTop    = catSprite.y  + CAT_BODY_TOP_OFFSET;
    const catBottom = catSprite.y  + CAT_BODY_BOTTOM_OFFSET;
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

      // Despawn when the bird exits the right edge.
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
          const screenX = obs.worldX - scrollPx;
          const halfW   = obs.sprite.displayWidth / 2;
          return screenX + halfW > 0 && screenX - halfW < CANVAS_W;
        });

        if (hasObstacleOnScreen) {
          this._flyTimer = BIRD_RETRY_DELAY;
          return;
        }

        const halfDisplayW = (128 * BIRD_FLY_SCALE) / 2;
        this._flyX = -halfDisplayW;

        this._flySprite = this._scene.add.sprite(
          this._flyX, BIRD_FLY_Y, "bird_fly"
        );
        this._flySprite.setOrigin(0.5, 0.5);
        this._flySprite.setScale(BIRD_FLY_SCALE);
        this._flySprite.setDepth(OBSTACLE_DEPTH);
        this._flySprite.play("bird_fly");
        this._flySprite.setFlipX(false);
      }
    }
  }
}
