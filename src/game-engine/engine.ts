import {
  PlayerColor,
  PlayerSlot,
  TeamId,
  TokenZone,
  TokenState,
  GameDocument,
  RoomSettings,
} from '../types';

// Canonical shared track length
export const TRACK_LENGTH = 52;
export const HOME_PATH_START_PROGRESS = 51;
export const FINAL_HOME_PROGRESS = 56;
export const TOKENS_PER_PLAYER = 4;
// Progress values that place a token on the shared ring: 0..50
export const LAST_TRACK_PROGRESS = HOME_PATH_START_PROGRESS - 1;
// Progress values that place a token on the home stretch: 51..55
export const LAST_HOME_PATH_PROGRESS = FINAL_HOME_PROGRESS - 1;

/**
 * Number of tokens a player must bring home to win.
 * Single source of truth shared by online, offline and AI gameplay.
 */
export function getTokensToWin(settings: Partial<RoomSettings> | undefined | null): number {
  const explicit = settings?.tokensToWin;
  if (typeof explicit === 'number' && explicit >= 1) {
    return Math.min(TOKENS_PER_PLAYER, Math.max(1, Math.floor(explicit)));
  }
  if (settings?.gameMode === 'RUSH') return 2;
  if (settings?.gameMode === 'SNAKE_LADDER') return 1;
  return TOKENS_PER_PLAYER;
}

// Starting global track indices for each player slot
export const SLOT_START_TRACK_INDEX: Record<PlayerSlot, number> = {
  P1: 0,  // Red (bottom arm left lane [13, 6] connected to bottom-left Red yard)
  P2: 13, // Green (left arm top lane [6, 1] connected to top-left Green yard)
  P3: 26, // Yellow (top arm right lane [1, 8] connected to top-right Yellow yard)
  P4: 39, // Blue (right arm bottom lane [8, 13] connected to bottom-right Blue yard)
};

// Safe squares on the 52-cell track:
// 4 starting squares (0: Red [13,6], 13: Green [6,1], 26: Yellow [1,8], 39: Blue [8,13])
// + 4 star squares (8: [8,2], 21: [2,6], 34: [6,12], 47: [12,8])
export const SAFE_TRACK_INDICES = new Set<number>([
  0,  // P1 Start (Red at [13, 6])
  8,  // Star 1 (Left arm bottom lane [8, 2])
  13, // P2 Start (Green at [6, 1])
  21, // Star 2 (Top arm left lane [2, 6])
  26, // P3 Start (Yellow at [1, 8])
  34, // Star 3 (Right arm top lane [6, 12])
  39, // P4 Start (Blue at [8, 13])
  47, // Star 4 (Bottom arm right lane [12, 8])
]);

export function isSafeTrackIndex(trackIndex: number): boolean {
  return SAFE_TRACK_INDICES.has(trackIndex % TRACK_LENGTH);
}

export function getPlayerStartIndex(slot: PlayerSlot): number {
  return SLOT_START_TRACK_INDEX[slot] ?? 0;
}

export function getGlobalTrackIndex(slot: PlayerSlot, progress: number): number | null {
  if (progress < 0 || progress >= HOME_PATH_START_PROGRESS) {
    return null; // Not on shared track
  }
  const startIdx = getPlayerStartIndex(slot);
  return (startIdx + progress) % TRACK_LENGTH;
}

export interface MoveCalculation {
  canMove: boolean;
  reason?: string;
  newZone: TokenZone;
  newProgress: number;
  capturedTokens: {
    uid: string;
    tokenId: number;
    slot: PlayerSlot;
  }[];
  isHome: boolean;
  grantsExtraTurn: boolean;
}

export function areTeammates(slotA: PlayerSlot, slotB: PlayerSlot): boolean {
  if (slotA === slotB) return true;
  const isTeam1A = slotA === 'P1' || slotA === 'P3';
  const isTeam1B = slotB === 'P1' || slotB === 'P3';
  return isTeam1A === isTeam1B;
}

/** Team 1 = RED (P1) + YELLOW (P3) | Team 2 = GREEN (P2) + BLUE (P4) */
export function getTeamId(slot: PlayerSlot): TeamId {
  return slot === 'P1' || slot === 'P3' ? 'TEAM_1' : 'TEAM_2';
}

