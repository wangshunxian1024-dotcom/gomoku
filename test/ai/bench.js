/*
 * bench.js — 自对弈强度矩阵（jsc）
 *
 * 运行（工作目录必须是 gomoku/）：
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc test/ai/bench.js
 *
 * 说明：
 *   - 每组 10 局，固定种子，交替先手（奇数局交换先后手，胜负标签会归一化回 A/B）。
 *   - 为了在合理时间内跑完矩阵，master/grandmaster 的预算被压到 600/1200ms（正常默认
 *     是 1800/2400ms），hard 保持 400ms（宗师 vs 困难按 3:1 时间比），其余档位用默认预算。
 *     压缩对强档是同向的，若仍能达标说明实力差距足够。
 *   - 结局保存到 test/ai/bench-results.md（手工/脚本更新）。
 *   - 逐局输出行：胜方 / 手数 / 单步最长耗时 / AI 总耗时。
 */
load('test/ai/harness.js');

var T = GomokuTest;
var C = T.C;

var BUDGET = {
  novice: 60,
  easy: 150,
  normal: 300,
  hard: 400,
  master: 600,
  grandmaster: 1200
};

var GAMES = 10;
var MAX_MOVES = 120;

/* 验收门槛：[A, B, 最少取胜局数] */
var MATRIX = [
  ['master', 'easy', 9],
  ['master', 'novice', 10],
  ['hard', 'easy', 8],
  ['normal', 'novice', 7],
  ['easy', 'novice', 6],
  ['master', 'hard', 6],
  ['grandmaster', 'hard', 9],
  ['grandmaster', 'master', 7]
];

var results = [];
var failed = 0;

for (var m = 0; m < MATRIX.length; m++) {
  var A = MATRIX[m][0];
  var B = MATRIX[m][1];
  var need = MATRIX[m][2];

  print('');
  print('▌ ' + A + '(A) vs ' + B + '(B)  —  ' + GAMES + ' 局，交替先手，预算 ' +
    BUDGET[A] + '/' + BUDGET[B] + 'ms');

  var aWin = 0, bWin = 0, draw = 0;
  var seedBase = 900001 + m * 10007;
  var signatures = {};   // 用来证明 10 局是 10 盘不同的棋，而不是同一盘重复
  var t0 = Date.now();

  for (var g = 0; g < GAMES; g++) {
    var seed = (seedBase + g * 131) >>> 0;
    var r;
    if (g % 2 === 0) {
      // A 执黑
      r = T.playGame(A, B, seed, BUDGET[A], BUDGET[B], { maxMoves: MAX_MOVES, openRandom: 2 });
    } else {
      // B 执黑，之后把胜负标签换算回 A/B
      r = T.playGame(B, A, (seed + 500000) >>> 0, BUDGET[B], BUDGET[A], { maxMoves: MAX_MOVES, openRandom: 2 });
      if (r.winner === 'A') r.winner = 'B';
      else if (r.winner === 'B') r.winner = 'A';
    }

    var sig = r.record.join(',');
    if (!signatures[sig]) signatures[sig] = 0;
    signatures[sig]++;

    var tag;
    if (r.winner === 'draw') { draw++; tag = 'draw'; }
    else if (r.winner === 'A') { aWin++; tag = A + ' 胜'; }
    else if (r.winner === 'B') { bWin++; tag = B + ' 胜'; }
    else { tag = '??'; }

    print('  第 ' + pad(g + 1, 2) + ' 局：' + pad(tag, 10) +
      ' 手数=' + pad(r.moves, 4) +
      ' 最长单步=' + pad(r.maxMs + 'ms', 7) +
      ' AI总耗时=' + pad(r.sumMs + 'ms', 9) +
      (r.illegal ? '  ❌出现非法着法' : ''));
  }

  var elapsed = Date.now() - t0;
  var passed = aWin >= need;
  if (!passed) failed++;

  var uniq = Object.keys(signatures).length;
  var dupNote = uniq < GAMES ? '  ⚠ 只有 ' + uniq + ' 盘不同的棋' : '  10 盘棋各不相同';
  print('  → ' + A + ' 胜 ' + aWin + ' / ' + B + ' 胜 ' + bWin + ' / 和 ' + draw + dupNote +
    '   门槛 ' + A + ' ≥ ' + need + '/10  ' + (passed ? '✅' : '❌') +
    '  用时 ' + (elapsed / 1000).toFixed(1) + 's');

  results.push({ a: A, b: B, need: need, aWin: aWin, bWin: bWin, draw: draw, passed: passed, elapsedMs: elapsed, uniq: uniq });
}

print('');
print('▌ 强度矩阵汇总');
print('');
print('  ' + pad('对局', 24) + pad('成绩', 14) + pad('门槛', 10) + '结果');
print('  ' + new Array(56).join('-'));
for (var i = 0; i < results.length; i++) {
  var R = results[i];
  print('  ' + pad(R.a + ' vs ' + R.b, 24) +
    pad(R.aWin + ' : ' + R.bWin + ' (和' + R.draw + ')', 14) +
    pad(R.aWin + '/' + GAMES + ' ≥ ' + R.need, 10) +
    (R.passed ? '✅' : '❌'));
}

print('');
if (failed === 0) print('✅ 强度矩阵全部达标');
else print('❌ 有 ' + failed + ' 组未达标');

function pad(s, n) {
  s = '' + s;
  while (s.length < n) s += ' ';
  return s;
}
