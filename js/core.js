/*!
 * core.js — 五子棋公共核心：棋盘常量、胜负判定、坐标、分享编码
 *
 * 全局约定（全项目唯一真相，AI / UI 都必须遵守）：
 *   - 棋盘固定 15x15，共 225 格
 *   - 棋盘用一维 Uint8Array(225) 表示，索引 index = y * 15 + x
 *   - 落子值：0 = 空，1 = 黑（先手），2 = 白（后手）
 *   - 坐标 (x, y)：x 为列（0..14，从左到右），y 为行（0..14，从上到下）
 *   - 人类可读坐标：列用字母 A..O，行用 1..15，例如 (7, 7) => "H8"
 *
 * 本文件不依赖任何第三方库，也不依赖 DOM，可直接在浏览器或 jsc 中加载。
 */
(function (global) {
  'use strict';

  var SIZE = 15;
  var N = SIZE * SIZE;
  var EMPTY = 0;
  var BLACK = 1;
  var WHITE = 2;

  /** 四方向：横、竖、主对角、副对角 */
  var DIRS = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ];

  /** 难度键的规范顺序（分享编码里的索引即此顺序） */
  var DIFFICULTY_KEYS = ['novice', 'easy', 'normal', 'hard', 'master', 'grandmaster'];

  /** 对局模式 */
  var MODES = ['pve', 'pvp'];

  function idx(x, y) {
    return y * SIZE + x;
  }

  function isInBounds(x, y) {
    return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  }

  function opponent(player) {
    return player === BLACK ? WHITE : BLACK;
  }

  function createBoard() {
    return new Uint8Array(N);
  }

  function cloneBoard(board) {
    return new Uint8Array(board);
  }

  function getStone(board, x, y) {
    return isInBounds(x, y) ? board[idx(x, y)] : -1;
  }

  function isFull(board) {
    for (var i = 0; i < N; i++) {
      if (board[i] === EMPTY) return false;
    }
    return true;
  }

  function countStones(board) {
    var n = 0;
    for (var i = 0; i < N; i++) if (board[i] !== EMPTY) n++;
    return n;
  }

  /**
   * 检查 (x, y) 这一手是否形成五连（>=5 均算胜，含长连）。
   * 返回 null 或 { player, cells: [[x,y], ...], dir: [dx,dy] }
   * cells 为包含该手的完整连续棋子序列。
   */
  function checkWin(board, x, y) {
    var player = board[idx(x, y)];
    if (player !== BLACK && player !== WHITE) return null;
    for (var d = 0; d < DIRS.length; d++) {
      var dx = DIRS[d][0];
      var dy = DIRS[d][1];

      var back = 0;
      while (
        isInBounds(x - dx * (back + 1), y - dy * (back + 1)) &&
        board[idx(x - dx * (back + 1), y - dy * (back + 1))] === player
      ) {
        back++;
      }
      var fwd = 0;
      while (
        isInBounds(x + dx * (fwd + 1), y + dy * (fwd + 1)) &&
        board[idx(x + dx * (fwd + 1), y + dy * (fwd + 1))] === player
      ) {
        fwd++;
      }
      if (back + fwd + 1 >= 5) {
        var cells = [];
        for (var k = -back; k <= fwd; k++) {
          cells.push([x + dx * k, y + dy * k]);
        }
        return { player: player, cells: cells, dir: [dx, dy] };
      }
    }
    return null;
  }

  /** 以当前手数推出轮到谁（黑先） */
  function playerAt(moveIndex) {
    return moveIndex % 2 === 0 ? BLACK : WHITE;
  }

  /**
   * 回放一串落子，返回局面。
   * moveList: [{x, y}, ...]（player 由先后手自动推出）
   * 返回 {
   *   ok, board, moves:[{x,y,player}], winner, winLine, dir,
   *   finished, draw, turn, moveCount
   * }
   */
  function replay(moveList) {
    var board = createBoard();
    var moves = [];
    var winner = null;
    var winLine = null;
    var dir = null;

    for (var i = 0; i < moveList.length; i++) {
      var x = moveList[i].x;
      var y = moveList[i].y;
      if (!isInBounds(x, y)) {
        return { ok: false, error: '第 ' + (i + 1) + ' 手坐标越界' };
      }
      if (board[idx(x, y)] !== EMPTY) {
        return { ok: false, error: '第 ' + (i + 1) + ' 手落子于已有棋子处' };
      }
      var player = playerAt(i);
      board[idx(x, y)] = player;
      moves.push({ x: x, y: y, player: player });

      var w = checkWin(board, x, y);
      if (w) {
        winner = w.player;
        winLine = w.cells;
        dir = w.dir;
        if (i < moveList.length - 1) {
          return { ok: false, error: '第 ' + (i + 1) + ' 手已分胜负，后续着法无效' };
        }
      }
    }

    var moveCount = moves.length;
    var finished = winner !== null;
    var draw = !finished && isFull(board);
    return {
      ok: true,
      board: board,
      moves: moves,
      winner: winner,
      winLine: winLine,
      dir: dir,
      finished: finished || draw,
      draw: draw,
      turn: winner || draw ? 0 : playerAt(moveCount),
      moveCount: moveCount
    };
  }

  /* ------------------------------------------------------------------ *
   * 坐标显示
   * ------------------------------------------------------------------ */

  var COL_LETTERS = 'ABCDEFGHIJKLMNO';

  function coordName(x, y) {
    if (!isInBounds(x, y)) return '??';
    return COL_LETTERS.charAt(x) + (y + 1);
  }

  function parseIntCoord(text) {
    if (typeof text !== 'string') return null;
    var m = /^\s*([A-Oa-o])\s*(\d{1,2})\s*$/.exec(text);
    if (!m) return null;
    var x = COL_LETTERS.indexOf(m[1].toUpperCase());
    var y = parseInt(m[2], 10) - 1;
    if (!isInBounds(x, y)) return null;
    return { x: x, y: y };
  }

  function lineName(cells) {
    if (!cells || !cells.length) return '';
    var a = cells[0];
    var b = cells[cells.length - 1];
    return coordName(a[0], a[1]) + '–' + coordName(b[0], b[1]);
  }

  /* ------------------------------------------------------------------ *
   * 分享编码（URL hash 里携带完整棋谱）
   *
   * 结构：'g1.' + base64url( [version(1), difficultyIndex, flags, move0, move1, ...] )
   *   version = 1
   *   flags: bit0..1 = mode(0=pve, 1=pvp)；bit2 = humanColor 是否为黑；
   *          bit3..4 = 棋盘尺寸代码（0 = 15x15，预留）
   *   每一手 1 字节 = y*15+x
   * ------------------------------------------------------------------ */

  var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64_LOOKUP = (function () {
    var map = {};
    for (var i = 0; i < B64_CHARS.length; i++) map[B64_CHARS.charAt(i)] = i;
    return map;
  })();

  function bytesToBase64Url(bytes) {
    var out = '';
    var i = 0;
    while (i + 2 < bytes.length) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64_CHARS.charAt((n >> 18) & 63) + B64_CHARS.charAt((n >> 12) & 63) +
        B64_CHARS.charAt((n >> 6) & 63) + B64_CHARS.charAt(n & 63);
      i += 3;
    }
    var rest = bytes.length - i;
    if (rest === 1) {
      var a = bytes[i] << 16;
      out += B64_CHARS.charAt((a >> 18) & 63) + B64_CHARS.charAt((a >> 12) & 63);
    } else if (rest === 2) {
      var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += B64_CHARS.charAt((b >> 18) & 63) + B64_CHARS.charAt((b >> 12) & 63) +
        B64_CHARS.charAt((b >> 6) & 63);
    }
    return out;
  }

  function base64UrlToBytes(str) {
    if (!str || str.length % 4 === 1) return null;
    var bytes = [];
    var buffer = 0;
    var bits = 0;
    for (var i = 0; i < str.length; i++) {
      var v = B64_LOOKUP[str.charAt(i)];
      if (v === undefined) return null;
      buffer = (buffer << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }
    return bytes;
  }

  function difficultyIndex(key) {
    var i = DIFFICULTY_KEYS.indexOf(key);
    return i < 0 ? 2 : i; // 默认 normal
  }

  function isDifficultyKey(key) {
    return DIFFICULTY_KEYS.indexOf(key) >= 0;
  }

  /**
   * 把对局编码为 URL hash，如 '#g1.AQME...'。
   * state: { moves:[{x,y}], difficulty:'hard', mode:'pve', humanColor:1 }
   */
  function encodeState(state) {
    var moves = (state && state.moves) || [];
    var difficulty = isDifficultyKey(state && state.difficulty) ? state.difficulty : 'normal';
    var mode = MODES.indexOf(state && state.mode) >= 0 ? state.mode : 'pve';
    var humanColor = state && state.humanColor === WHITE ? WHITE : BLACK;

    var bytes = [1, difficultyIndex(difficulty), (MODES.indexOf(mode) & 3) | (humanColor === BLACK ? 4 : 0)];
    for (var i = 0; i < moves.length; i++) {
      bytes.push(idx(moves[i].x, moves[i].y));
    }
    return 'g1.' + bytesToBase64Url(bytes);
  }

  /**
   * 解析 URL hash（可带或不带 '#' 前缀）。成功返回
   * { ok:true, moves, difficulty, mode, humanColor, ...回放结果 }
   * 失败返回 { ok:false, error }
   */
  function decodeState(hash) {
    if (typeof hash !== 'string') return { ok: false, error: '没有分享信息' };
    var text = hash.replace(/^#/, '').trim();
    var m = /^g1\.([A-Za-z0-9_-]+)$/.exec(text);
    if (!m) return { ok: false, error: '分享链接格式不正确' };
    var bytes = base64UrlToBytes(m[1]);
    if (!bytes || bytes.length < 3) return { ok: false, error: '分享数据不完整' };
    if (bytes[0] !== 1) return { ok: false, error: '分享数据版本不支持' };

    var di = bytes[1];
    if (di < 0 || di >= DIFFICULTY_KEYS.length) return { ok: false, error: '难度数据无效' };
    var flags = bytes[2];
    var modeIndex = flags & 3;
    if (modeIndex >= MODES.length) return { ok: false, error: '模式数据无效' };
    var mode = MODES[modeIndex];
    var humanColor = flags & 4 ? BLACK : WHITE;
    var moveList = [];
    for (var i = 3; i < bytes.length; i++) {
      var v = bytes[i];
      if (v >= N) return { ok: false, error: '棋谱数据越界' };
      moveList.push({ x: v % SIZE, y: (v / SIZE) | 0 });
    }

    var result = replay(moveList);
    if (!result.ok) return { ok: false, error: '棋谱数据无效：' + result.error };

    return {
      ok: true,
      moves: result.moves,
      board: result.board,
      winner: result.winner,
      winLine: result.winLine,
      dir: result.dir,
      finished: result.finished,
      draw: result.draw,
      turn: result.turn,
      moveCount: result.moveCount,
      difficulty: DIFFICULTY_KEYS[di],
      mode: mode,
      humanColor: humanColor
    };
  }

  /* ------------------------------------------------------------------ *
   * AI 侧共享常量（供 ai.js 复用，避免两处定义漂移）
   * ------------------------------------------------------------------ */

  var GomokuCore = {
    SIZE: SIZE,
    N: N,
    EMPTY: EMPTY,
    BLACK: BLACK,
    WHITE: WHITE,
    DIRS: DIRS,
    DIFFICULTY_KEYS: DIFFICULTY_KEYS,
    MODES: MODES,
    idx: idx,
    isInBounds: isInBounds,
    opponent: opponent,
    createBoard: createBoard,
    cloneBoard: cloneBoard,
    getStone: getStone,
    isFull: isFull,
    countStones: countStones,
    checkWin: checkWin,
    playerAt: playerAt,
    replay: replay,
    coordName: coordName,
    parseIntCoord: parseIntCoord,
    lineName: lineName,
    encodeState: encodeState,
    decodeState: decodeState,
    bytesToBase64Url: bytesToBase64Url,
    base64UrlToBytes: base64UrlToBytes,
    difficultyIndex: difficultyIndex,
    isDifficultyKey: isDifficultyKey
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GomokuCore;
  }
  global.GomokuCore = GomokuCore;
})(typeof window !== 'undefined' ? window : this);
