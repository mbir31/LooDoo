/**
 * Public surface of the LooDoo game engine.
 *
 * Layered architecture:
 *   UI  ->  reducer (authoritative transition)  ->  validation  ->  transport
 *
 * `engine.ts`   : pure geometry + move maths (no state transitions)
 * `reducer.ts`  : the only place a game document is advanced
 * `validation.ts`: shape + transition guards applied to every remote state
 * `ai.ts`       : move selection restricted to engine-legal moves
 * `snakeLadder.ts`: snakes/ladders board tables shared by every mode
 */

export * from './engine';
export * from './reducer';
export * from './validation';
export * from './ai';
export * from './snakeLadder';
