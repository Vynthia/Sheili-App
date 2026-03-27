import Phaser from "phaser";
import GameScene from "./scenes/GameScene.js";

const GAME_WIDTH = 480;
const GAME_HEIGHT = 270;

const config = {
  type: Phaser.AUTO,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: "#1a1a2e",
  parent: "game-container",
  pixelArt: true,
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
