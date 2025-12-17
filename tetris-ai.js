/**
 * テトリス ビームサーチAI
 *
 * 機能:
 * - 7種類のテトリミノ（I, O, T, S, Z, J, L）
 * - SRS回転システム（壁蹴り対応）
 * - ビームサーチによる最適配置探索
 * - 評価関数: 穴、高さ、凸凹度、完成行数
 */

(function(global) {
  'use strict';

  // ===== 定数 =====
  const COLS = 10;
  const ROWS = 20;
  const HIDDEN_ROWS = 2;
  const TOTAL_ROWS = ROWS + HIDDEN_ROWS;

  // ===== テトリミノ定義 =====
  // 各ミノの4回転状態（SRS標準）
  const TETROMINOS = {
    I: {
      color: 'cyan',
      shapes: [
        [[0,0,0,0], [1,1,1,1], [0,0,0,0], [0,0,0,0]],
        [[0,0,1,0], [0,0,1,0], [0,0,1,0], [0,0,1,0]],
        [[0,0,0,0], [0,0,0,0], [1,1,1,1], [0,0,0,0]],
        [[0,1,0,0], [0,1,0,0], [0,1,0,0], [0,1,0,0]]
      ]
    },
    O: {
      color: 'yellow',
      shapes: [
        [[1,1], [1,1]],
        [[1,1], [1,1]],
        [[1,1], [1,1]],
        [[1,1], [1,1]]
      ]
    },
    T: {
      color: 'purple',
      shapes: [
        [[0,1,0], [1,1,1], [0,0,0]],
        [[0,1,0], [0,1,1], [0,1,0]],
        [[0,0,0], [1,1,1], [0,1,0]],
        [[0,1,0], [1,1,0], [0,1,0]]
      ]
    },
    S: {
      color: 'green',
      shapes: [
        [[0,1,1], [1,1,0], [0,0,0]],
        [[0,1,0], [0,1,1], [0,0,1]],
        [[0,0,0], [0,1,1], [1,1,0]],
        [[1,0,0], [1,1,0], [0,1,0]]
      ]
    },
    Z: {
      color: 'red',
      shapes: [
        [[1,1,0], [0,1,1], [0,0,0]],
        [[0,0,1], [0,1,1], [0,1,0]],
        [[0,0,0], [1,1,0], [0,1,1]],
        [[0,1,0], [1,1,0], [1,0,0]]
      ]
    },
    J: {
      color: 'blue',
      shapes: [
        [[1,0,0], [1,1,1], [0,0,0]],
        [[0,1,1], [0,1,0], [0,1,0]],
        [[0,0,0], [1,1,1], [0,0,1]],
        [[0,1,0], [0,1,0], [1,1,0]]
      ]
    },
    L: {
      color: 'orange',
      shapes: [
        [[0,0,1], [1,1,1], [0,0,0]],
        [[0,1,0], [0,1,0], [0,1,1]],
        [[0,0,0], [1,1,1], [1,0,0]],
        [[1,1,0], [0,1,0], [0,1,0]]
      ]
    }
  };

  const MINO_TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

  // SRS壁蹴りテーブル（J, L, S, T, Z用）
  const WALL_KICK_JLSTZ = {
    '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]
  };

  // SRS壁蹴りテーブル（I用）
  const WALL_KICK_I = {
    '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]
  };

  // ===== ビームサーチ設定 =====
  const BEAM_WIDTH = 80;
  const SEARCH_DEPTH = 4;

  // ===== 評価関数の重み（強化版）=====
  const EVAL_WEIGHTS = {
    // 穴関連（最重要 - 穴は致命的）
    HOLE_PENALTY: -200,         // 穴1個につき大きなペナルティ
    COVERED_HOLE_PENALTY: -40,  // 穴の上のブロック1個につき
    DEEP_HOLE_PENALTY: -80,     // 深い穴への追加ペナルティ
    HOLE_COLUMN_PENALTY: -30,   // 穴がある列への追加ペナルティ

    // 高さ関連
    HEIGHT_PENALTY: -10,        // 最大高さ1行につき
    AVG_HEIGHT_PENALTY: -4,     // 平均高さペナルティ
    HEIGHT_VARIANCE_PENALTY: -8, // 高さのばらつき
    CENTER_HEIGHT_PENALTY: -5,  // 中央列が高い場合のペナルティ

    // 形状関連
    BUMPINESS_PENALTY: -5,      // 隣接列の高さ差
    CLIFF_PENALTY: -20,         // 3以上の段差
    BLOCKED_COLUMN_PENALTY: -25, // 完全にブロックされた列

    // ライン消しボーナス
    LINES_CLEARED: 400,         // 消した行数ボーナス（1行あたり）
    LINES_CLEARED_BONUS: [0, 100, 500, 900, 1500],  // 同時消し行数ボーナス

    // 行の完成度ボーナス
    ALMOST_COMPLETE_ROW: 30,    // 9/10埋まっている行
    NEARLY_COMPLETE_ROW: 15,    // 8/10埋まっている行

    // 戦略的ボーナス
    WELL_DEPTH_BONUS: 15,       // I用の溝ボーナス（端のみ）
    SINGLE_WELL_BONUS: 25,      // 溝が1箇所のみの場合のボーナス
    FLAT_BONUS: 35,             // 平らな盤面ボーナス
    LOW_PROFILE_BONUS: 50,      // 全体的に低い盤面ボーナス
    PERFECT_CLEAR_BONUS: 500,   // 全消しボーナス
  };

  // ===== ゲーム状態クラス =====
  class GameState {
    constructor() {
      this.board = [];
      for (let r = 0; r < TOTAL_ROWS; r++) {
        this.board.push(new Array(COLS).fill(0));
      }
      this.currentMino = null;
      this.nextMinos = [];
      this.holdMino = null;
      this.canHold = true;
      this.gameOver = false;
    }

    clone() {
      const state = new GameState();
      state.board = this.board.map(row => [...row]);
      state.currentMino = this.currentMino ? { ...this.currentMino } : null;
      state.nextMinos = [...this.nextMinos];
      state.holdMino = this.holdMino;
      state.canHold = this.canHold;
      state.gameOver = this.gameOver;
      return state;
    }

    // 指定位置にミノを配置できるかチェック
    canPlace(type, rotation, row, col) {
      const shape = TETROMINOS[type].shapes[rotation];
      for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
          if (shape[r][c]) {
            const boardR = row + r;
            const boardC = col + c;
            if (boardC < 0 || boardC >= COLS || boardR >= TOTAL_ROWS) {
              return false;
            }
            if (boardR >= 0 && this.board[boardR][boardC]) {
              return false;
            }
          }
        }
      }
      return true;
    }

    // ミノを盤面に固定
    placeMino(type, rotation, row, col) {
      const shape = TETROMINOS[type].shapes[rotation];
      const color = TETROMINOS[type].color;
      for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
          if (shape[r][c]) {
            const boardR = row + r;
            const boardC = col + c;
            if (boardR >= 0 && boardR < TOTAL_ROWS && boardC >= 0 && boardC < COLS) {
              this.board[boardR][boardC] = color;
            }
          }
        }
      }
    }

    // ライン消去
    clearLines() {
      let linesCleared = 0;
      for (let r = TOTAL_ROWS - 1; r >= 0; r--) {
        if (this.board[r].every(cell => cell !== 0)) {
          this.board.splice(r, 1);
          this.board.unshift(new Array(COLS).fill(0));
          linesCleared++;
          r++; // 同じ行を再チェック
        }
      }
      return linesCleared;
    }

    // 列の高さを取得
    getColumnHeight(col) {
      for (let r = 0; r < TOTAL_ROWS; r++) {
        if (this.board[r][col]) {
          return TOTAL_ROWS - r;
        }
      }
      return 0;
    }

    // 穴の数をカウント（強化版）
    countHoles() {
      let holes = 0;
      let coveredBlocks = 0;
      let deepHoles = 0;  // 2ブロック以上覆われた穴
      let holeColumns = 0; // 穴がある列の数

      for (let c = 0; c < COLS; c++) {
        let foundBlock = false;
        let blocksAbove = 0;
        let columnHasHole = false;

        for (let r = 0; r < TOTAL_ROWS; r++) {
          if (this.board[r][c]) {
            foundBlock = true;
            blocksAbove++;
          } else if (foundBlock) {
            holes++;
            coveredBlocks += blocksAbove;
            columnHasHole = true;
            if (blocksAbove >= 2) {
              deepHoles++;
            }
          }
        }

        if (columnHasHole) {
          holeColumns++;
        }
      }
      return { holes, coveredBlocks, deepHoles, holeColumns };
    }

    // 凸凹度（隣接列の高さ差の合計）
    getBumpiness() {
      let bumpiness = 0;
      let prevHeight = this.getColumnHeight(0);
      for (let c = 1; c < COLS; c++) {
        const height = this.getColumnHeight(c);
        bumpiness += Math.abs(height - prevHeight);
        prevHeight = height;
      }
      return bumpiness;
    }

    // 最大高さ
    getMaxHeight() {
      let maxHeight = 0;
      for (let c = 0; c < COLS; c++) {
        maxHeight = Math.max(maxHeight, this.getColumnHeight(c));
      }
      return maxHeight;
    }

    // 溝の深さを評価（I用）
    getWellDepth() {
      let totalWellDepth = 0;
      for (let c = 0; c < COLS; c++) {
        const height = this.getColumnHeight(c);
        const leftHeight = c > 0 ? this.getColumnHeight(c - 1) : 999;
        const rightHeight = c < COLS - 1 ? this.getColumnHeight(c + 1) : 999;
        const wellDepth = Math.min(leftHeight, rightHeight) - height;
        if (wellDepth > 0) {
          totalWellDepth += wellDepth;
        }
      }
      return totalWellDepth;
    }

    // ゲームオーバーチェック
    checkGameOver() {
      // 隠し行にブロックがあればゲームオーバー
      for (let r = 0; r < HIDDEN_ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (this.board[r][c]) {
            return true;
          }
        }
      }
      return false;
    }
  }

  // ===== 配置可能な全パターンを列挙 =====
  function getAllPlacements(state, type) {
    const placements = [];
    const shape = TETROMINOS[type].shapes[0];

    for (let rotation = 0; rotation < 4; rotation++) {
      const rotatedShape = TETROMINOS[type].shapes[rotation];
      const width = rotatedShape[0].length;
      const height = rotatedShape.length;

      for (let col = -2; col < COLS + 2; col++) {
        // ハードドロップ位置を計算
        let dropRow = -height;
        while (state.canPlace(type, rotation, dropRow + 1, col)) {
          dropRow++;
          if (dropRow > TOTAL_ROWS) break;
        }

        if (state.canPlace(type, rotation, dropRow, col)) {
          placements.push({
            type,
            rotation,
            row: dropRow,
            col
          });
        }
      }
    }

    // 重複を除去
    const unique = [];
    const seen = new Set();
    for (const p of placements) {
      const key = `${p.rotation},${p.row},${p.col}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(p);
      }
    }

    return unique;
  }

  // ===== 盤面評価関数（強化版）=====
  function evaluateBoard(state, linesCleared = 0) {
    if (state.gameOver || state.checkGameOver()) {
      return -1000000;
    }

    let score = 0;

    // 各列の高さを取得
    const heights = [];
    for (let c = 0; c < COLS; c++) {
      heights.push(state.getColumnHeight(c));
    }
    const maxHeight = Math.max(...heights);
    const avgHeight = heights.reduce((a, b) => a + b, 0) / COLS;

    // 穴のペナルティ（最重要）
    const { holes, coveredBlocks, deepHoles, holeColumns } = state.countHoles();
    score += holes * EVAL_WEIGHTS.HOLE_PENALTY;
    score += coveredBlocks * EVAL_WEIGHTS.COVERED_HOLE_PENALTY;
    score += deepHoles * EVAL_WEIGHTS.DEEP_HOLE_PENALTY;
    score += holeColumns * EVAL_WEIGHTS.HOLE_COLUMN_PENALTY;

    // 高さのペナルティ
    score += maxHeight * EVAL_WEIGHTS.HEIGHT_PENALTY;
    score += avgHeight * EVAL_WEIGHTS.AVG_HEIGHT_PENALTY;

    // 中央列が高い場合のペナルティ（ゲームオーバーしやすい）
    const centerHeight = Math.max(heights[4], heights[5]);
    if (centerHeight > avgHeight + 2) {
      score += (centerHeight - avgHeight) * EVAL_WEIGHTS.CENTER_HEIGHT_PENALTY;
    }

    // 高さのばらつきペナルティ
    const heightVariance = heights.reduce((sum, h) => sum + Math.pow(h - avgHeight, 2), 0) / COLS;
    score += Math.sqrt(heightVariance) * EVAL_WEIGHTS.HEIGHT_VARIANCE_PENALTY;

    // 凸凹度のペナルティ
    let bumpiness = 0;
    let cliffs = 0;
    let wellCount = 0;
    let wellPositions = [];

    for (let c = 0; c < COLS; c++) {
      // 隣接列との差を計算
      if (c > 0) {
        const diff = Math.abs(heights[c] - heights[c - 1]);
        bumpiness += diff;
        if (diff >= 3) cliffs++;
      }

      // 溝の検出
      const leftH = c > 0 ? heights[c - 1] : 999;
      const rightH = c < COLS - 1 ? heights[c + 1] : 999;
      const wellDepth = Math.min(leftH, rightH) - heights[c];
      if (wellDepth >= 2) {
        wellCount++;
        wellPositions.push(c);
      }
    }

    score += bumpiness * EVAL_WEIGHTS.BUMPINESS_PENALTY;
    score += cliffs * EVAL_WEIGHTS.CLIFF_PENALTY;

    // 溝評価（端の溝は良い、複数の溝は悪い）
    if (wellCount === 1) {
      const wellCol = wellPositions[0];
      // 端の溝はI-ミノ用として良い
      if (wellCol === 0 || wellCol === COLS - 1) {
        const wellDepth = Math.min(
          wellCol === 0 ? heights[1] : heights[COLS - 2],
          wellCol === 0 ? (heights[2] || 0) : (heights[COLS - 3] || 0)
        ) - heights[wellCol];
        score += wellDepth * EVAL_WEIGHTS.WELL_DEPTH_BONUS;
        score += EVAL_WEIGHTS.SINGLE_WELL_BONUS;
      }
    } else if (wellCount > 1) {
      // 複数の溝はペナルティ
      score += (wellCount - 1) * EVAL_WEIGHTS.BLOCKED_COLUMN_PENALTY;
    }

    // 行の完成度ボーナス
    for (let r = HIDDEN_ROWS; r < TOTAL_ROWS; r++) {
      let filledCount = 0;
      for (let c = 0; c < COLS; c++) {
        if (state.board[r][c]) filledCount++;
      }
      if (filledCount === COLS - 1) {
        score += EVAL_WEIGHTS.ALMOST_COMPLETE_ROW;
      } else if (filledCount === COLS - 2) {
        score += EVAL_WEIGHTS.NEARLY_COMPLETE_ROW;
      }
    }

    // ライン消しボーナス
    if (linesCleared > 0) {
      score += linesCleared * EVAL_WEIGHTS.LINES_CLEARED;
      const bonusIdx = Math.min(linesCleared, EVAL_WEIGHTS.LINES_CLEARED_BONUS.length - 1);
      score += EVAL_WEIGHTS.LINES_CLEARED_BONUS[bonusIdx];
    }

    // 平らボーナス
    if (bumpiness <= 4) {
      score += EVAL_WEIGHTS.FLAT_BONUS;
    }

    // 低い盤面ボーナス
    if (maxHeight <= 6) {
      score += EVAL_WEIGHTS.LOW_PROFILE_BONUS;
    } else if (maxHeight <= 4) {
      score += EVAL_WEIGHTS.LOW_PROFILE_BONUS * 2;
    }

    // 全消しボーナス
    let isEmpty = true;
    for (let r = 0; r < TOTAL_ROWS && isEmpty; r++) {
      for (let c = 0; c < COLS && isEmpty; c++) {
        if (state.board[r][c]) isEmpty = false;
      }
    }
    if (isEmpty) {
      score += EVAL_WEIGHTS.PERFECT_CLEAR_BONUS;
    }

    return score;
  }

  // ===== ビームサーチ（ホールド対応版）=====
  function beamSearch(state, depth = SEARCH_DEPTH, beamWidth = BEAM_WIDTH) {
    if (!state.currentMino) return null;

    const currentType = state.currentMino.type;
    const holdType = state.holdMino;
    const canHold = state.canHold;

    // 探索する最初のミノタイプの選択肢
    const firstMinoOptions = [{ type: currentType, useHold: false }];
    if (canHold && holdType && holdType !== currentType) {
      firstMinoOptions.push({ type: holdType, useHold: true });
    } else if (canHold && !holdType && state.nextMinos.length > 0) {
      // ホールドが空の場合、次のミノを使う選択肢
      firstMinoOptions.push({ type: state.nextMinos[0], useHold: true });
    }

    let beam = [];

    // 最初のミノの選択肢ごとに初期状態を作成
    for (const option of firstMinoOptions) {
      beam.push({
        state: state.clone(),
        actions: [],
        totalLinesCleared: 0,
        firstMino: option.type,
        usedHold: option.useHold
      });
    }

    // 探索深度分ループ
    for (let d = 0; d < depth; d++) {
      const candidates = [];

      for (const node of beam) {
        if (node.state.gameOver) continue;

        // このノードで使うミノタイプを決定
        let minoType;
        if (d === 0) {
          minoType = node.firstMino;
        } else {
          // 2手目以降は次のミノを順番に使う
          const minoIndex = d - (node.usedHold && !state.holdMino ? 0 : 0);
          const adjustedIndex = node.usedHold ? d : d - 1;
          if (adjustedIndex < 0) {
            minoType = node.firstMino;
          } else if (adjustedIndex < state.nextMinos.length) {
            minoType = state.nextMinos[adjustedIndex];
          } else {
            continue;
          }
        }

        const placements = getAllPlacements(node.state, minoType);

        for (const placement of placements) {
          const newState = node.state.clone();
          newState.placeMino(placement.type, placement.rotation, placement.row, placement.col);
          const linesCleared = newState.clearLines();

          if (newState.checkGameOver()) {
            newState.gameOver = true;
          }

          const action = {
            ...placement,
            useHold: d === 0 ? node.usedHold : false
          };

          candidates.push({
            state: newState,
            actions: [...node.actions, action],
            totalLinesCleared: node.totalLinesCleared + linesCleared,
            lastLinesCleared: linesCleared,
            firstMino: node.firstMino,
            usedHold: node.usedHold
          });
        }
      }

      if (candidates.length === 0) break;

      // 評価してソート
      for (const candidate of candidates) {
        candidate.score = evaluateBoard(candidate.state, candidate.lastLinesCleared);
      }
      candidates.sort((a, b) => b.score - a.score);

      beam = candidates.slice(0, beamWidth);
    }

    if (beam.length > 0 && beam[0].actions.length > 0) {
      return beam[0].actions[0];
    }

    return null;
  }

  // ===== ゴースト位置計算 =====
  function getGhostPosition(state) {
    if (!state.currentMino) return null;

    const { type, rotation, row, col } = state.currentMino;
    let ghostRow = row;

    while (state.canPlace(type, rotation, ghostRow + 1, col)) {
      ghostRow++;
    }

    return { type, rotation, row: ghostRow, col };
  }

  // ===== メインAPI =====
  const TetrisAI = {
    TETROMINOS,
    MINO_TYPES,
    COLS,
    ROWS,
    HIDDEN_ROWS,
    TOTAL_ROWS,
    WALL_KICK_JLSTZ,
    WALL_KICK_I,

    GameState,

    findBestMove(board, currentMino, nextMinos, holdMino, canHold = true) {
      try {
        const state = new GameState();

        // 盤面をコピー
        for (let r = 0; r < TOTAL_ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            state.board[r][c] = board[r] && board[r][c] ? board[r][c] : 0;
          }
        }

        state.currentMino = currentMino ? { ...currentMino } : null;
        state.nextMinos = nextMinos || [];
        state.holdMino = holdMino;
        state.canHold = canHold;

        const result = beamSearch(state);

        if (result) {
          return {
            col: result.col,
            rotation: result.rotation,
            type: result.type,
            useHold: result.useHold || false
          };
        }

        return null;
      } catch (e) {
        console.error('TetrisAI.findBestMove error:', e);
        return null;
      }
    },

    getGhostPosition,
    evaluateBoard,
    getAllPlacements,

    // 壁蹴りを試行
    tryWallKick(state, type, fromRotation, toRotation, row, col) {
      const kickTable = type === 'I' ? WALL_KICK_I : WALL_KICK_JLSTZ;
      const key = `${fromRotation}>${toRotation}`;
      const kicks = kickTable[key] || [[0, 0]];

      for (const [dx, dy] of kicks) {
        if (state.canPlace(type, toRotation, row - dy, col + dx)) {
          return { row: row - dy, col: col + dx };
        }
      }
      return null;
    },

    config: {
      BEAM_WIDTH,
      SEARCH_DEPTH,
      COLS,
      ROWS,
      TOTAL_ROWS
    }
  };

  global.TetrisAI = TetrisAI;

})(typeof window !== 'undefined' ? window : global);
