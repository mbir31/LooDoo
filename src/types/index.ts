export type Language = 'bn' | 'en';

export type PlayerColor = 'red' | 'green' | 'yellow' | 'blue';

export type PlayerSlot = 'P1' | 'P2' | 'P3' | 'P4';

export type GameMode = 'CLASSIC' | 'RUSH' | 'SNAKE_LADDER' | 'PASS_AND_PLAY' | 'TEAM';

export type TeamId = 'TEAM_1' | 'TEAM_2';

export type TokenTheme = 'classic' | 'wood' | 'marble' | 'brass' | 'neon' | 'terracotta';

export type RoomStatus = 'OPEN' | 'READY' | 'PLAYING' | 'FINISHED' | 'IDLE' | 'ARCHIVED';

export type GameStatus =
  | 'WAITING_FOR_PLAYERS'
  | 'READY_CHECK'
  | 'STARTING'
  | 'AWAITING_ROLL'
  | 'DICE_ROLLED'
  | 'AWAITING_TOKEN_SELECTION'
  | 'MOVING_TOKEN'
  | 'RESOLVING_CAPTURE'
  | 'EXTRA_ROLL'
  | 'PLAYER_FINISHED'
  | 'GAME_OVER'
  | 'REMATCH';

export type TokenZone = 'YARD' | 'TRACK' | 'HOME_PATH' | 'HOME';

export interface TokenState {
  id: number; // 0, 1, 2, 3
  zone: TokenZone;
  progress: number; // -1 for YARD, 0..50 on shared track, 51..55 in home path, 56 for HOME
  slot: PlayerSlot;
}

export interface UserStats {
  wins: number;
  matchesPlayed: number;
  sixesRolled: number;
  capturesMade: number;
  winStreak?: number;
  longestStreak?: number;
  xp?: number;
  level?: number;
  trophies?: string[];
}

export interface UserProfile {
  uid: string;
  displayName: string;
  preferredLanguage: Language;
  avatar: string;
  tokenTheme?: TokenTheme;
  tokenSkin?: TokenTheme;
  activeRoomId?: string | null;
  createdAt: number;
  lastSeenAt: number;
  isAnonymous: boolean;
  email?: string | null;
  soundVolume?: number;
  musicEnabled?: boolean;
  autoMoveSingle?: boolean;
  stats?: UserStats;
}

export interface RoomPlayer {
  uid: string;
  playerId: string; // e.g. P1-482731
  slot: PlayerSlot;
  displayName: string;
  color: PlayerColor;
  customColorHex?: string;
  avatar: string;
  tokenTheme?: TokenTheme;
  teamId?: TeamId;
  ready: boolean;
  connected: boolean;
  status: 'active' | 'disconnected' | 'left';
  joinedAt: number;
  lastSeenAt: number;
  sixesRolled?: number;
  capturesMade?: number;
  /** Set by a live voice layer (if enabled) to render the speaking indicator. */
  isSpeaking?: boolean;
}

export interface RoomSettings {
  maxPlayers: 2 | 3 | 4;
  turnTimeoutSeconds: number;
  strictThreeSixRule: boolean; // Bangladeshi consecutive 3x 6s cancels turn
  allowBlockades: boolean;
  customNamesAllowed: boolean;
  gameMode?: GameMode;
  tokensToWin?: number; // 4 for CLASSIC, 2 for RUSH, 1 for SNAKE_LADDER
  autoMoveSingle?: boolean;
}

export interface RoomDocument {
  roomId: string;
  roomCode: string; // 6-digit code e.g. 482731
  adminUid: string;
  status: RoomStatus;
  maxPlayers: number;
  createdAt: number;
  updatedAt: number;
  currentGameId: string | null;
  lastGameId: string | null;
  settings: RoomSettings;
}

export interface PlayerTokens {
  [tokenKey: string]: {
    id: number;
    zone: TokenZone;
    progress: number;
  };
}

/** Per-player counters accumulated during a single match (authoritative, never randomised). */
export interface PlayerMatchStats {
  sixesRolled: number;
  capturesMade: number;
  tokensHome: number;
}

export interface GameDocument {
  gameId: string;
  roomId: string;
  gameMode?: GameMode;
  winningTeam?: TeamId | null;
  /** Real per-player match counters (sixes / captures / tokens home). */
  stats?: Record<string, PlayerMatchStats>;
  status: GameStatus;
  playerOrder: string[]; // array of uids in turn order
  currentPlayerUid: string;
  turnNumber: number;
  diceValue: number | null;
  diceRolled: boolean;
  consecutiveSixes: number;
  turnStartedAt: number;
  turnExpiresAt: number;
  winnerUid: string | null;
  rankings: {
    uid: string;
    rank: number;
    finishedAt: number;
  }[];
  tokens: {
    [uid: string]: {
      [tokenId: string]: {
        id: number;
        zone: TokenZone;
        progress: number;
      };
    };
  };
  version: number;
  startedAt: number;
  endedAt: number | null;
  lastAction: string;
  lastActionAt: number;
  lastCapturedToken?: {
    capturedUid: string;
    tokenId: number;
  } | null;
  turnMessage?: {
    en: string;
    bn: string;
    type: 'info' | 'penalty' | 'capture' | 'six' | 'home' | 'win';
  } | null;
  snakePositions?: Record<string, number>;
  snakeLastEvent?: {
    type: 'LADDER' | 'SNAKE' | 'NORMAL';
    from: number;
    to: number;
    uid: string;
  } | null;
}

export type GameEventType =
  | 'GAME_STARTED'
  | 'PLAYER_JOINED'
  | 'PLAYER_READY'
  | 'DICE_ROLLED'
  | 'TOKEN_MOVED'
  | 'TOKEN_CAPTURED'
  | 'EXTRA_TURN'
  | 'THREE_SIX_PENALTY'
  | 'TOKEN_HOME'
  | 'PLAYER_FINISHED'
  | 'PLAYER_DISCONNECTED'
  | 'PLAYER_RECONNECTED'
  | 'GAME_FINISHED'
  | 'REMATCH_STARTED'
  | 'TURN_TIMEOUT';

export interface GameEvent {
  id: string;
  gameId: string;
  type: GameEventType;
  uid: string;
  slot?: PlayerSlot;
  timestamp: number;
  payload?: any;
  messageEn?: string;
  messageBn?: string;
}

export interface ReactionEvent {
  id: string;
  uid: string;
  displayName: string;
  emoji: string;
  tauntId?: string;
  tauntTextBn?: string;
  tauntTextEn?: string;
  timestamp: number;
}

export interface GameHistoryRecord {
  gameId: string;
  roomId: string;
  roomCode: string;
  playedAt: number;
  durationSeconds: number;
  winnerUid: string;
  winnerName: string;
  winnerColor: PlayerColor;
  gameMode?: GameMode;
  sixesRolled?: number;
  capturesMade?: number;
  players: {
    uid: string;
    displayName: string;
    color: PlayerColor;
    rank?: number;
    tokensHome: number;
    sixesRolled?: number;
    capturesMade?: number;
  }[];
}
