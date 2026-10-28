# gomoku/test/ai — 五子棋 AI 引擎自测与基准

这里只测 `js/ai.js`（AI 引擎），不依赖 UI。全部用 macOS 自带 JavaScriptCore `jsc` 直接跑，
不需要 node/npm/任何第三方库。

## 运行方式

```bash
cd gomoku
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc

$JSC test/ai/test.js    # 功能自测（约 5~10 秒）
$JSC test/ai/perf.js    # 单步耗时基准（约 10~20 秒）
$JSC test/ai/bench.js   # 自对弈强度矩阵（8 组，约 50 秒）
```

`test.js` / `perf.js` 末尾会打印 `✅/❌` 汇总，退出码不区分成败（jsc 无 process.exit 可靠路径），
以打印结果为准；`bench.js` 只看最后的矩阵表。

## 文件

| 文件 | 作用 |
| --- | --- |
| `harness.js` | 公共测试脚手架：`load` core.js/ai.js、造局面、`playGame`/`match` 自对弈、`syntheticMidgame` 合成中局、断言与计时统计。 |
| `test.js` | 功能自测（181 项）：API 形状与六档中文文案、空盘首手、补五、挡冲四、做/防双活三、合法性、确定性、单步耗时门槛、宗师专项。 |
| `perf.js` | 8 个 30~50 手中局上的单步耗时（默认预算）+ 搜索规模（depth/nodes）。 |
| `bench.js` | 八组 × 10 局自对弈强度矩阵，交替先手、固定种子。 |
| `bench-results.md` | 最近一次实测的完整结果（耗时、矩阵、结论、已知局限）。 |

## AI 引擎内部参数（`js/ai.js` 的 `LEVELS`）

| 难度 | 节点预算 | 最大深度 | 根候选 | 内部候选 | VCF | VCT | 特殊 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| novice 入门 | 600 | 1 | 8 | 8 | — | — | 30% 纯随机 / 成五 95% / 挡四 60% |
| easy 简单 | 1200 | 1 | 10 | 10 | — | — | 深度 1 静态最优 / 10% 随机扰动 |
| normal 普通 | 4000 | 4 | 14 | 11 | — | — | 双威胁扫描 + 对手 VCF/VCT 过滤 |
| hard 困难 | 40000 | 6 | 20 | 13 | 10 层/600 节点 | — | 迭代加深 + TT + 杀手着法 |
| master 大师 | 60000 | 8 | 20 | 13 | 12 层/700 节点 | — | 稳健防守（对手 VCF 检测） |
| grandmaster 宗师 | 60000 | 12 | 16 | 11 | 14 层/800 节点 | 12 层/900 节点，校验深度 8 | VCT 连续威胁搜索 + VCF/VCT 双过滤 + PVS |

节点预算是**确定性**的（按 `timeBudgetMs / 难度默认预算` 线性缩放），不按墙钟停手，
因此“同种子 + 同局面”必然复现同一着法。

## 验收结论（详见 bench-results.md）

- 功能自测 181 项全部通过（含 novice 的 95%/60% 概率属性、宗师专项）。
- 单步耗时远低于门槛（perf.js：master p50 13ms / max 152ms；grandmaster p50 73ms / max 692ms，限额 3000ms）。
  另在 35 个真实中局位置用默认预算压测宗师：p50 223ms / p90 527ms / max 613ms。
- 强度矩阵（每组 10 局真实不同开局，交替先手）：
  master:easy 9:1、master:novice 10:0、hard:easy 9:1、normal:novice 10:0、
  easy:novice 10:0、master:hard 6:4 —— 全部达标，五档单调无倒挂。
- 第 6 档「宗师」：**grandmaster:master 8:2 ✅**；**grandmaster:hard 8:2 ❌（门槛 9/10）**，
  换两组种子复测均为 7:3（合计 22/30）。差距来自宗师执白时的防守深度，详见 `bench-results.md` 第 4.1/6 节。
- 六档统一使用**严格置换表探针**（`ttStrict`）。task-4 曾因把旧的不健全探针改成标准语义，
  导致 master/hard 在同一节点预算下对 easy 的强度倒退；修复方式 = 严格语义 + 上调 hard/master
  节点预算（16000→40000/60000），修复前后同种子对照见 `bench-results.md` 第 5 节。

> 注：`bench.js` 每局前 2 手在中心 7x7 内按种子随机落子。强档引擎本身是确定性的，
> 不这样做的话同色对局会退化成同一盘棋重复 5 次，样本没有统计意义。
> `bench.js` 会自检并打印「10 盘棋各不相同」。
