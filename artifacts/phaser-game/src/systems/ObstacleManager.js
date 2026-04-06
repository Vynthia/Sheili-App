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

// Depth for ALL ground obstacles (cat depth = 20 → cat always behind obstacles).
const OBSTACLE_DEPTH = 30;

// ---------------------------------------------------------------------------
// Ground obstacle type definitions.
//
// `scale`  — display scale (source sprites are 128×128 px).
// `hitW`   — collision box total width  (display px, centred on sprite X).
//            Calibrated to the solid centre column of each sprite, not the
//            full frame width, so the cat is only killed on real contact.
// `hitH`   — collision box total height (display px, measured UP from SURFACE_Y).
//            Must be < 80 so the cat can clear it at jump apex (catBottom≈115).
//            Kept small so obsTop is close to the ground — generous clearance.
//
// Timing windows (catBody ≈ 28 px wide, SCROLL_SPEED = 150 px/s, JUMP_VEL = -380):
//   chimney  scale=0.5 hitW=16 hitH=12  obsTop=183  Y-clear=778ms  X-overlap=293ms  → 485ms
//   antenna  scale=0.4 hitW= 8 hitH=15  obsTop=180  Y-clear=762ms  X-overlap=240ms  → 522ms
//   vent     scale=0.5 hitW=18 hitH=12  obsTop=183  Y-clear=778ms  X-overlap=307ms  → 471ms
//   bird     scale=0.3 hitW=22 hitH=22  obsTop=173  Y-clear=719ms  X-overlap=333ms  → 386ms
// ---------------------------------------------------------------------------
const OBSTACLE_TYPES = [
  { key: "chimney", scale: 0.5,  hitW: 16, hitH: 12 }, // 485 ms timing window
  { key: "antenna", scale: 0.4,  hitW:  8, hitH: 15 }, // 522 ms timing window
  { key: "vent",    scale: 0.5,  hitW: 18, hitH: 12 }, // 471 ms timing window
  { key: "bird",    scale: 0.3,  hitW: 22, hitH: 22 }, // 386 ms timing window
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
// BIRD_FLY_Y = 100.  Cat peak catTop ≈ 102 — hitH 50 → bird Y range [75, 125].
// Overlap at peak: [102, 125] = 23 px.  Cat on ground catTop ≈ 155 > 125 → safe.
const BIRD_FLY_HIT_W = 38;
const BIRD_FLY_HIT_H = 50;

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

      // Hitbox — Y: measured up from SURFACE_Y (small hitH for jumpability).
      const obsTop    = SURFACE_Y - type.hitH;
      const obsBottom = SURFACE_Y;

      // Hitbox — X: anchored to the sprite's left visual edge so collision fires
      // the instant the obstacle's front pixel meets the cat, not after partial
      // overlap.  obsLeftOffset = -(half display width), stored relative to screenX.
      const halfDisplayW   = Math.round(128 * type.scale / 2);
      const obsLeftOffset  = -halfDisplayW;          // = left visual edge
      const obsRightOffset = obsLeftOffset + type.hitW; // = narrow window rightward

      this._obstacles.push({ worldX, sprite, obsLeftOffset, obsRightOffset, obsTop, obsBottom });
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

    // Read cat bounds directly from the Arcade physics body — no offset math,
    // no sprite.y drift.  body.left/right/top/bottom are updated by Phaser each
    // physics step and always reflect the exact collision rectangle.
    const catBody   = catSprite.body;
    const catLeft   = catBody.left;
    const catRight  = catBody.right;
    const catTop    = catBody.top;
    const catBottom = catBody.bottom;

    this.collision = false;

    // ── Ground obstacles ──────────────────────────────────────────────────
    // hitH values are small (12–22 px) so obsTop ≥ 173 px.
    // At jump apex catBottom ≈ 142 px — well above obsTop → no collision.
    // Timing windows: 300–344 ms (see OBSTACLE_TYPES table above).
    for (const obs of this._obstacles) {
      const screenX = obs.worldX - scrollPx;
      obs.sprite.x  = screenX;

      // obsLeftOffset is anchored at the sprite's left visual edge, so collision
      // fires the instant the leading visible pixel reaches the cat's right edge.
      const obsLeft  = screenX + obs.obsLeftOffset;
      const obsRight = screenX + obs.obsRightOffset;

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
      if (obs.worldX - scrollPx + obs.obsRightOffset < 0) {
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
        // Use sprite.displayWidth for the visual bounds — obs.hitW was removed
        // when the hitbox was refactored to obsLeftOffset / obsRightOffset.
        const hasObstacleOnScreen = this._obstacles.some(obs => {
          const sx      = obs.worldX - scrollPx;
          const halfW   = obs.sprite.displayWidth / 2;
          return sx + halfW > 0 && sx - halfW < CANVAS_W;
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
