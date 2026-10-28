/*!
 * test/core.js — 规则核心与分享编码自测（JavaScriptCore 直接运行，不需要 node）
 *
 * 运行：
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc test/core.js
 *
 * 失败会抛出异常并以非 0 退出码结束，便于 CI / 脚本判断。
 */
'use strict';

load('js/core.js');

var C = GomokuCore;
var passed = 0;
var failed = 0;
var failures = [];

function ok(cond, name, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name + (detail ? '  → ' + detail : ''));
  }
}

function eq(actual, expected, name) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  ok(a === e, name, '实际 ' + a + '，期望 ' + e);
}

/* ------------------------------------------------------------------ *
 * 1. 常量与坐标
 * ------------------------------------------------------------------ */
eq(C.SIZE, 15, '棋盘 15x15');
eq(C.N, 225, '总格数 225');
eq(C.EMPTY, 0, '空 = 0');
eq(C.BLACK, 1, '黑 = 1');
eq(C.WHITE, 2, '白 = 2');
eq(C.idx(0, 0), 0, 'idx(0,0)=0');
eq(C.idx(14, 14), 224, 'idx(14,14)=224');
eq(C.idx(3, 4), 4 * 15 + 3, 'idx(x,y)=y*15+x');
eq(C.playerAt(0), C.BLACK, '第 1 手黑先');
eq(C.playerAt(1), C.WHITE, '第 2 手白');
eq(C.opponent(C.BLACK), C.WHITE, 'opponent(黑)=白');
eq(C.coordName(7, 7), 'H8', 'coordName(7,7)=H8');
eq(C.coordName(0, 14), 'A15', 'coordName(0,14)=A15');
eq(C.coordName(-1, 0), '??', '越界坐标返回 ??');
eq(C.parseIntCoord('H8'), { x: 7, y: 7 }, 'parseIntCoord(H8)');
eq(C.parseIntCoord('o15'), { x: 14, y: 14 }, 'parseIntCoord 小写 o15');
eq(C.parseIntCoord('P1'), null, '非法列 P 拒绝');
eq(C.parseIntCoord('A16'), null, '非法行 16 拒绝');
eq(C.isInBounds(0, 0), true, '左上角在界内');
eq(C.isInBounds(14, 14), true, '右下角在界内');
eq(C.isInBounds(-1, 0), false, '负坐标越界');
eq(C.isInBounds(15, 0), false, 'x=15 越界');

/* ------------------------------------------------------------------ *
 * 2. 落子与胜负判定（>=5 连均算胜）
 * ------------------------------------------------------------------ */
function boardWith(cells, player) {
  var b = C.createBoard();
  for (var i = 0; i < cells.length; i++) b[C.idx(cells[i][0], cells[i][1])] = player || C.BLACK;
  return b;
}

var b = boardWith([[3, 7], [4, 7], [5, 7], [6, 7], [7, 7]]);
var w = C.checkWin(b, 7, 7);
ok(w !== null && w.player === C.BLACK, '横向五连判胜');
eq(w && w.dir, [1, 0], '横向 dir=[1,0]');
eq(w && w.cells.length, 5, '横向 cells 长度 5');

b = boardWith([[7, 2], [7, 3], [7, 4], [7, 5], [7, 6]]);
ok(C.checkWin(b, 7, 6) !== null, '纵向五连判胜');

