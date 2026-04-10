import Phaser from "phaser";
import GameScene from "./scenes/GameScene.js";

const GAME_WIDTH = 480;
const GAME_HEIGHT = 270;

const config = {
  // Canvas renderer: defers pixel scaling directly to the browser's
  // image-rendering CSS property — the most reliable path for pixel art.
  // WebGL applies its own texture filtering; Canvas skips that layer entirely.
  type: Phaser.CANVAS,

  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: "#1a1a2e",
  parent: "game-container",

  render: {
    // Disable all forms of anti-aliasing.
    antialias: false,
    antialiasGL: false,

    // Snap every sprite and tile to whole pixels.
    // Prevents sub-pixel drift when positions are fractional floats.
    roundPixels: true,

    // Shorthand that sets antialias:false + roundPixels:true and also
    // marks every loaded texture with NEAREST filter (no blending).
    pixelArt: true,

    // Prefer discrete GPU where available for stable frame pacing.
    powerPreference: "high-performance",
  },

  fps: {
    // Target 60 fps; limit prevents uncapped loops burning CPU on fast screens.
    target: 60,
    limit: 60,
    // smoothStep is intentionally OFF.
    //
    // Phaser's smoothStep averages delta time using an exponential moving
    // average that starts from smoothDelta=0.  This causes the first ~20
    // frames to receive a near-zero delta, making the game run in slow
    // motion at startup before gradually accelerating to normal speed.
    //
    // GameScene.update() caps every delta at MAX_DELTA_MS=50ms instead,
    // which handles real first-frame spikes without the warm-up lag.
    smoothStep: false,
  },

  physics: {
    default: "arcade",
    arcade: {
      gravity: { y: 0 },
      debug: false,
    },
  },

  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },

  scene: [GameScene],
};

new Phaser.Game(config);
