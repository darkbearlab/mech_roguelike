# 機體 Roguelike

日系人形機體、開闊地形、六角格的 roguelike。手機直向瀏覽器優先，TypeScript + Canvas 2D + Vite，零遊戲引擎相依。

**線上版（手機直接開）**：https://darkbearlab.github.io/mech_roguelike/
推到 `main` 就會自動 測試 → 建置 → 部署 → 線上健檢。
（Pages 的 Source 必須是 **GitHub Actions**；選成 *Deploy from a branch* 的話，手機上只會看到白畫面，
頁面 6 秒後會自己跳出說明。）

**設計文件：[`docs/design.md`](docs/design.md)** —— 目前的規則以它為準。
初版規格已封存在 `docs/archive/`，不再作為依據。

## 目前進度：移動手感測試 ＋ 跑道情境

- 整數格移動：機體永遠站在格子中心；速度 = 方向 + 整數速率；機首另外存
- 左盤跟著機首排：往一個方向點幾下就加速幾，中間確認；能點幾下看機首、效果看速度方向
- 右盤：轉向（依機體可能扣速度）、散熱、切換驅動、待機；AP 用完或透支結算就推進回合
- **基礎跑道**（預設地圖）：11 個依序的檢查點（通過／停車），每一步有提示、可掛事件鉤子，
  完賽記回合數與最佳紀錄 —— 之後的新手教學就從這裡長出來
- 四台試驗機（履帶／步行／噴射／步行＋噴射），⚙ 面板即時調所有移動數值、切換地圖
- 地形目前不影響移動；武器、敵人還沒做

### 怎麼試

- 一打開就是**基礎跑道**：上方綠框那一行是下一個檢查點與這一步的提示，綠色區域是目標，
  畫面外的話邊緣會有箭頭指過去；「重跑」回到起點。
- 右上 **⚙**：切換地圖（🏁 跑道／試驗場）、切換試驗機、改數值（面板會算出「幾回合到極速、滑行幾回合停、煞車幾回合停」）。
  改過的值存在手機上；**「複製調整值」**把它變成一段 JSON，貼回來就能寫進 `src/data/`。
- 左盤：點方向（點數用 ●○ 表示）、中間確認；確認鍵上寫著這回合會變成幾速、往哪。
  地圖上：琥珀色是這回合的路徑與落點（圈裡的數字是落地後的速度），虛點是之後不加速會滑到哪；
  機體周圍的小數字是每個方向能點幾下。
- 右盤在位移之後才能按。
- 點地圖看地形與距離；拖曳平移、◎ 回中。
  網址參數 `?map=track_01`（或 `proving_ground`）、`?chassis=jt1`（tk1／wk1／jt1／hy1）、`?seed=123`。
- 桌機：W 前、E 右前、D 右後、S 後、A 左後、Q 左前、空白 確認；← → 轉向、C 散熱、V 切換、Enter 待機。

## 指令

```bash
npm install
npm run dev        # http://localhost:5173（手機同網段可用 --host 顯示的網址開）
npm test           # 規則層、資料檔、分層規則（core/ 不得 import render/ui）
npm run coverage   # 同上，外加 core/ 覆蓋率門檻（行 100%、分支 95%）
npm run typecheck
npm run build
npm run bot        # 無介面自動對局，輸出基線數據
```

## 架構

沿用 PMC 已驗證的分層：

```
src/
  core/        純邏輯。不 import render/ 或 ui/，不碰 DOM、canvas、Math.random（tests/architecture.test.ts 會檢查）
    hex.ts       flat-top axial 座標、cube 距離、方向與相對方向 —— 全專案唯一的一把尺
    rules.ts     讀 data/*.json 成有型別的 Rules、驗證、逐層覆寫（調參面板與 bot 的 A/B 用）
    map.ts       地圖（odd-q 位移座標的逐列字串 → axial）
    state.ts     GameState、Unit、Command、GameEvent
    movement.ts  左盤點數、速度結算、位移 —— 預測與實際走同一段程式碼
    course.ts    跑道：檢查點判定、進度、事件鉤子
    economy.ts   AP 配額、透支、債務、熱量
    order.ts     解算順序模組：目前只有循序制
    engine.ts    回合引擎：checkLegal() / applyCommand() —— 規則層唯一的入口
    nav.ts       導航規劃（bot 與日後的敵人 AI 共用）
    rng.ts       可播種 xoshiro128**
  render/      canvas 繪製、攝影機、位移動畫
  ui/          觸控盤、儀表、調參面板、輸入接線
  data/        drives / chassis / actions / terrain / combat / ui .json、maps/*.json
tests/         core/ 全覆蓋
bot/           無介面自動對局
docs/          design.md（現行設計）、archive/（封存）
```

## bot 基線（`npm run bot`，每台 30 場，種子 1..30）

一場 = 在試驗場上從隨機起點開到 12～24 格外的隨機目標。自動駕駛只用玩家能用的指令。

| 機體 | 抵達率 | 平均回合 | 格/回合 | 熱量峰值 | 撞擊/場 | 勝率 | 命中率 |
|---|---|---|---|---|---|---|---|
| TK-1 陸龜（履帶） | 100% | 7.0 | 2.54 | 1.4 | 0 | — | — |
| WK-1 野犬（步行） | 100% | 9.1 | 1.94 | 2.0 | 0 | — | — |
| JT-1 燕（噴射） | 100% | 5.2 | 3.40 | 8.5 | 0 | — | — |
| HY-1 隼（步行，不切換） | 100% | 9.1 | 1.94 | 2.0 | 0 | — | — |

**情境：基礎跑道**（自動駕駛跑一次；跑道固定，同一份規則永遠跑出同一個結果）

| 機體 | 完賽回合 | 熱量峰值 |
|---|---|---|
| TK-1 陸龜（履帶） | 33 | 2 |
| WK-1 野犬（步行） | 36 | 2 |
| JT-1 燕（噴射） | 24 | 24 |
| HY-1 隼（步行，不切換） | 36 | 2 |

自動駕駛不是最佳路線 —— 這些數字是改數值時的對照基準，不是目標成績。

勝率與命中率要等武器與敵人。CI（`.github/workflows/deploy.yml`）每次 push 到 `main` 都會跑：
型別檢查 → 測試與覆蓋率 → bot 煙霧測試 → 建置 → 部署 → **線上健檢**。
