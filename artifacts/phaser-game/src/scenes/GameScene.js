import Phaser from "phaser";

export default class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: "GameScene" });
  }

  preload() {
    // Load your assets here.
    // Example:
    //   this.load.image("player", "assets/player.png");
    //   this.load.tilemapTiledJSON("map", "assets/map.json");
  }

  create() {
    const { width, height } = this.scale;

    this.add
      .text(width / 2, height / 2, "Phaser 3 · Arcade Physics\nReady for your assets", {
        fontSize: "18px",
        color: "#ffffff",
        align: "center",
        lineSpacing: 8,
      })
      .setOrigin(0.5);
  }

  update(_time, _delta) {
    // Game loop runs here every frame.
  }
}