export function getTeamIdForUid(uid: string, slotMap: Record<string, PlayerSlot>): TeamId | null {
  const slot = slotMap[uid];
  return slot ? getTeamId(slot) : null;
}

/**
 * In 2v2 Tag-Team mode a team wins only when BOTH partners have brought
 * every required token home. Returns the winning team id or null.
 */
export function getWinningTeam(
  tokens: GameDocument['tokens'],
  slotMap: Record<string, PlayerSlot>,
  tokensToWin: number = TOKENS_PER_PLAYER
): TeamId | null {
  const teams: Record<TeamId, { total: number; finished: number }> = {
    TEAM_1: { total: 0, finished: 0 },
    TEAM_2: { total: 0, finished: 0 },
  };

  for (const uid of Object.keys(tokens)) {
    const slot = slotMap[uid];
    if (!slot) continue;
    const team = getTeamId(slot);
    teams[team].total += 1;
    if (hasPlayerWon(uid, tokens, tokensToWin)) teams[team].finished += 1;
  }

  for (const teamId of ['TEAM_1', 'TEAM_2'] as TeamId[]) {
    const t = teams[teamId];
    if (t.total > 0 && t.finished === t.total) return teamId;
  }
  return null;
}

/**
 * Returns every uid on the winning team (used for rankings / result screen).
 */
export function getTeamMemberUids(
  teamId: TeamId,
  slotMap: Record<string, PlayerSlot>
): string[] {
  return Object.keys(slotMap)
    .filter((uid) => getTeamId(slotMap[uid]) === teamId)
    .sort((a, b) => slotMap[a].localeCompare(slotMap[b]));
}

/**
 * Checks whether a token can legally move given a dice roll
 */
export function calculateTokenMove(
  token: { id: number; zone: TokenZone; progress: number },
  slot: PlayerSlot,
  uid: string,
  diceValue: number,
  allTokens: GameDocument['tokens'],
  slotMap: Record<string, PlayerSlot>,
  settings: RoomSettings
): MoveCalculation {
  // 1. Token already finished
  if (token.zone === 'HOME' || token.progress === FINAL_HOME_PROGRESS) {
    return {
      canMove: false,
      reason: 'Token already reached Home',
      newZone: 'HOME',
      newProgress: FINAL_HOME_PROGRESS,
      capturedTokens: [],
      isHome: true,
      grantsExtraTurn: false,
    };
  }

  // 2. Token in Yard
  if (token.zone === 'YARD' || token.progress === -1) {
    if (diceValue !== 6) {
      return {
        canMove: false,
        reason: 'Requires a 6 to leave Yard',
        newZone: 'YARD',
        newProgress: -1,
        capturedTokens: [],
        isHome: false,
        grantsExtraTurn: false,
      };
    }

    // Rolling a 6 allows entering start square (progress = 0)
    const startGlobalIdx = getPlayerStartIndex(slot);
    const captured: MoveCalculation['capturedTokens'] = [];

    // Check if landing square has opponents (cannot capture on safe start, but let's check)
    // Note: Start squares are safe positions, so no capture happens on starting square.
    return {
      canMove: true,
      newZone: 'TRACK',
      newProgress: 0,
      capturedTokens: captured,
      isHome: false,
      grantsExtraTurn: true, // Rolling 6 gives extra turn
    };
  }

  // 3. Token is on Track or Home Path
  const targetProgress = token.progress + diceValue;

  // Exact home rule: overshooting is invalid
  if (targetProgress > FINAL_HOME_PROGRESS) {
    return {
      canMove: false,
      reason: 'Overshoots Home - exact roll required',
      newZone: token.zone,
      newProgress: token.progress,
      capturedTokens: [],
      isHome: false,
      grantsExtraTurn: false,
    };
  }

  // Determine new zone
  let targetZone: TokenZone = 'TRACK';
  if (targetProgress === FINAL_HOME_PROGRESS) {
    targetZone = 'HOME';
  } else if (targetProgress >= HOME_PATH_START_PROGRESS) {
    targetZone = 'HOME_PATH';
  }

  // Check blockade rule along the path if enabled
  if (settings.allowBlockades && targetZone === 'TRACK') {
    // A blockade is formed by 2+ opponent tokens standing on the destination cell.
    const targetGlobalIdx = getGlobalTrackIndex(slot, targetProgress);
    if (targetGlobalIdx !== null) {
      let blockingTokens = 0;
      for (const [otherUid, playerTokens] of Object.entries(allTokens)) {
        if (otherUid === uid) continue;
        const otherSlot = slotMap[otherUid];
        if (!otherSlot) continue;

        // In TEAM mode, teammates do not blockade each other
        if (settings.gameMode === 'TEAM' && areTeammates(slot, otherSlot)) {
          continue;
        }

        for (const t of Object.values(playerTokens)) {
          if (t.zone === 'TRACK' && getGlobalTrackIndex(otherSlot, t.progress) === targetGlobalIdx) {
            blockingTokens++;
          }
        }
      }

      if (blockingTokens >= 2 && !isSafeTrackIndex(targetGlobalIdx)) {
        return {
          canMove: false,
          reason: 'Destination is blocked by opponent blockade',
          newZone: token.zone,
          newProgress: token.progress,
          capturedTokens: [],
          isHome: false,
          grantsExtraTurn: false,
        };
      }
    }
  }

  // Check captures
  const captured: MoveCalculation['capturedTokens'] = [];
  let grantsExtraTurn = diceValue === 6;

  if (targetZone === 'TRACK') {
    const targetGlobalIdx = getGlobalTrackIndex(slot, targetProgress);
    if (targetGlobalIdx !== null && !isSafeTrackIndex(targetGlobalIdx)) {
      // Look for opponent tokens on this cell
      for (const [otherUid, playerTokens] of Object.entries(allTokens)) {
        if (otherUid === uid) continue;
        const otherSlot = slotMap[otherUid];
        if (!otherSlot) continue;

        // In TEAM mode, teammates cannot be captured
        if (settings.gameMode === 'TEAM' && areTeammates(slot, otherSlot)) {
          continue;
        }

        for (const t of Object.values(playerTokens)) {
          if (t.zone === 'TRACK' && getGlobalTrackIndex(otherSlot, t.progress) === targetGlobalIdx) {
            captured.push({
              uid: otherUid,
              tokenId: t.id,
              slot: otherSlot,
            });
          }
        }
      }
    }
  }

  // If captured opponent, grant an extra roll!
  if (captured.length > 0) {
    grantsExtraTurn = true;
  }

  // If reached home, grant an extra roll in traditional Bangladeshi rules
  if (targetZone === 'HOME') {
    grantsExtraTurn = true;
  }

  return {
    canMove: true,
    newZone: targetZone,
    newProgress: targetProgress,
    capturedTokens: captured,
    isHome: targetZone === 'HOME',
    grantsExtraTurn,
  };
}

