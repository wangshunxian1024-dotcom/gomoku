/*
 * test.js — 五子棋 AI 引擎功能自测（jsc，六档：五档 + 宗师）
 *
 * 运行（工作目录必须是 gomoku/）：
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc test/ai/test.js
 *
 * 覆盖：
 *   1. API 形状与六档中文文案（含原有五档不回退）
 *   2. 空盘首手（master/grandmaster 天元；其余中心 5x5）
 *   3. 战术：补五成五（各档）
 *   4. 战术：挡对手冲四（easy 及以上 100%）
 *   5. 双威胁：主动做双活三（normal 及以上）
 *   6. 双威胁：防住对手双活三（normal 及以上）
 *   7. 合法性 + 确定性
 *   8. 单步耗时（真实预算，master ≤2500ms、grandmaster ≤3000ms）
 *   9. 宗师档专项（VCT/超深搜索参数、文案、必胜识别）
 */
load('test/ai/harness.js');

var T = GomokuTest;
var C = T.C;
var AI = T.AI;
var LEVELS = ['novice', 'easy', 'normal', 'hard', 'master', 'grandmaster'];
var STRONG = ['normal', 'hard', 'master', 'grandmaster'];   // normal 及以上

var CN = /[\u4e00-\u9fa5]/;

/* ================================================================== *
 * 1. API 形状与文案
 * ================================================================== */
T.section('1. API 形状与六档中文文案');

T.ok(AI.VERSION === '1.0.0', 'GomokuAI.VERSION === 1.0.0', AI.VERSION);
T.ok(typeof AI.create === 'function', 'GomokuAI.create 是函数');

var keys = AI.DIFFICULTY_KEYS || LEVELS;
T.ok(keys.length === 6, '六档难度（五档 + 宗师）', keys.join(','));

for (var i = 0; i < LEVELS.length; i++) {
  var k = LEVELS[i];
  var d = AI.DIFFICULTIES[k];
  T.ok(!!d, 'DIFFICULTIES.' + k + ' 存在');
  T.ok(d.key === k, 'DIFFICULTIES.' + k + '.key 与键一致');
  T.ok(CN.test(d.label), 'DIFFICULTIES.' + k + '.label 是中文', d.label);
  T.ok(d.stars === i + 1, 'DIFFICULTIES.' + k + '.stars 递增', d.stars);
  T.ok(typeof d.emoji === 'string' && d.emoji.length > 0, 'DIFFICULTIES.' + k + '.emoji 非空');
  T.ok(CN.test(d.desc) && d.desc.length > 6, 'DIFFICULTIES.' + k + '.desc 是中文描述');
  T.ok(typeof d.budgetMs === 'number' && d.budgetMs > 0, 'DIFFICULTIES.' + k + '.budgetMs 为正数', d.budgetMs);
}

var labels = LEVELS.map(function (k) { return AI.DIFFICULTIES[k].label; }).join('/');
T.ok(labels === '入门/简单/普通/困难/大师/宗师', '六档中文标签顺序正确', labels);

var inst = AI.create('hard', { seed: 12345 });
T.ok(inst.key === 'hard', 'create 返回实例 key');
T.ok(inst.label === '困难', '实例 label 正确', inst.label);
T.ok(typeof inst.chooseMove === 'function', '实例有 chooseMove');
T.ok(typeof inst.reset === 'function', '实例有 reset');
T.ok(AI.create('不存在的难度').key === 'normal', '未知难度回落到 normal');

// 原有五档的 key/label/stars/budgetMs 保持不变（新增宗师不得改动老档位）
var OLD_FIVE = [
  ['novice', '入门', 1, 60],
  ['easy', '简单', 2, 150],
  ['normal', '普通', 3, 350],
  ['hard', '困难', 4, 800],
  ['master', '大师', 5, 1800]
];
for (i = 0; i < OLD_FIVE.length; i++) {
  var of = OLD_FIVE[i];
  var od = AI.DIFFICULTIES[of[0]];
  T.ok(od.key === of[0] && od.label === of[1] && od.stars === of[2] && od.budgetMs === of[3],
    '原五档 ' + of[0] + ' 的文案/星级/预算未变', od.label + '/' + od.stars + '/' + od.budgetMs);
}
T.ok(inst.chooseMove(new Uint8Array(10), 1, {}) === null, '棋盘长度不对时返回 null');

