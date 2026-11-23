# 炸弹乱斗 (Bomb Brawl)

泡泡堂 / 炸弹人风格的 3D 俯视角网格对战网页游戏，基于 Vite + Three.js (WebGPU / WebGL2 + TSL) 构建。

- **在线试玩**：https://leolemon777.github.io/bomber-arena/

## 操作方式

- **电脑端**：`WASD` 或 方向键 移动，`空格` 放置炸弹，`Esc` 暂停
- **移动端**：左手虚拟摇杆移动，右手按钮放置炸弹

## 玩法说明

- 1 名玩家对抗 3 名 AI 机器人，15×13 竞技场，每局 3 分钟，最后存活者获胜。
- 炸开橙色木箱有几率掉落 3 种强化道具：
  - 炸弹数量 +1
  - 火焰射程 +1
  - 移动速度 +1
- 炸弹之间支持十字火焰连锁引爆。

## 本地开发

```bash
npm install
npm run dev
npm run build
```