/**
 * Returns a list of token IDs that are legally movable for the player
 */
export function getLegalMoves(
  uid: string,
  slot: PlayerSlot,
  diceValue: number,
  allTokens: GameDocument['tokens'],
  slotMap: Record<string, PlayerSlot>,
  settings: RoomSettings
): number[] {
  const playerTokens = allTokens[uid];
  if (!playerTokens) return [];

  const legalTokenIds: number[] = [];

  for (let tokenId = 0; tokenId < 4; tokenId++) {
    const token = playerTokens[tokenId.toString()] || playerTokens[tokenId];
    if (!token) continue;

    const move = calculateTokenMove(
      token,
      slot,
      uid,
      diceValue,
      allTokens,
      slotMap,
      settings
    );

    if (move.canMove) {
      legalTokenIds.push(token.id);
    }
  }

  return legalTokenIds;
}

/**
 * Check if a player has won (tokens in HOME >= tokensToWin, default 4)
 */
export function hasPlayerWon(
  uid: string,
  tokens: GameDocument['tokens'],
  tokensToWin: number = 4
): boolean {
  const playerTokens = tokens[uid];
  if (!playerTokens) return false;
  const homeCount = countTokensHome(uid, tokens);
  return homeCount >= Math.max(1, Math.min(4, tokensToWin));
}

/**
 * Count how many tokens have reached HOME for a player
 */
export function countTokensHome(uid: string, tokens: GameDocument['tokens']): number {
  const playerTokens = tokens[uid];
  if (!playerTokens) return 0;
  let count = 0;
  for (let i = 0; i < 4; i++) {
    const t = playerTokens[i.toString()] || playerTokens[i];
    if (t && (t.zone === 'HOME' || t.progress === FINAL_HOME_PROGRESS)) {
      count++;
    }
  }
  return count;
}