/* ================================================================== *
 * 2. 空盘首手
 * ================================================================== */
T.section('2. 空盘首手');

var emptyBoard = C.createBoard();
var masterFirst = AI.create('master', { seed: 20240521 }).chooseMove(emptyBoard, 1, { moveCount: 0 });
T.ok(!!masterFirst && masterFirst.x === 7 && masterFirst.y === 7,
  'master 空盘下天元 (7,7)', masterFirst && T.nmOf(masterFirst));
var gmFirst = AI.create('grandmaster', { seed: 20240521 }).chooseMove(emptyBoard, 1, { moveCount: 0 });
T.ok(!!gmFirst && gmFirst.x === 7 && gmFirst.y === 7,
  'grandmaster 空盘下天元 (7,7)', gmFirst && T.nmOf(gmFirst));

for (i = 0; i < LEVELS.length; i++) {
  for (var s = 1; s <= 5; s++) {
    var mv = AI.create(LEVELS[i], { seed: s }).chooseMove(emptyBoard, 1, { moveCount: 0 });
    var inCenter = !!mv && mv.x >= 5 && mv.x <= 9 && mv.y >= 5 && mv.y <= 9;
    T.ok(inCenter, LEVELS[i] + ' 空盘首手在中心 5x5 (seed=' + s + ')', mv && T.nmOf(mv));
  }
}

/* ================================================================== *
 * 3. 战术：补五成五
 *    黑已有 4 连，只有 C3(2,2) 一个成五点（另一端已有白子）
 * ================================================================== */
T.section('3. 战术：补五成五');

var fiveStones = [
  [3, 2, 1], [4, 2, 1], [5, 2, 1], [6, 2, 1],   // 黑四连 D3..G3
  [7, 2, 2],                                      // 白堵右端 → 唯一成五点是 C3(2,2)
  [0, 10, 2], [12, 12, 2], [8, 12, 2]
];
var fiveBoard = T.mkBoard(fiveStones);
var fivePoint = 'C3';

for (i = 0; i < LEVELS.length; i++) {
  var k2 = LEVELS[i];
  var hits = 0, tries = (k2 === 'novice') ? 10 : 3;
  for (s = 1; s <= tries; s++) {
    var r = T.pickMove(k2, fiveBoard, 1, { seed: s * 31 });
    if (r.mv && T.nmOf(r.mv) === fivePoint) hits++;
  }
  if (k2 === 'novice') {
    T.ok(hits >= Math.ceil(tries * 0.9), 'novice 有立即成五必下（≥90%）', hits + '/' + tries);
  } else {
    T.ok(hits === tries, k2 + ' 有立即成五 100% 必下', hits + '/' + tries);
  }
}

/* ================================================================== *
 * 4. 战术：挡对手冲四
 *    白有 4 连，黑必须堵唯一成五点 C3(2,2)
 * ================================================================== */
T.section('4. 战术：挡对手冲四');

var blockStones = [
  [3, 2, 2], [4, 2, 2], [5, 2, 2], [6, 2, 2],   // 白四连
  [7, 2, 1],                                      // 黑已堵右端 → 白唯一成五点是 C3
  [1, 10, 1], [12, 12, 1], [8, 12, 1]
];
var blockBoard = T.mkBoard(blockStones);

for (i = 0; i < LEVELS.length; i++) {
  var k3 = LEVELS[i];
  if (k3 === 'novice') continue;                  // 入门允许漏挡
  var bh = 0, bt = 4;
  for (s = 1; s <= bt; s++) {
    var rb = T.pickMove(k3, blockBoard, 1, { seed: s * 97 });
    if (rb.mv && T.nmOf(rb.mv) === fivePoint) bh++;
  }
  T.ok(bh === bt, k3 + ' 100% 挡对手冲四', bh + '/' + bt);
}

/* ================================================================== *
 * 5. 双威胁：主动做双活三
 *    H8(7,7) 同时形成 横 (F8,G8,H8) 与 竖 (H6,H7,H8) 两个活三
 * ================================================================== */
