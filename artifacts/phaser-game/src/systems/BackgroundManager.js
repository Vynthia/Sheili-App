import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Parallax factors: how much each layer moves relative to the world scroll.
// Lower = further away / slower.
// ---------------------------------------------------------------------------
const PARALLAX = {
  sky:         0.04,   // clouds barely drift
  celestial:   0.01,   // moon / sun are almost fixed
  skylineFar:  0.12,
  buildings:   0.30,
  roofsBack:   0.55,
};

// Auto-scroll speed used when there is no gameplay driving the camera.
// Replace with the real world-delta value once the player is moving.
const AUTO_SCROLL_PX_PER_SEC = 80;

// Night sky gradient colour stops (top → bottom).
const NIGHT_GRADIENT = [
  [0.00, "#1e1650"],
  [0.45, "#2d1a88"],
  [0.75, "#4525b0"],
  [1.00, "#5f35cc"],
];

// Day sky gradient colour stops (top → bottom)
const DAY_GRADIENT = [
  [0.00, "#5eaee8"],
  [0.55, "#a8d4f5"],
  [1.00, "#fce4b0"],
];

// All city-layer source images are 1024 px wide.
const CITY_IMG_W = 1024;

// ---------------------------------------------------------------------------

export class BackgroundManager {
  /**
   * @param {Phaser.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this._isNight = true;
    this._create();
  }

  // ── Private: initial object creation ──────────────────────────────────────

  _create() {
    const { width, height } = this.scene.scale;

    // 1. Sky gradient
    this._buildGradientTexture("sky_gradient_night", NIGHT_GRADIENT, width, height);
    this._buildGradientTexture("sky_gradient_day",   DAY_GRADIENT,   width, height);

    this._skyGradientNight = this.scene.add
      .image(0, 0, "sky_gradient_night")
      .setOrigin(0, 0)
      .setDepth(0);

    this._skyGradientDay = this.scene.add
      .image(0, 0, "sky_gradient_day")
      .setOrigin(0, 0)
      .setDepth(0)
      .setAlpha(0);

    // 2. Cloud / star overlay — TileSprites scroll on X only, content is
    //    naturally uniform so any wrap artefact is invisible.
    const SKY_SHIFT_Y = 0; // vertical offset for sky/cloud layer

    this._skyNight = this.scene.add
      .tileSprite(0, SKY_SHIFT_Y, width, 256, "sky_night")
      .setOrigin(0, 0)
      .setDepth(1);

    this._skyDay = this.scene.add
      .tileSprite(0, SKY_SHIFT_Y, width, 256, "sky_day")
      .setOrigin(0, 0)
      .setDepth(1)
      .setAlpha(0);

    // 3. Moon and sun — drift slowly across the upper sky.
    this._moon = this.scene.add
      .image(80, 38, "moon")
      .setOrigin(0.5, 0.5)
      .setDepth(2)
      .setScale(0.6);

    this._sun = this.scene.add
      .image(400, 34, "sun")
      .setOrigin(0.5, 0.5)
      .setDepth(2)
      .setAlpha(0);

    // ── City layers ────────────────────────────────────────────────────────
    //
    // All three city layers (skyline_far, buildings_mid, roofs_back) use
    // TWO manually scrolled Image copies instead of TileSprite.  This avoids
    // the mirror-repeat artefact that Phaser's Canvas TileSprite can produce.
    //
    // Pattern: both copies start side-by-side (x=0 and x=CITY_IMG_W).
    // Each frame both images are moved left by the parallax scroll amount.
    // When a copy's right edge (x + CITY_IMG_W) reaches 0 it is instantly
    // repositioned to the right of the other copy, creating a seamless loop.

    const layerY = height - 256; // 14 px for a 270-tall canvas

    // 4. skyline_far — distant city silhouette.
    //    Start the crop at row 55 (instead of 105) so the skyscraper tops are
    //    revealed higher up in the canvas, then show 170 px of height so the
    //    silhouette extends well behind the buildings_mid layer.
    const SKYLINE_CROP_Y = 0;
    const SKYLINE_CROP_H = 256;
    // Lift the layer 20 px above the canvas top so even more of the tops show.
    const SKYLINE_Y = 0;

    this._skylineFar0 = this.scene.add
      .image(0, SKYLINE_Y, "skyline_far")
      .setOrigin(0, 0)
      .setDepth(3)
      .setCrop(0, SKYLINE_CROP_Y, CITY_IMG_W, SKYLINE_CROP_H);

    this._skylineFar1 = this.scene.add
      .image(CITY_IMG_W, SKYLINE_Y, "skyline_far")
      .setOrigin(0, 0)
      .setDepth(3)
      .setCrop(0, SKYLINE_CROP_Y, CITY_IMG_W, SKYLINE_CROP_H);

    // 5. buildings_mid — apartment facades.
    const BUILDINGS_SHIFT_Y = 40; // vertical offset added on top of layerY

    this._buildings0 = this.scene.add
      .image(0, layerY + BUILDINGS_SHIFT_Y, "buildings_mid")
      .setOrigin(0, 0)
      .setDepth(4);

    this._buildings1 = this.scene.add
      .image(CITY_IMG_W, layerY + BUILDINGS_SHIFT_Y, "buildings_mid")
      .setOrigin(0, 0)
      .setDepth(4);

    // 6. roofs_back — foreground rooftop layer.
    const ROOFS_SHIFT_Y = 35; // vertical offset added on top of layerY

    this._roofsBack0 = this.scene.add
      .image(0, layerY + ROOFS_SHIFT_Y, "roofs_back")
      .setOrigin(0, 0)
      .setDepth(5);

    this._roofsBack1 = this.scene.add
      .image(CITY_IMG_W, layerY + ROOFS_SHIFT_Y, "roofs_back")
      .setOrigin(0, 0)
      .setDepth(5);
  }

  // ── Private: texture helpers ───────────────────────────────────────────────

  /**
   * Bake a vertical linear gradient into a named Phaser canvas texture.
   */
  _buildGradientTexture(key, stops, w, h) {
    if (this.scene.textures.exists(key)) {
      this.scene.textures.remove(key);
    }
    const tex = this.scene.textures.createCanvas(key, w, h);
    const ctx = tex.getContext();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    for (const [pos, colour] of stops) {
      grad.addColorStop(pos, colour);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    tex.refresh();
  }

  /**
   * Helper: scroll two image copies and wrap the one that leaves the left edge.
   * @param {Phaser.GameObjects.Image} img0
   * @param {Phaser.GameObjects.Image} img1
   * @param {number} dx  pixels to move left this frame
   */
  _scrollPair(img0, img1, dx) {
    img0.x -= dx;
    img1.x -= dx;

    if (img0.x + CITY_IMG_W <= 0) {
      img0.x = img1.x + CITY_IMG_W;
    }
    if (img1.x + CITY_IMG_W <= 0) {
      img1.x = img0.x + CITY_IMG_W;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Call every frame from the scene's update().
   *
   * @param {number} delta       Phaser delta time in milliseconds.
   * @param {number} [worldDelta]  Optional: pixels the world scrolled this
   *   frame. Falls back to constant auto-scroll during development.
   */
  update(delta, worldDelta) {
    const scroll =
      worldDelta !== undefined
        ? worldDelta
        : AUTO_SCROLL_PX_PER_SEC * (delta / 1000);

    // Cloud / star layers (TileSprite — uniform content, no visible seam)
    this._skyNight.tilePositionX += scroll * PARALLAX.sky;
    this._skyDay.tilePositionX   += scroll * PARALLAX.sky;

    // Celestial bodies drift horizontally; Y stays fixed.
    const celestialDrift = scroll * PARALLAX.celestial;
    this._moon.x += celestialDrift;
    this._sun.x  += celestialDrift;

    // Wrap moon and sun so they never disappear permanently.
    const { width } = this.scene.scale;
    if (this._moon.x > width + 80) this._moon.x = -80;
    if (this._sun.x  > width + 80) this._sun.x  = -80;

    // City layers — dual-image seamless scroll
    this._scrollPair(this._skylineFar0, this._skylineFar1, scroll * PARALLAX.skylineFar);
    this._scrollPair(this._buildings0,  this._buildings1,  scroll * PARALLAX.buildings);
    this._scrollPair(this._roofsBack0,  this._roofsBack1,  scroll * PARALLAX.roofsBack);
  }

  /**
   * Cross-fade between night and day states.
   * Progress: 0 = fully night, 1 = fully day.
   * @param {number} progress  0 – 1
   */
  setDayNightProgress(progress) {
    const p = Phaser.Math.Clamp(progress, 0, 1);

    this._skyGradientNight.setAlpha(1 - p);
    this._skyGradientDay.setAlpha(p);

    this._skyNight.setAlpha(1 - p);
    this._skyDay.setAlpha(p);

    this._moon.setAlpha(1 - p);
    this._sun.setAlpha(p);

    this._isNight = p < 0.5;
  }
}