/**
 * Determines next player in turn order, skipping players who have already finished
 */
export function getNextPlayerUid(
  playerOrder: string[],
  currentPlayerUid: string,
  tokens: GameDocument['tokens'],
  tokensToWin: number = 4
): string {
  if (playerOrder.length === 0) return currentPlayerUid;
  const currentIdx = playerOrder.indexOf(currentPlayerUid);
  const total = playerOrder.length;

  for (let i = 1; i <= total; i++) {
    const nextIdx = (currentIdx + i) % total;
    const nextUid = playerOrder[nextIdx];
    if (!hasPlayerWon(nextUid, tokens, tokensToWin)) {
      return nextUid;
    }
  }
  return currentPlayerUid;
}

/**
 * Helper to compute projected landing destination and preview attributes for a token move
 */
export function getProjectedLandingInfo(
  token: { id: number; zone: TokenZone; progress: number },
  slot: PlayerSlot,
  uid: string,
  diceValue: number,
  allTokens: GameDocument['tokens'],
  slotMap: Record<string, PlayerSlot>,
  settings: RoomSettings
): {
  canMove: boolean;
  targetCoord: [number, number];
  isSafe: boolean;
  isCapture: boolean;
  isHome: boolean;
} | null {
  const move = calculateTokenMove(
    token,
    slot,
    uid,
    diceValue,
    allTokens,
    slotMap,
    settings
  );

  if (!move.canMove) return null;

  const targetCoord = getTokenGridCoordinates(
    slot,
    token.id,
    move.newZone,
    move.newProgress
  );

  let isSafe = false;
  if (move.newZone === 'TRACK') {
    const globalIdx = getGlobalTrackIndex(slot, move.newProgress);
    if (globalIdx !== null && isSafeTrackIndex(globalIdx)) {
      isSafe = true;
    }
  } else if (move.newZone === 'HOME_PATH' || move.newZone === 'HOME') {
    isSafe = true;
  }

  return {
    canMove: true,
    targetCoord,
    isSafe,
    isCapture: move.capturedTokens.length > 0,
    isHome: move.isHome,
  };
}

/**
 * Board Layout Coordinate Mapper for visual 15x15 Ludo Grid
 * Returns [row, col] on standard 15x15 Ludo board (0-indexed 0..14)
 */

// 52 Common Track Cells Coordinates [row, col] on 15x15 grid
// Clockwise starting from Red Start on Bottom Arm (row 13, col 6):
export const TRACK_GRID_COORDINATES: [number, number][] = [
  [13, 6], // 0: P1 Start (Red - Bottom Arm left lane) - SAFE
  [12, 6], // 1
  [11, 6], // 2
  [10, 6], // 3
  [9, 6],  // 4
  [8, 5],  // 5 (Turns Left into Left Arm bottom lane)
  [8, 4],  // 6
  [8, 3],  // 7
  [8, 2],  // 8: SAFE (Star 1 - Left Arm)
  [8, 1],  // 9
  [8, 0],  // 10
  [7, 0],  // 11 (Left Middle)
  [6, 0],  // 12
  [6, 1],  // 13: P2 Start (Green - Left Arm top lane) - SAFE
  [6, 2],  // 14
  [6, 3],  // 15
  [6, 4],  // 16
  [6, 5],  // 17
  [5, 6],  // 18 (Turns Up into Top Arm left lane)
  [4, 6],  // 19
  [3, 6],  // 20
  [2, 6],  // 21: SAFE (Star 2 - Top Arm)
  [1, 6],  // 22
  [0, 6],  // 23
  [0, 7],  // 24 (Top Middle)
  [0, 8],  // 25
  [1, 8],  // 26: P3 Start (Yellow - Top Arm right lane) - SAFE
  [2, 8],  // 27
  [3, 8],  // 28
  [4, 8],  // 29
  [5, 8],  // 30
  [6, 9],  // 31 (Turns Right into Right Arm top lane)
  [6, 10], // 32
  [6, 11], // 33
  [6, 12], // 34: SAFE (Star 3 - Right Arm)
  [6, 13], // 35
  [6, 14], // 36
  [7, 14], // 37 (Right Middle)
  [8, 14], // 38
  [8, 13], // 39: P4 Start (Blue - Right Arm bottom lane) - SAFE
  [8, 12], // 40
  [8, 11], // 41
  [8, 10], // 42
  [8, 9],  // 43
  [9, 8],  // 44 (Turns Down into Bottom Arm right lane)
  [10, 8], // 45
  [11, 8], // 46
  [12, 8], // 47: SAFE (Star 4 - Bottom Arm)
  [13, 8], // 48
  [14, 8], // 49
  [14, 7], // 50 (Bottom Middle)
  [14, 6], // 51
];