T.section('5. 双威胁：主动做双活三');

var make1 = [
  [5, 7, 1], [6, 7, 1],        // 黑 F8 G8（横）
  [7, 5, 1], [7, 6, 1],        // 黑 H6 H7（竖）
  [8, 8, 2], [4, 4, 2], [10, 10, 2], [2, 2, 2]
];
var make2 = [
  [5, 5, 1], [6, 6, 1],        // 黑 对角
  [5, 9, 1], [6, 8, 1],        // 黑 反对角
  [10, 2, 2], [3, 11, 2], [12, 4, 2], [2, 13, 2]
];
var makeCases = [
  { name: '横竖双活三', stones: make1, expect: ['H8'] },
  { name: '对角双活三', stones: make2, expect: ['H8'] }
];

for (i = 0; i < makeCases.length; i++) {
  var mc = makeCases[i];
  var mb = T.mkBoard(mc.stones);
  for (var j = 0; j < STRONG.length; j++) {
    var r2 = T.pickMove(STRONG[j], mb, 1, { seed: 7 });
    var nm2 = r2.mv ? T.nmOf(r2.mv) : '-';
    T.ok(mc.expect.indexOf(nm2) >= 0, STRONG[j] + ' 能做出「' + mc.name + '」', nm2 + ' score=' + Math.round(r2.mv.score));
  }
}

/* ================================================================== *
 * 6. 双威胁：防住对手双活三
 *    黑棋全是孤立无害子；白只要在 P 点落子就是双活三，黑必须处理 P 或它的两个三的端点
 * ================================================================== */
T.section('6. 双威胁：防住对手双活三');

var def1 = [
  [5, 1, 2], [5, 2, 2],        // 白竖 F1,F2
  [3, 3, 2], [4, 3, 2],        // 白横 C3,D3   → P=F4(5,3) 同时做出两个活三
  [10, 12, 1], [12, 10, 1], [0, 0, 1], [14, 14, 1]
];
var def2 = [
  [5, 5, 2], [6, 6, 2],        // 白对角
  [5, 9, 2], [6, 8, 2],        // 白反对角  → P=H8(7,7)
  [10, 12, 1], [3, 0, 1], [0, 14, 1], [14, 0, 1]
];
var defCases = [
  { name: '横竖双活三', stones: def1, expect: ['F4', 'C4', 'G4', 'F1', 'F5'] },
  { name: '对角双活三', stones: def2, expect: ['H8', 'G8', 'E7', 'H9', 'E9', 'G10', 'H7'] }
];

for (i = 0; i < defCases.length; i++) {
  var dc = defCases[i];
  var db = T.mkBoard(dc.stones);
  for (var j2 = 0; j2 < STRONG.length; j2++) {
    var r3 = T.pickMove(STRONG[j2], db, 1, { seed: 11 });
    var nm3 = r3.mv ? T.nmOf(r3.mv) : '-';
    T.ok(dc.expect.indexOf(nm3) >= 0, STRONG[j2] + ' 能防住对手「' + dc.name + '」', nm3 + ' score=' + Math.round(r3.mv.score));
  }
}

/* ================================================================== *
 * 7. 合法性 + 确定性
 * ================================================================== */
T.section('7. 合法性 + 确定性');

// 7.1 自对弈过程中每手都必须合法
for (i = 0; i < LEVELS.length; i++) {
  var res = T.playGame(LEVELS[i], LEVELS[(i + 2) % LEVELS.length], 4000 + i, 120, 120, { maxMoves: 60 });
  T.ok(!res.illegal, LEVELS[i] + ' 自对弈 60 手内无非法着法', res.winner + '/' + res.moves);
}

// 7.2 随机局面合法性：用快速自对弈造 12 个中局，每档都要返回空点
var boards = [];
for (i = 0; i < 40 && boards.length < 12; i++) {
  // 用两档对弈造中局；对局提前分出胜负就换种子重来
  var target = 14 + (boards.length % 8) * 2;
  var pos = T.syntheticMidgame(14, target, 90000 + i * 13);
  if (pos) boards.push(pos);
}
T.ok(boards.length >= 8, '构造出足够的中局局面', boards.length);

