/*
 * perf.js — 单步耗时基准（jsc，真实默认预算）
 *
 * 运行（工作目录必须是 gomoku/）：
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc test/ai/perf.js
 *
 * 用途：在 30~50 手的真实中局上测每一档的 chooseMove 耗时与搜索规模，
 *       对照验收门槛：
 *         grandmaster ≤ 3000ms / master ≤ 2500ms / hard ≤ 1000ms /
 *         normal ≤ 400ms / easy ≤ 150ms / novice ≤ 150ms
 */
load('test/ai/harness.js');

var T = GomokuTest;
var C = T.C;
var AI = T.AI;
var LEVELS = ['novice', 'easy', 'normal', 'hard', 'master', 'grandmaster'];

var LIMIT = { novice: 150, easy: 150, normal: 400, hard: 1000, master: 2500, grandmaster: 3000 };

/* ---------- 准备 8 个 30~50 手中局 ---------- */
print('▌ 构造中局（30~50 手，局面不烫手：无一步成五点）');
var positions = [];
var need = [32, 36, 40, 44, 34, 38, 42, 46];
for (var tries = 0; tries < 400 && positions.length < need.length; tries++) {
  var target = need[positions.length];
  var pos = T.syntheticMidgame(16, target, 1234567 + tries * 7919);
  if (pos && pos.moveCount >= 30 && pos.moveCount <= 50) positions.push(pos);
}
if (positions.length === 0) {
  print('❌ 无法构造中局局面');
  quit(1);
}
print('    得到 ' + positions.length + ' 个局面：' + positions.map(function (p) { return p.moveCount + '手'; }).join(', '));

/* ---------- 逐档计时 ---------- */
print('');
print('▌ 单步耗时（默认 timeBudgetMs；每档在每个局面测 1 次）');
print('');
var header = '  局面   ' + LEVELS.map(function (k) { return pad(k, 11); }).join('');
print(header);
print('  ' + new Array(header.length + 2).join('-'));

var all = {};
for (var i = 0; i < LEVELS.length; i++) all[LEVELS[i]] = [];

for (var pi = 0; pi < positions.length; pi++) {
  var P = positions[pi];
  var row = '  ' + pad(P.moveCount + '手', 8);
  for (var li = 0; li < LEVELS.length; li++) {
    var key = LEVELS[li];
    var inst = AI.create(key, { seed: 20240521 });
    var t0 = Date.now();
    var mv = inst.chooseMove(P.board, P.player, { moveCount: P.moveCount });
    var ms = Date.now() - t0;
    all[key].push(ms);
    row += pad(ms + 'ms', 11);
    if (!mv) print('❌ ' + key + ' 返回 null');
  }
  print(row);
}

print('');
print('▌ 统计与门槛');
print('');
var failed = 0;
for (var k2 = 0; k2 < LEVELS.length; k2++) {
  var kk = LEVELS[k2];
  var arr = all[kk];
  arr.sort(function (a, b) { return a - b; });
  var max = arr[arr.length - 1];
  var p50 = arr[(arr.length / 2) | 0];
  var avg = arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
  var lim = LIMIT[kk];
  var ok = max <= lim;
  if (!ok) failed++;
  print('  ' + pad(kk, 11) + 'p50=' + pad(p50 + 'ms', 8) + 'avg=' + pad(avg.toFixed(1) + 'ms', 9) +
    'max=' + pad(max + 'ms', 8) + '限额=' + pad(lim + 'ms', 8) + (ok ? '✅' : '❌ 超时'));
}

/* ---------- 搜索规模（节点/深度）---------- */
print('');
print('▌ 搜索规模（取 44 手局面，看迭代加深是否走满）');
var probe = null;
for (i = 0; i < positions.length; i++) if (positions[i].moveCount >= 40) { probe = positions[i]; break; }
if (probe) {
  for (li = 0; li < LEVELS.length; li++) {
    var ii = AI.create(LEVELS[li], { seed: 20240521 });
    var r = ii.chooseMove(probe.board, probe.player, { moveCount: probe.moveCount });
    print('  ' + pad(LEVELS[li], 11) + 'depth=' + pad(r.depth, 3) + ' nodes=' + pad(r.nodes, 7) +
      ' elapsed=' + r.elapsedMs + 'ms  move=(' + r.x + ',' + r.y + ')');
  }
}

print('');
if (failed === 0) print('✅ 性能全部达标');
else print('❌ 有 ' + failed + ' 档超时');

/* ---------- 小工具 ---------- */
function pad(s, n) {
  s = '' + s;
  while (s.length < n) s += ' ';
  return s;
}