// Home Path 5 cells for each slot (progress 51..55)
export const HOME_PATHS_GRID_COORDINATES: Record<PlayerSlot, [number, number][]> = {
  P1: [ // Red (Bottom Arm col 7, rows 13..9 leading into center bottom)
    [13, 7], [12, 7], [11, 7], [10, 7], [9, 7]
  ],
  P2: [ // Green (Left Arm row 7, cols 1..5 leading into center left)
    [7, 1], [7, 2], [7, 3], [7, 4], [7, 5]
  ],
  P3: [ // Yellow (Top Arm col 7, rows 1..5 leading into center top)
    [1, 7], [2, 7], [3, 7], [4, 7], [5, 7]
  ],
  P4: [ // Blue (Right Arm row 7, cols 13..9 leading into center right)
    [7, 13], [7, 12], [7, 11], [7, 10], [7, 9]
  ]
};

// Final Home center triangles (row 7, col 7)
export const HOME_CENTER_COORDINATE: [number, number] = [7, 7];

// Yard Token positions [row, col] on 15x15 board
export const YARD_POSITIONS: Record<PlayerSlot, [number, number][]> = {
  P1: [ // Red Yard (Bottom-Left: rows 9..14, cols 0..5)
    [10.5, 1.5], [10.5, 3.5], [12.5, 1.5], [12.5, 3.5]
  ],
  P2: [ // Green Yard (Top-Left: rows 0..5, cols 0..5)
    [1.5, 1.5], [1.5, 3.5], [3.5, 1.5], [3.5, 3.5]
  ],
  P3: [ // Yellow Yard (Top-Right: rows 0..5, cols 9..14)
    [1.5, 10.5], [1.5, 12.5], [3.5, 10.5], [3.5, 12.5]
  ],
  P4: [ // Blue Yard (Bottom-Right: rows 9..14, cols 9..14)
    [10.5, 10.5], [10.5, 12.5], [12.5, 10.5], [12.5, 12.5]
  ]
};

/**
 * Get display row/col for a token on 15x15 board
 */
export function getTokenGridCoordinates(
  slot: PlayerSlot,
  tokenId: number,
  zone: TokenZone,
  progress: number
): [number, number] {
  if (zone === 'YARD' || progress === -1) {
    const yardSlots = YARD_POSITIONS[slot];
    return yardSlots[tokenId % 4] ?? [0, 0];
  }

  if (zone === 'HOME' || progress >= FINAL_HOME_PROGRESS) {
    return HOME_CENTER_COORDINATE;
  }

  if (zone === 'HOME_PATH' || progress >= HOME_PATH_START_PROGRESS) {
    const pathIdx = progress - HOME_PATH_START_PROGRESS; // 0..4
    const pathCoords = HOME_PATHS_GRID_COORDINATES[slot];
    return pathCoords[Math.min(pathIdx, 4)] ?? HOME_CENTER_COORDINATE;
  }

  // On shared track (progress 0..50)
  const globalIdx = getGlobalTrackIndex(slot, progress);
  if (globalIdx !== null && TRACK_GRID_COORDINATES[globalIdx]) {
    return TRACK_GRID_COORDINATES[globalIdx];
  }

  return [0, 0];
}

/**
 * Generate Initial Tokens for a Game
 */
export function createInitialTokens(playerUids: string[]): GameDocument['tokens'] {
  const tokens: GameDocument['tokens'] = {};

  for (const uid of playerUids) {
    tokens[uid] = {
      '0': { id: 0, zone: 'YARD', progress: -1 },
      '1': { id: 1, zone: 'YARD', progress: -1 },
      '2': { id: 2, zone: 'YARD', progress: -1 },
      '3': { id: 3, zone: 'YARD', progress: -1 },
    };
  }

  return tokens;
}