var legalBad = 0, legalTotal = 0;
for (i = 0; i < boards.length; i++) {
  var pos2 = boards[i];
  for (var li = 0; li < LEVELS.length; li++) {
    var rr = AI.create(LEVELS[li], { seed: 1234 + li }).chooseMove(pos2.board, pos2.player, { moveCount: pos2.moveCount });
    legalTotal++;
    var legal = !!rr && rr.x >= 0 && rr.x < 15 && rr.y >= 0 && rr.y < 15 && pos2.board[T.idx(rr.x, rr.y)] === 0;
    if (!legal) legalBad++;
  }
}
T.ok(legalBad === 0, '所有中局 × 五档返回的着法都合法', 'bad=' + legalBad + '/' + legalTotal);

// 7.3 确定性：同实例同局面连续两次一致
var detFail = 0;
for (i = 0; i < boards.length; i++) {
  var p3 = boards[i];
  for (li = 0; li < LEVELS.length; li++) {
    var same = AI.create(LEVELS[li], { seed: 777 });
    var a1 = same.chooseMove(p3.board, p3.player, { moveCount: p3.moveCount });
    var a2 = same.chooseMove(p3.board, p3.player, { moveCount: p3.moveCount });
    if (!a1 || !a2 || a1.x !== a2.x || a1.y !== a2.y) detFail++;
  }
}
T.ok(detFail === 0, '同一实例同一局面两次结果一致', 'fail=' + detFail);

// 7.4 两个同种子实例结果一致
var detFail2 = 0;
for (i = 0; i < boards.length; i++) {
  var p4 = boards[i];
  for (li = 0; li < LEVELS.length; li++) {
    var x1 = AI.create(LEVELS[li], { seed: 424242 }).chooseMove(p4.board, p4.player, { moveCount: p4.moveCount });
    var x2 = AI.create(LEVELS[li], { seed: 424242 }).chooseMove(p4.board, p4.player, { moveCount: p4.moveCount });
    if (!x1 || !x2 || x1.x !== x2.x || x1.y !== x2.y) detFail2++;
  }
}
T.ok(detFail2 === 0, '同种子的两个实例结果一致', 'fail=' + detFail2);

// 7.5 reset(seed) 后可继续使用
var ri = AI.create('master', { seed: 1 });
ri.chooseMove(boards[0].board, boards[0].player, { moveCount: boards[0].moveCount });
ri.reset(999);
var afterReset = ri.chooseMove(boards[0].board, boards[0].player, { moveCount: boards[0].moveCount });
T.ok(!!afterReset && boards[0].board[T.idx(afterReset.x, afterReset.y)] === 0, 'reset(seed) 后仍返回合法着法');

/* ================================================================== *
 * 8. 单步耗时（真实预算，默认 timeBudgetMs）
 * ================================================================== */
T.section('8. 单步耗时（真实预算）');

var budget = { novice: 60, easy: 150, normal: 350, hard: 800, master: 1800, grandmaster: 2400 };
var limit = { novice: 150, easy: 150, normal: 400, hard: 1000, master: 2500, grandmaster: 3000 };

// 30~50 手的真实中局（强弱对拖才能走这么长）
var midBoards = [];
for (i = 0; i < 60 && midBoards.length < 3; i++) {
  var mpos = T.syntheticMidgame(18, 32 + (midBoards.length % 5) * 4, 70000 + i * 23);
  if (mpos && mpos.moveCount >= 30 && mpos.moveCount <= 50) midBoards.push(mpos);
}
T.ok(midBoards.length >= 1, '构造出 30~50 手的中局', midBoards.length);

