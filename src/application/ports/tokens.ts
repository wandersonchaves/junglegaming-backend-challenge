// Bun does not emit decorator metadata, so Nest injects by explicit token.
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