b = boardWith([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
ok(C.checkWin(b, 3, 3) !== null, '主对角线五连判胜');

b = boardWith([[5, 1], [4, 2], [3, 3], [2, 4], [1, 5]]);
ok(C.checkWin(b, 3, 3) !== null, '副对角线五连判胜');

b = boardWith([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
w = C.checkWin(b, 2, 2);
ok(w !== null && w.cells.length === 6, '长连（六连）也判胜且完整返回');

b = boardWith([[3, 7], [4, 7], [5, 7], [6, 7]]);
eq(C.checkWin(b, 6, 7), null, '四连不算胜');

b = boardWith([[3, 7], [4, 7], [6, 7], [7, 7]]);
eq(C.checkWin(b, 7, 7), null, '中间有空隙不算五连');

eq(C.checkWin(C.createBoard(), 7, 7), null, '空点不判胜');
eq(C.checkWin(C.createBoard(), 99, 99), null, '越界坐标不判胜（不崩溃）');

/* ------------------------------------------------------------------ *
 * 3. replay：正常、非法、平局
 * ------------------------------------------------------------------ */
var moves = [];
function add(x, y) { moves.push({ x: x, y: y }); }
add(7, 7); add(0, 0); add(8, 8); add(1, 1); add(9, 9); add(2, 2); add(10, 10); add(3, 3); add(11, 11);

var r = C.replay(moves);
eq(r.ok, true, 'replay 合法棋谱 ok');
eq(r.moveCount, 9, 'replay 手数 9');
eq(r.winner, C.BLACK, 'replay 黑胜');
eq(r.finished, true, 'replay finished');
eq(r.turn, 0, '结束后 turn=0');
eq(r.winLine.length, 5, 'winLine 5 子');
eq(r.board[C.idx(7, 7)], C.BLACK, 'replay 复原黑子');
eq(r.board[C.idx(0, 0)], C.WHITE, 'replay 复原白子');

r = C.replay([{ x: 7, y: 7 }, { x: 7, y: 7 }]);
eq(r.ok, false, '重复落子被拒绝');

r = C.replay([{ x: 15, y: 0 }]);
eq(r.ok, false, '越界落子被拒绝');

r = C.replay([{ x: 0, y: 0 }]);
eq(r.ok, true, '单子合法');
eq(r.turn, C.WHITE, '单子后轮到白');

// 五连之后追加着法非法
moves = [];
add(7, 7); add(0, 0); add(8, 8); add(1, 1); add(9, 9); add(2, 2); add(10, 10); add(3, 3); add(11, 11); add(12, 12);
r = C.replay(moves);
eq(r.ok, false, '已分胜负后继续落子被拒绝');

// isFull / 满盘（平局判定依赖 isFull，这里直接单测）
var fullBoard = C.createBoard();
for (var fi = 0; fi < C.N; fi++) fullBoard[fi] = (fi % 2) + 1;
eq(C.isFull(C.createBoard()), false, '空盘未满');
eq(C.isFull(fullBoard), true, '填满后 isFull=true');
eq(C.countStones(fullBoard), 225, 'countStones(fullBoard)=225');
eq(C.countStones(C.createBoard()), 0, 'countStones(空盘)=0');

/* ------------------------------------------------------------------ *
 * 4. 分享编码 / 解码
 * ------------------------------------------------------------------ */
var state = {
  moves: [{ x: 7, y: 7 }, { x: 8, y: 7 }, { x: 0, y: 14 }],
  difficulty: 'hard',
  mode: 'pvp',
  humanColor: C.WHITE
};
var hash = C.encodeState(state);
ok(/^g1\.[A-Za-z0-9_-]+$/.test(hash), '编码格式 g1.[base64url]', hash);
ok(hash.charAt(0) !== '#', 'encodeState 返回值不带 #');

var dec = C.decodeState(hash);
eq(dec.ok, true, '解码成功');
eq(dec.difficulty, 'hard', '难度往返一致');
eq(dec.mode, 'pvp', '模式往返一致');
eq(dec.humanColor, C.WHITE, '执白往返一致');
eq(dec.moves.map(function (m) { return [m.x, m.y]; }), [[7, 7], [8, 7], [0, 14]], '棋谱往返一致');
eq(dec.turn, C.WHITE, '3 手后轮到白');

// 带 # 前缀也可解码
eq(C.decodeState('#' + hash).ok, true, '解码允许 # 前缀');

// 空盘 / 默认难度
var emptyHash = C.encodeState({ moves: [], difficulty: 'normal', mode: 'pve', humanColor: C.BLACK });
dec = C.decodeState(emptyHash);
eq(dec.ok, true, '空盘可解码');
eq(dec.moveCount, 0, '空盘 0 手');
eq(dec.moves.length, 0, '空盘 moves 为空');
eq(dec.difficulty, 'normal', '默认难度 normal');
// 第 6 档「宗师」加入后：分享编码向后兼容、新档位可往返
eq(C.DIFFICULTY_KEYS.length, 6, '难度键共 6 档');
eq(C.DIFFICULTY_KEYS[5], 'grandmaster', '第 6 档 key 为 grandmaster');
var gmHash = C.encodeState({ moves: [{ x: 7, y: 7 }, { x: 7, y: 8 }], difficulty: 'grandmaster', mode: 'pve', humanColor: C.BLACK });
var gmDec = C.decodeState(gmHash);
eq(gmDec.ok, true, '宗师难度链接可解码');
eq(gmDec.difficulty, 'grandmaster', '宗师难度往返一致');
eq(gmDec.moves.length, 2, '宗师难度棋谱往返一致');
eq(C.decodeState(C.encodeState({ moves: [], difficulty: 'novice' })).difficulty, 'novice', '旧难度 novice 编码仍可往返');

// 非法输入
var badInputs = ['', '#', '#g1.', '#g1.@@@', '#g1.bad!!', '#x', 'g1.=', null, 123];
for (var bi = 0; bi < badInputs.length; bi++) {
  var rr = C.decodeState(badInputs[bi]);
  ok(rr && rr.ok === false, '非法输入被拒绝：' + JSON.stringify(badInputs[bi]));
}

// 篡改难度索引（0..4 有效，5 无效）
var badBytes = [1, 5, 0];
ok(C.base64UrlToBytes(C.bytesToBase64Url(badBytes)) !== null, '字节编解码可用');
ok(C.base64UrlToBytes(C.bytesToBase64Url([1, 5, 0]))[1] === 5, '字节往返一致');
eq(C.decodeState('#g1.' + C.bytesToBase64Url([1, 9, 0])).ok, false, '非法难度索引被拒绝');
eq(C.decodeState('#g1.' + C.bytesToBase64Url([2, 0, 0])).ok, false, '非法版本被拒绝');
eq(C.decodeState('#g1.' + C.bytesToBase64Url([1, 0, 2])).ok, false, '非法模式索引 2 被拒绝');
eq(C.decodeState('#g1.' + C.bytesToBase64Url([1, 0, 3])).ok, false, '非法模式索引 3 被拒绝');
eq(C.decodeState('#g1.' + C.bytesToBase64Url([1, 0, 0, 225])).ok, false, '越界棋谱字节被拒绝');

// 编码后 URL 长度（62 手棋谱应当仍很短）；构造一局 62 手且全程无五连的合法棋谱
function buildSafeMoves(count) {
  var b2 = C.createBoard();
  var list = [];
  for (var i3 = 0; i3 < C.N && list.length < count; i3++) {
    var x3 = i3 % C.SIZE;
    var y3 = (i3 / C.SIZE) | 0;
    var p3 = C.playerAt(list.length);
    b2[C.idx(x3, y3)] = p3;
    if (!C.checkWin(b2, x3, y3)) list.push({ x: x3, y: y3 });
    else b2[C.idx(x3, y3)] = C.EMPTY;
  }
  return list;
}
var longMoves = buildSafeMoves(62);
eq(longMoves.length, 62, '构造 62 手无胜负棋谱');
var longHash = C.encodeState({ moves: longMoves, difficulty: 'master', mode: 'pve', humanColor: C.BLACK });
ok(longHash.length < 120, '62 手棋谱编码长度 < 120', '实际 ' + longHash.length);
var dLong = C.decodeState(longHash);
eq(dLong.ok, true, '62 手棋谱解码成功');
eq(dLong.moveCount, 62, '62 手棋谱解码手数一致');
eq(dLong.difficulty, 'master', '62 手棋谱难度一致');

/* ------------------------------------------------------------------ *
 * 5. 汇总
 * ------------------------------------------------------------------ */
print('────────────────────────────────────────');
print('test/core.js 规则核心自测：通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed) {
  print('失败项：');
  for (var f = 0; f < failures.length; f++) print('  ✗ ' + failures[f]);
  throw new Error('core.js 自测失败 ' + failed + ' 项');
}
print('✅ 全部规则核心测试通过');