for (i = 0; i < midBoards.length; i++) {
  var pos5 = midBoards[i];
  if (pos5.moveCount < 30 || pos5.moveCount > 50) continue;
  var times = {};
  for (li = 0; li < LEVELS.length; li++) {
    var one = AI.create(LEVELS[li], { seed: 20240521 });
    var t0 = Date.now();
    var mv5 = one.chooseMove(pos5.board, pos5.player, { moveCount: pos5.moveCount });
    times[LEVELS[li]] = Date.now() - t0;
    T.ok(!!mv5, LEVELS[li] + ' 中局(' + pos5.moveCount + '手) 返回着法');
  }
  print('    中局 ' + pos5.moveCount + ' 手：' +
    LEVELS.map(function (k) { return k + '=' + times[k] + 'ms'; }).join('  '));
  for (li = 0; li < LEVELS.length; li++) {
    T.ok(times[LEVELS[li]] <= limit[LEVELS[li]],
      LEVELS[li] + ' 单步耗时 ≤ ' + limit[LEVELS[li]] + 'ms', times[LEVELS[li]] + 'ms');
  }
  // 每个中局都测（详细统计见 perf.js）
}

/* ================================================================== *
 * 9. 宗师档专项
 * ================================================================== */
T.section('9. 宗师档（grandmaster）专项');

var gmd = AI.DIFFICULTIES.grandmaster;
T.ok(gmd.label === '宗师', '宗师 label', gmd.label);
T.ok(gmd.stars === 6, '宗师 stars=6（比大师多一星）', gmd.stars);
T.ok(gmd.emoji === '🔥', '宗师 emoji=🔥', gmd.emoji);
T.ok(gmd.budgetMs === 2400, '宗师 budgetMs=2400', gmd.budgetMs);
T.ok(/[\u4e00-\u9fa5]/.test(gmd.desc) && gmd.desc.indexOf('VCT') >= 0, '宗师 desc 提到 VCT', gmd.desc);

var gmc = AI._levels.grandmaster;
T.ok(gmc.nodes >= 50000, '宗师节点预算 ≥ 50000', gmc.nodes);
T.ok(gmc.maxDepth >= 10, '宗师最大深度 ≥ 10', gmc.maxDepth);
T.ok(gmc.rootN >= 14 && gmc.rootN <= 24, '宗师 rootN 在 14~24', gmc.rootN);
T.ok(gmc.candN >= 11, '宗师 candN ≥ 11', gmc.candN);
T.ok(gmc.vcfDepth >= 12, '宗师 VCF 深度 ≥ 12', gmc.vcfDepth);
T.ok(gmc.defense === true, '宗师开启威胁防守');
T.ok(gmc.vctDepth > 0 && gmc.vctNodes > 0, '宗师开启 VCT（连续威胁算杀）', gmc.vctDepth + '/' + gmc.vctNodes);
T.ok(gmc.pvs === true, '宗师开启 PVS 主变例搜索');

// 宗师能立刻识别“补五成五”为必胜分（score 接近 WIN_SCORE）
var gmWin = T.pickMove('grandmaster', fiveBoard, 1, { seed: 20240521 });
T.ok(gmWin.mv && T.nmOf(gmWin.mv) === fivePoint, '宗师补五成五', gmWin.mv ? T.nmOf(gmWin.mv) : '-');
T.ok(gmWin.mv && gmWin.mv.score >= 1e7, '宗师把成五识别为必胜分', gmWin.mv ? Math.round(gmWin.mv.score) : '-');

// 宗师能做出双活三（VCT 的直接素材）
var gmMake = T.pickMove('grandmaster', T.mkBoard(make1), 1, { seed: 7 });
T.ok(gmMake.mv && T.nmOf(gmMake.mv) === 'H8', '宗师能做出横竖双活三', gmMake.mv ? T.nmOf(gmMake.mv) : '-');

// 宗师对“对手冲四”100% 防守（blockBoard 唯一成五点 C3）
var gmBlock = 0;
for (s = 1; s <= 4; s++) {
  var gmB = T.pickMove('grandmaster', blockBoard, 1, { seed: s * 53 });
  if (gmB.mv && T.nmOf(gmB.mv) === fivePoint) gmBlock++;
}
T.ok(gmBlock === 4, '宗师 100% 挡对手冲四', gmBlock + '/4');

var failed = T.summary('test.js 功能自测');
if (failed > 0) {
  print('');
  print('❌ 有 ' + failed + ' 项未通过');
} else {
  print('');
  print('✅ 全部功能测试通过');
}
